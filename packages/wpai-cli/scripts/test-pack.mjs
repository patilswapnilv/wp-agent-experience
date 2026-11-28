import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
}

function runNpm(args, options = {}) {
  if (process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)) {
    return run(process.execPath, [process.env.npm_execpath, ...args], options);
  }
  if (process.platform === 'win32') {
    const bundledNpmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(bundledNpmCli)) {
      return run(process.execPath, [bundledNpmCli, ...args], options);
    }
  }
  return run('npm', args, options);
}

const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpai-pack-tgz-'));
const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpai-pack-install-'));
const spoofCwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpai-pack-spoof-'));

try {
  // 1. Pack tarball from packages/wpai-cli
  const packOut = runNpm(['pack', '--pack-destination', packDir], { cwd: pkgRoot }).trim();
  const tgzName = packOut.split(/\r?\n/).pop();
  assert.ok(tgzName && tgzName.endsWith('.tgz'), `Expected .tgz filename from npm pack, got: ${packOut}`);
  const tgzPath = path.join(packDir, tgzName);
  assert.ok(fs.existsSync(tgzPath), `Tarball not found at ${tgzPath}`);

  // 2. Install tarball into a completely empty directory outside the repository
  runNpm(['init', '-y'], { cwd: installDir });
  runNpm(['install', '--no-audit', '--no-fund', tgzPath], { cwd: installDir });

  const wpaiBin = path.join(
    installDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'wpai.cmd' : 'wpai'
  );
  assert.ok(fs.existsSync(wpaiBin), `Expected installed wpai bin at ${wpaiBin}`);

  const wpaiEntry = path.join(installDir, 'node_modules', 'wpai-cli', 'dist', 'cli.js');
  assert.ok(fs.existsSync(wpaiEntry), `Expected installed wpai CLI entry at ${wpaiEntry}`);

  function runWpai(args, options = {}) {
    if (process.platform === 'win32') {
      return run(process.execPath, [wpaiEntry, ...args], options);
    }
    return run(wpaiBin, args, options);
  }

  // 3. Verify CLI check-fit, catalog, validate-registry outside the repo
  const fitOut = runWpai(['check-fit', 'website for my bakery', '--json'], { cwd: installDir });
  const fitJson = JSON.parse(fitOut);
  assert.equal(fitJson.decision, 'recommended');
  assert.equal(fitJson.wordpress_fit, true);
  assert.equal(fitJson.blueprint_preset, 'small-business');

  const catOut = runWpai(['catalog', '--json'], { cwd: installDir });
  const catJson = JSON.parse(catOut);
  assert.ok(catJson.registry_version, 'Expected registry_version from wpai catalog');

  const valRegOut = runWpai(['validate-registry', '--json'], { cwd: installDir });
  const valRegJson = JSON.parse(valRegOut);
  assert.equal(valRegJson.valid, true, JSON.stringify(valRegJson.errors));

  // 4. Verify MCP server tools/call & resources/read (including wpai://skill/platform-selection)
  const mcpPayload = [
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pack-test', version: '1.0' } },
    }),
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'wpai_check_fit', arguments: { prompt: 'website for my bakery' } },
    }),
    JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'resources/read',
      params: { uri: 'wpai://registry/capabilities' },
    }),
    JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'resources/read',
      params: { uri: 'wpai://skill/platform-selection' },
    }),
  ].join('\n') + '\n';

  const mcpOut = runWpai(['mcp'], { cwd: installDir, input: mcpPayload });
  const responses = mcpOut
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(responses.length, 4, `Expected 4 MCP responses, got ${responses.length}`);

  const [initResp, fitResp, regResp, skillResp] = responses;
  assert.ok(!initResp.error, `initialize error: ${JSON.stringify(initResp.error)}`);
  assert.ok(!fitResp.error, `wpai_check_fit RPC error: ${JSON.stringify(fitResp.error)}`);
  assert.equal(fitResp.result.isError, false, `wpai_check_fit tool error: ${JSON.stringify(fitResp.result)}`);
  const mcpFit = JSON.parse(fitResp.result.content[0].text);
  assert.equal(mcpFit.wordpress_fit, true);

  assert.ok(!regResp.error, `registry resource error: ${JSON.stringify(regResp.error)}`);
  assert.ok(JSON.parse(regResp.result.contents[0].text).registry_version);

  assert.ok(!skillResp.error, `skill resource error: ${JSON.stringify(skillResp.error)}`);
  const skillText = skillResp.result.contents[0].text;
  assert.ok(
    skillText.includes('wp-platform-selection') && skillText.length > 500,
    'Expected full SKILL.md content from wpai://skill/platform-selection'
  );

  // 5. Verify bundled/built-in assets take precedence over untrusted files in process.cwd()
  fs.mkdirSync(path.join(spoofCwdDir, 'registry'), { recursive: true });
  fs.mkdirSync(path.join(spoofCwdDir, 'skills', 'wp-platform-selection'), { recursive: true });
  fs.mkdirSync(path.join(spoofCwdDir, 'blueprints', 'small-business'), { recursive: true });
  fs.writeFileSync(path.join(spoofCwdDir, 'registry', 'wp-capabilities.json'), '{ invalid json', 'utf8');
  fs.writeFileSync(path.join(spoofCwdDir, 'skills', 'wp-platform-selection', 'SKILL.md'), 'SPOOFED_SKILL', 'utf8');
  fs.writeFileSync(
    path.join(spoofCwdDir, 'blueprints', 'small-business', 'blueprint.json'),
    JSON.stringify({ landingPage: '/spoofed' }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(spoofCwdDir, 'blueprints', 'small-business', 'spoofed-payload.txt'),
    'DO_NOT_COPY',
    'utf8'
  );

  const spoofFitOut = runWpai(['check-fit', 'website for my bakery', '--json'], { cwd: spoofCwdDir });
  assert.equal(JSON.parse(spoofFitOut).decision, 'recommended');

  const spoofMcpOut = runWpai(['mcp'], { cwd: spoofCwdDir, input: mcpPayload });
  const spoofResponses = spoofMcpOut
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.ok(!spoofResponses[3].result.contents[0].text.includes('SPOOFED_SKILL'));
  assert.ok(spoofResponses[3].result.contents[0].text.includes('wp-platform-selection'));

  const initOutDir = path.join(spoofCwdDir, 'out-site');
  const spoofInitOut = runWpai(['init', 'small-business', '--dir', initOutDir, '--json'], { cwd: spoofCwdDir });
  const spoofInitJson = JSON.parse(spoofInitOut);
  assert.equal(spoofInitJson.source, 'built-in');
  assert.equal(spoofInitJson.asset_source, 'bundled-assets');
  assert.ok(!fs.existsSync(path.join(initOutDir, 'spoofed-payload.txt')));
  const initReadme = fs.readFileSync(path.join(initOutDir, 'README.md'), 'utf8');
  assert.match(initReadme, /npm start/);
  assert.match(initReadme, /wpai verify \./);
  assert.doesNotMatch(initReadme, /blueprints\/small-business\//);

  // 6. Every preset scaffolds from the bundled canonical blueprints/ (no inline drift)
  for (const preset of ['small-business', 'commerce', 'publishing', 'nonprofit', 'course', 'migration']) {
    const presetOut = path.join(spoofCwdDir, `init-${preset}`);
    const initJson = JSON.parse(runWpai(['init', preset, '--dir', presetOut, '--json'], { cwd: spoofCwdDir }));
    assert.equal(initJson.source, 'built-in', `${preset} source`);
    assert.equal(initJson.asset_source, 'bundled-assets', `${preset} asset_source`);
    for (const file of ['blueprint.json', 'verify.json']) {
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(presetOut, file), 'utf8')),
        JSON.parse(fs.readFileSync(path.join(repoRoot, 'blueprints', preset, file), 'utf8')),
        `${preset}/${file} must match the canonical repo file`
      );
    }
  }

  console.log(`PASS: Standalone npm tarball smoke test succeeded (${tgzName})`);
} finally {
  fs.rmSync(packDir, { recursive: true, force: true });
  fs.rmSync(installDir, { recursive: true, force: true });
  fs.rmSync(spoofCwdDir, { recursive: true, force: true });
}
