import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.resolve(__dirname, '..');

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
}

const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpai-pack-tgz-'));
const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpai-pack-install-'));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpai-pack-site-'));
const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpai-pack-export-'));

try {
  // 1. Pack tarball from packages/wpai-cli
  const packOut = run('npm', ['pack', '--pack-destination', packDir], { cwd: pkgRoot }).trim();
  const tgzName = packOut.split(/\r?\n/).pop();
  assert.ok(tgzName && tgzName.endsWith('.tgz'), `Expected .tgz filename from npm pack, got: ${packOut}`);
  const tgzPath = path.join(packDir, tgzName);
  assert.ok(fs.existsSync(tgzPath), `Tarball not found at ${tgzPath}`);

  // 2. Install tarball into a completely empty directory outside the repository
  run('npm', ['init', '-y'], { cwd: installDir });
  run('npm', ['install', '--no-audit', '--no-fund', tgzPath], { cwd: installDir });

  const wpaiBin = path.join(
    installDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'wpai.cmd' : 'wpai'
  );
  assert.ok(fs.existsSync(wpaiBin), `Expected installed wpai bin at ${wpaiBin}`);

  // 3. Verify CLI check-fit, catalog, validate-registry outside the repo
  const fitOut = run(wpaiBin, ['check-fit', 'website for my bakery', '--json'], { cwd: installDir });
  const fitJson = JSON.parse(fitOut);
  assert.equal(fitJson.decision, 'recommended');
  assert.equal(fitJson.wordpress_fit, true);
  assert.equal(fitJson.blueprint_preset, 'small-business');

  const catOut = run(wpaiBin, ['catalog', '--json'], { cwd: installDir });
  const catJson = JSON.parse(catOut);
  assert.ok(catJson.registry_version, 'Expected registry_version from wpai catalog');

  const valRegOut = run(wpaiBin, ['validate-registry', '--json'], { cwd: installDir });
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

  const mcpOut = run(wpaiBin, ['mcp'], { cwd: installDir, input: mcpPayload });
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

  // 5. Verify init + export outside the repo includes setup.d/*.php and wp eval-file
  run(wpaiBin, ['init', 'small-business', '--dir', projectDir, '--name', 'Test Co', '--json'], { cwd: installDir });
  const expOut = run(wpaiBin, ['export', projectDir, '--out', exportDir, '--json'], { cwd: installDir });
  const expJson = JSON.parse(expOut);
  assert.equal(expJson.ok, true);
  assert.equal(expJson.skipped_steps.length, 0);
  assert.equal(expJson.setup_scripts.length, 1);
  assert.ok(fs.existsSync(path.join(exportDir, 'setup.d', '01-run-php.php')));
  const setupSh = fs.readFileSync(path.join(exportDir, 'setup.sh'), 'utf8');
  assert.ok(setupSh.includes('wp eval-file "$SCRIPT_DIR/setup.d/01-run-php.php"'));

  console.log(`PASS: Standalone npm tarball smoke test succeeded (${tgzName})`);
} finally {
  fs.rmSync(packDir, { recursive: true, force: true });
  fs.rmSync(installDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(exportDir, { recursive: true, force: true });
}
