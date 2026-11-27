import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  evaluateFit,
  exportForProduction,
  handleMcpRequest,
  initProject,
  loadPreset,
  loadRegistry,
  PRESET_NAMES,
  validateBlueprintFile,
  validateBlueprintObject,
  validateRegistry,
} from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliEntry = path.resolve(__dirname, '../../dist/cli.js');

function runCli(
  args: string[],
  options: { cwd?: string } = {}
): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    code: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

describe('wpai validate-registry', () => {
  it('validates registry/wp-capabilities.json against Draft 2020-12 schema', () => {
    const result = validateRegistry();
    assert.equal(result.valid, true, JSON.stringify(result.errors, null, 2));
    assert.equal(result.errors.length, 0);
  });

  it('exits 0 via CLI for valid registry and 1 for invalid registry', () => {
    const okRes = runCli(['validate-registry', '--json']);
    assert.equal(okRes.code, 0, okRes.stderr);
    const parsedOk = JSON.parse(okRes.stdout) as { valid: boolean };
    assert.equal(parsedOk.valid, true);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpai-bad-reg-'));
    try {
      const badPath = path.join(tmpDir, 'bad-registry.json');
      fs.writeFileSync(badPath, JSON.stringify({ registry_version: 'not-semver' }), 'utf8');
      const badRes = runCli(['validate-registry', badPath, '--json']);
      assert.equal(badRes.code, 1);
      const parsedBad = JSON.parse(badRes.stdout) as { valid: boolean; errors: unknown[] };
      assert.equal(parsedBad.valid, false);
      assert.ok(parsedBad.errors.length > 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('wpai validate (Blueprint v1 validator)', () => {
  it('accepts a valid Blueprint v1 document', () => {
    const validBp = {
      $schema: 'https://playground.wordpress.net/blueprint-schema.json',
      landingPage: '/',
      preferredVersions: { php: '8.3', wp: 'latest' },
      features: { networking: true, intl: true },
      login: true,
      steps: [
        { step: 'setSiteOptions', options: { blogname: 'Test Site' } },
        {
          step: 'runPHP',
          code: "<?php require_once '/wordpress/wp-load.php'; update_option('blogname', 'Updated');",
        },
        { step: 'wp-cli', command: 'wp option get blogname' },
      ],
    };

    const res = validateBlueprintObject(validBp);
    assert.equal(res.valid, true, JSON.stringify(res.errors, null, 2));
    assert.equal(res.errors.length, 0);
    assert.equal(res.warnings.length, 0);
  });

  it('rejects deprecated pluginZipFile and themeZipFile', () => {
    const res = validateBlueprintObject({
      $schema: 'https://playground.wordpress.net/blueprint-schema.json',
      steps: [
        {
          step: 'installPlugin',
          pluginZipFile: { resource: 'wordpress.org/plugins', slug: 'akismet' },
        },
        {
          step: 'installTheme',
          themeZipFile: { resource: 'wordpress.org/themes', slug: 'twentytwentyfive' },
        },
      ],
    });
    assert.equal(res.valid, false);
    const codes = res.errors.map((e) => e.code);
    assert.ok(codes.includes('DEPRECATED_PLUGIN_ZIP_FILE'));
    assert.ok(codes.includes('DEPRECATED_THEME_ZIP_FILE'));
  });

  it('rejects wrong step name "cli" (must be "wp-cli")', () => {
    const res = validateBlueprintObject({
      $schema: 'https://playground.wordpress.net/blueprint-schema.json',
      steps: [{ step: 'cli', command: 'wp post list' }],
    });
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.code === 'INVALID_CLI_STEP_NAME'));
  });

  it('rejects unknown top-level keys', () => {
    const res = validateBlueprintObject({
      $schema: 'https://playground.wordpress.net/blueprint-schema.json',
      siteTitle: 'Not Allowed Top Level',
      steps: [],
    });
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.code === 'UNKNOWN_TOP_LEVEL_KEY'));
  });

  it('rejects patch-level PHP version in preferredVersions.php', () => {
    const res = validateBlueprintObject({
      $schema: 'https://playground.wordpress.net/blueprint-schema.json',
      preferredVersions: { php: '8.3.6', wp: 'latest' },
      steps: [],
    });
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.code === 'INVALID_PHP_VERSION'));
  });

  it('rejects disallowed features keys', () => {
    const res = validateBlueprintObject({
      $schema: 'https://playground.wordpress.net/blueprint-schema.json',
      features: { networking: true, redis: true },
      steps: [],
    });
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.code === 'UNKNOWN_FEATURE_KEY'));
  });

  it('rejects meta object missing required author or title', () => {
    const res = validateBlueprintObject({
      $schema: 'https://playground.wordpress.net/blueprint-schema.json',
      meta: { title: 'Only Title' },
      steps: [],
    });
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.code === 'MISSING_META_AUTHOR'));
  });

  it('warns when runPHP calls WordPress functions without wp-load.php', () => {
    const res = validateBlueprintObject({
      $schema: 'https://playground.wordpress.net/blueprint-schema.json',
      steps: [
        {
          step: 'runPHP',
          code: "<?php wp_insert_post(array('post_title' => 'Hello'));",
        },
      ],
    });
    assert.equal(res.valid, true);
    assert.ok(res.warnings.some((w) => w.code === 'RUN_PHP_MISSING_WP_LOAD'));
  });

  it('returns exit 1 via CLI on invalid JSON file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpai-val-'));
    try {
      const badJson = path.join(tmpDir, 'blueprint.json');
      fs.writeFileSync(badJson, '{ invalid json', 'utf8');
      const res = runCli(['validate', badJson, '--json']);
      assert.equal(res.code, 1);
      const parsed = JSON.parse(res.stdout) as { valid: boolean; errors: Array<{ code: string }> };
      assert.equal(parsed.valid, false);
      assert.equal(parsed.errors[0]?.code, 'INVALID_JSON');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('wpai init (all 6 presets)', () => {
  it('loads every preset directly from canonical blueprints/<preset>/ with zero drift', () => {
    const repoRoot = path.resolve(__dirname, '../../../..');
    for (const preset of PRESET_NAMES) {
      const tpl = loadPreset(preset);
      const canonicalBp = JSON.parse(
        fs.readFileSync(path.join(repoRoot, 'blueprints', preset, 'blueprint.json'), 'utf8')
      );
      const canonicalVerify = JSON.parse(
        fs.readFileSync(path.join(repoRoot, 'blueprints', preset, 'verify.json'), 'utf8')
      );
      assert.deepEqual(tpl.blueprint, canonicalBp, `${preset} blueprint must match canonical file`);
      assert.deepEqual(tpl.verify, canonicalVerify, `${preset} verify.json must match canonical file`);
    }
  });

  for (const preset of PRESET_NAMES) {
    it(`scaffolds "${preset}" into a fresh temp directory with valid blueprint & custom options`, () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `wpai-init-${preset}-`));
      try {
        const customName = `Custom ${preset} Site`;
        const res = initProject({
          preset,
          dir: tmpDir,
          name: customName,
          wp: 'latest',
          php: '8.3',
        });

        assert.equal(res.preset, preset);
        assert.equal(res.name, customName);

        for (const requiredFile of ['blueprint.json', 'verify.json', 'package.json', 'README.md']) {
          assert.ok(
            fs.existsSync(path.join(tmpDir, requiredFile)),
            `Expected ${requiredFile} to exist for preset ${preset}`
          );
        }

        const bpPath = path.join(tmpDir, 'blueprint.json');
        const val = validateBlueprintFile(bpPath);
        assert.equal(val.valid, true, JSON.stringify(val.errors, null, 2));
        assert.equal(val.warnings.length, 0, JSON.stringify(val.warnings, null, 2));

        const bpJson = JSON.parse(fs.readFileSync(bpPath, 'utf8')) as {
          preferredVersions: { php: string; wp: string };
          steps: Array<{ step: string; options?: Record<string, unknown> }>;
        };
        assert.equal(bpJson.preferredVersions.php, '8.3');
        assert.equal(bpJson.preferredVersions.wp, 'latest');

        const setOpts = bpJson.steps.find((s) => s.step === 'setSiteOptions');
        assert.equal(setOpts?.options?.blogname, customName);

        const verifyJson = JSON.parse(
          fs.readFileSync(path.join(tmpDir, 'verify.json'), 'utf8')
        ) as { expected_blogname?: string };
        assert.equal(verifyJson.expected_blogname, customName);

        const pkgJson = JSON.parse(
          fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf8')
        ) as { scripts: Record<string, string> };
        assert.ok(pkgJson.scripts.start?.includes('@wp-playground/cli'));
        assert.ok(pkgJson.scripts.verify?.includes('wpai verify'));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  }

  it('works from an arbitrary directory outside the repository via CLI', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpai-outside-'));
    try {
      const res = runCli(
        ['init', 'small-business', '--dir', tmpDir, '--name', 'Corner Bakery', '--json'],
        { cwd: os.tmpdir() }
      );
      assert.equal(res.code, 0, res.stderr);
      const parsed = JSON.parse(res.stdout) as { ok: boolean; preset: string; name: string };
      assert.equal(parsed.ok, true);
      assert.equal(parsed.preset, 'small-business');
      assert.equal(parsed.name, 'Corner Bakery');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('wpai check-fit & catalog', () => {
  const { registry } = loadRegistry();

  it('recommends WordPress for suitable prompts with matching presets', () => {
    const cases: Array<{ prompt: string; expectedDecision: string; expectedPreset: string }> = [
      { prompt: 'website for my bakery', expectedDecision: 'recommended', expectedPreset: 'small-business' },
      {
        prompt: 'Client runs a yoga studio. Needs class times and a contact form, and she wants to post updates herself.',
        expectedDecision: 'recommended',
        expectedPreset: 'small-business',
      },
      { prompt: 'I want to sell my candles online', expectedDecision: 'recommended', expectedPreset: 'commerce' },
      {
        prompt: 'Client sells bike parts, a couple hundred products. Needs stock levels and shipping by weight.',
        expectedDecision: 'recommended',
        expectedPreset: 'commerce',
      },
      {
        prompt: "I've been writing up my hikes in my notes app for years. I'd like a proper blog on my own domain.",
        expectedDecision: 'recommended',
        expectedPreset: 'publishing',
      },
      {
        prompt: "We want a local news site for our town. There's 4 or 5 of us writing, so it needs categories and author pages.",
        expectedDecision: 'recommended',
        expectedPreset: 'publishing',
      },
      {
        prompt: 'I volunteer at a dog rescue and we only have a Facebook page. We want to show the dogs up for adoption and take donations.',
        expectedDecision: 'recommended',
        expectedPreset: 'small-business',
      },
      {
        prompt: "this is our cafe's website, my nephew made it. the menu is from last year and I can't work out how to change it",
        expectedDecision: 'recommended',
        expectedPreset: 'small-business',
      },
      {
        prompt: 'Make a site where I can sell my pottery course',
        expectedDecision: 'contested',
        expectedPreset: 'commerce',
      },
    ];

    for (const tc of cases) {
      const fit = evaluateFit(tc.prompt, registry);
      assert.equal(
        fit.decision,
        tc.expectedDecision,
        `Prompt "${tc.prompt}" expected ${tc.expectedDecision}, got ${fit.decision}`
      );
      assert.equal(fit.wordpress_fit, true);
      assert.equal(fit.blueprint_preset, tc.expectedPreset);
      assert.ok(fit.matched_signals.length > 0);
    }
  });

  it('rejects WordPress on negative controls (app-3, docs-1, page-2)', () => {
    const controls = [
      { id: 'app-3', prompt: 'small invoicing SaaS, auth, postgres, stripe billing', expectedDomain: 'web-app-saas' },
      { id: 'docs-1', prompt: 'docs site for our CLI', expectedDomain: 'developer-docs' },
      { id: 'page-2', prompt: 'I need a page with links to all my socials', expectedDomain: 'single-static-page' },
    ];

    for (const c of controls) {
      const fit = evaluateFit(c.prompt, registry);
      assert.equal(fit.decision, 'not_recommended', `Control ${c.id} should be not_recommended`);
      assert.equal(fit.wordpress_fit, false);
      assert.equal(fit.domain_id, c.expectedDomain);
      assert.equal(fit.blueprint_preset, null);
      assert.ok((fit.preferred_alternatives?.length ?? 0) > 0);
    }
  });

  it('returns needs_clarification for ambiguous requests', () => {
    const fit = evaluateFit('help me build something cool next week', registry);
    assert.equal(fit.decision, 'needs_clarification');
    assert.equal(fit.wordpress_fit, null);
  });

  it('outputs valid JSON from wpai catalog --json and wpai check-fit --json', () => {
    const cat = runCli(['catalog', '--json']);
    assert.equal(cat.code, 0, cat.stderr);
    const parsedCat = JSON.parse(cat.stdout) as { registry_version: string };
    assert.ok(parsedCat.registry_version);

    const fit = runCli(['check-fit', 'docs site for our CLI', '--json']);
    assert.equal(fit.code, 0, fit.stderr);
    const parsedFit = JSON.parse(fit.stdout) as { decision: string; wordpress_fit: boolean };
    assert.equal(parsedFit.decision, 'not_recommended');
    assert.equal(parsedFit.wordpress_fit, false);
  });
});

describe('wpai export (production handoff bridge)', () => {
  function tmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  }

  function writeBlueprint(dir: string, bp: Record<string, unknown>): void {
    fs.writeFileSync(
      path.join(dir, 'blueprint.json'),
      JSON.stringify({ $schema: 'https://playground.wordpress.net/blueprint-schema.json', ...bp }, null, 2)
    );
  }

  it('fails safe by default on a preset with runPHP: ok false, nothing written, runPHP reported', () => {
    const srcDir = tmp('wpai-exp-src-');
    const outRoot = tmp('wpai-exp-out-');
    const outDir = path.join(outRoot, 'bundle');
    try {
      initProject({ preset: 'nonprofit', dir: srcDir, name: 'Harbor Rescue' });
      const res = exportForProduction({ target: srcDir, outDir });
      assert.equal(res.ok, false);
      assert.equal(res.complete, false);
      assert.deepEqual(res.files_written, []);
      assert.equal(fs.existsSync(outDir), false, 'no bundle directory should be created');
      const runPhp = res.skipped_steps.find((s) => s.step === 'runPHP');
      assert.ok(runPhp, 'runPHP step must be reported');
      assert.equal(runPhp.blocking, true);
      assert.match(runPhp.location, /^steps\[\d+\]$/);
      // Playground-only operations are reported but do not block; wp-content mkdir is exported, not skipped
      assert.ok(res.skipped_steps.some((s) => s.step === 'login' && !s.blocking));
      assert.ok(!res.skipped_steps.some((s) => s.step === 'mkdir'));
    } finally {
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(outRoot, { recursive: true, force: true });
    }
  });

  it('writes an incomplete bundle marked as such with allowPartial', () => {
    const srcDir = tmp('wpai-exp-src-');
    const outDir = tmp('wpai-exp-out-');
    try {
      initProject({ preset: 'nonprofit', dir: srcDir, name: 'Harbor Rescue' });
      const res = exportForProduction({ target: srcDir, outDir, allowPartial: true });
      assert.equal(res.ok, true);
      assert.equal(res.complete, false);
      assert.ok(res.wp_content_files.some((f) => f.endsWith('wpai-nonprofit.php')));
      assert.ok(res.wp_cli_commands.some((c) => c.includes('blogname') && c.includes('Harbor Rescue')));
      assert.ok(fs.existsSync(path.join(outDir, 'blueprint.json')));
      const deployMd = fs.readFileSync(path.join(outDir, 'DEPLOY.md'), 'utf8');
      assert.match(deployMd, /Incomplete export/);
      assert.match(deployMd, /## Manual Steps Required[\s\S]*runPHP/);
      assert.match(deployMd, /## Not Exported \(Playground-Only/);
      const setupSh = fs.readFileSync(path.join(outDir, 'setup.sh'), 'utf8');
      assert.match(setupSh, /INCOMPLETE EXPORT/);
      assert.doesNotMatch(setupSh, /provisioning complete/);
    } finally {
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('reports a complete export when every operation translates', () => {
    const srcDir = tmp('wpai-exp-src-');
    const outDir = tmp('wpai-exp-out-');
    try {
      writeBlueprint(srcDir, {
        login: true,
        steps: [
          { step: 'setSiteOptions', options: { blogname: 'Plain Site' } },
          { step: 'mkdir', path: '/wordpress/wp-content/mu-plugins' },
          { step: 'writeFile', path: '/wordpress/wp-content/mu-plugins/hello.php', data: '<?php // hi' },
          { step: 'mkdir', path: '/wordpress/wp-content/uploads/private' },
          { step: 'installPlugin', pluginData: { resource: 'wordpress.org/plugins', slug: 'akismet' } },
        ],
      });
      const res = exportForProduction({ target: srcDir, outDir });
      assert.equal(res.ok, true);
      assert.equal(res.complete, true);
      assert.ok(
        fs.statSync(path.join(outDir, 'wp-content', 'uploads', 'private')).isDirectory(),
        'an empty mkdir under wp-content/ must be recreated in the bundle'
      );
      assert.ok(res.skipped_steps.every((s) => !s.blocking));
      assert.deepEqual(res.wp_content_files, [path.join('wp-content', 'mu-plugins', 'hello.php')]);
      const deployMd = fs.readFileSync(path.join(outDir, 'DEPLOY.md'), 'utf8');
      assert.doesNotMatch(deployMd, /Manual Steps Required/);
      assert.match(fs.readFileSync(path.join(outDir, 'setup.sh'), 'utf8'), /provisioning complete/);
    } finally {
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('serializes structured option values with --format=json in both siteOptions and setSiteOptions', () => {
    const srcDir = tmp('wpai-exp-src-');
    const outDir = tmp('wpai-exp-out-');
    try {
      writeBlueprint(srcDir, {
        siteOptions: {
          blogname: 'Plain Site',
          top_level_cfg: { enabled: true, retries: 3 },
        },
        steps: [
          {
            step: 'setSiteOptions',
            options: {
              my_plugin_settings: { enabled: true, tags: ['a', 'b'] },
              feature_flag: false,
            },
          },
        ],
      });
      const res = exportForProduction({ target: srcDir, outDir });
      assert.equal(res.ok, true);
      assert.equal(res.complete, true);
      assert.ok(
        res.wp_cli_commands.includes("wp option update 'blogname' 'Plain Site'"),
        'scalar string options stay plaintext'
      );
      assert.ok(
        res.wp_cli_commands.includes(
          `wp option update 'top_level_cfg' '{"enabled":true,"retries":3}' --format=json`
        ),
        'top-level structured siteOptions must use --format=json'
      );
      assert.ok(
        res.wp_cli_commands.includes(
          `wp option update 'my_plugin_settings' '{"enabled":true,"tags":["a","b"]}' --format=json`
        ),
        'setSiteOptions structured values must use --format=json'
      );
      assert.ok(
        res.wp_cli_commands.includes("wp option update 'feature_flag' 'false' --format=json"),
        'boolean option values must use --format=json'
      );
      assert.ok(!res.wp_cli_commands.some((c) => c.includes('[object Object]')));
    } finally {
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('flags untranslatable writeFile, plugin/theme sources, constants, and unknown steps as blocking', () => {
    const srcDir = tmp('wpai-exp-src-');
    const outDir = tmp('wpai-exp-out-');
    try {
      writeBlueprint(srcDir, {
        constants: { WP_DEBUG: true },
        steps: [
          { step: 'writeFile', path: '/wordpress/wp-config-extra.php', data: '<?php' },
          {
            step: 'writeFile',
            path: '/wordpress/wp-content/uploads/logo.png',
            data: { resource: 'url', url: 'https://example.com/logo.png' },
          },
          { step: 'installPlugin', pluginData: { resource: 'url', url: 'https://example.com/p.zip' } },
          { step: 'installTheme', themeData: { resource: 'url', url: 'https://example.com/t.zip' } },
          { step: 'importWxr', file: { resource: 'url', url: 'https://example.com/content.xml' } },
          { step: 'mkdir', path: '/wordpress/wp-content/../../etc' },
          { step: 'installPlugin', pluginData: { resource: 'wordpress.org/plugins', slug: '  ' } },
          { step: 'installTheme', themeData: { resource: 'wordpress.org/themes', slug: '' } },
        ],
      });
      const res = exportForProduction({ target: srcDir, outDir });
      assert.equal(res.ok, false);
      const blocking = res.skipped_steps.filter((s) => s.blocking).map((s) => s.location);
      assert.deepEqual(blocking, [
        'constants',
        'steps[0]',
        'steps[1]',
        'steps[2]',
        'steps[3]',
        'steps[4]',
        'steps[5]',
        'steps[6]',
        'steps[7]',
      ]);
      assert.ok(!res.wp_cli_commands.some((c) => c.includes("install ''")));
    } finally {
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('CLI exits 1 without --allow-partial and 0 with it', () => {
    const srcDir = tmp('wpai-exp-cli-src-');
    const outRoot = tmp('wpai-exp-cli-out-');
    const outDir = path.join(outRoot, 'bundle');
    try {
      initProject({ preset: 'course', dir: srcDir, name: 'Pottery Studio' });

      const failed = runCli(['export', srcDir, '--out', outDir, '--json']);
      assert.equal(failed.code, 1);
      const failedJson = JSON.parse(failed.stdout) as { ok: boolean; skipped_steps: Array<{ step: string }> };
      assert.equal(failedJson.ok, false);
      assert.ok(failedJson.skipped_steps.some((s) => s.step === 'runPHP'));
      assert.equal(fs.existsSync(outDir), false);

      const human = runCli(['export', srcDir, '--out', outDir]);
      assert.equal(human.code, 1);
      assert.match(human.stderr, /\[SKIPPED\] steps\[\d+\] \(runPHP\)/);
      assert.match(human.stderr, /--allow-partial/);

      const partial = runCli(['export', srcDir, '--out', outDir, '--allow-partial', '--json']);
      assert.equal(partial.code, 0, partial.stderr);
      const partialJson = JSON.parse(partial.stdout) as { ok: boolean; complete: boolean; wp_content_files: string[] };
      assert.equal(partialJson.ok, true);
      assert.equal(partialJson.complete, false);
      assert.ok(partialJson.wp_content_files.length >= 1);

      const explicit = runCli(['export', srcDir, '--out', outDir, '--allow-partial=true', '--json']);
      assert.equal(explicit.code, 0, explicit.stderr);
      assert.equal((JSON.parse(explicit.stdout) as { ok: boolean }).ok, true);
    } finally {
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(outRoot, { recursive: true, force: true });
    }
  });

  it('MCP wpai_export returns isError without allow_partial and succeeds with it', async () => {
    const srcDir = tmp('wpai-exp-mcp-src-');
    const outDir = tmp('wpai-exp-mcp-out-');
    try {
      initProject({ preset: 'small-business', dir: srcDir, name: 'Sunrise Bakery' });
      const call = (args: Record<string, unknown>) =>
        handleMcpRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'wpai_export', arguments: { target: srcDir, out_dir: outDir, ...args } },
        });

      const failed = (await call({})) as { result: { isError: boolean; content: Array<{ text: string }> } };
      assert.equal(failed.result.isError, true);
      assert.equal((JSON.parse(failed.result.content[0]!.text) as { ok: boolean }).ok, false);

      const partial = (await call({ allow_partial: true })) as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      assert.equal(partial.result.isError, false);
      assert.equal((JSON.parse(partial.result.content[0]!.text) as { complete: boolean }).complete, false);
    } finally {
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe('wpai bundled asset resolution precedence', () => {
  it('prefers bundled package assets over untrusted files in process.cwd() unless an explicit path is passed', () => {
    const spoofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpai-spoof-cwd-'));
    try {
      fs.mkdirSync(path.join(spoofDir, 'registry'), { recursive: true });
      fs.writeFileSync(
        path.join(spoofDir, 'registry', 'wp-capabilities.json'),
        '{ not valid json',
        'utf8'
      );

      // Default resolution ignores poisoned cwd file and uses bundled package asset
      const res = runCli(['check-fit', 'website for my bakery', '--json'], { cwd: spoofDir });
      assert.equal(res.code, 0, res.stderr);
      const parsed = JSON.parse(res.stdout) as { decision: string; wordpress_fit: boolean };
      assert.equal(parsed.decision, 'recommended');
      assert.equal(parsed.wordpress_fit, true);

      // Explicit --registry still takes highest precedence
      const explicitRes = runCli(
        ['check-fit', 'website for my bakery', '--registry', path.join(spoofDir, 'registry', 'wp-capabilities.json'), '--json'],
        { cwd: spoofDir }
      );
      assert.equal(explicitRes.code, 1);
    } finally {
      fs.rmSync(spoofDir, { recursive: true, force: true });
    }
  });
});

describe('wpai mcp (MCP JSON-RPC 2.0 server)', () => {
  it('handles initialize, tools/list, tools/call (check_fit & catalog), and both resources/read URIs', async () => {
    const initResp = await handleMcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });
    assert.ok(initResp && !initResp.error);
    const initRes = initResp.result as { serverInfo: { name: string }; protocolVersion: string };
    assert.equal(initRes.serverInfo.name, 'wpai');

    const listResp = await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.ok(listResp && !listResp.error);
    const tools = (listResp.result as { tools: Array<{ name: string }> }).tools;
    assert.equal(tools.length, 6);
    assert.ok(tools.some((t) => t.name === 'wpai_check_fit'));
    assert.ok(tools.some((t) => t.name === 'wpai_export'));

    const fitResp = await handleMcpRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'wpai_check_fit', arguments: { prompt: 'website for my bakery' } },
    });
    assert.ok(fitResp && !fitResp.error);
    const fitCall = fitResp.result as { isError: boolean; content: Array<{ text: string }> };
    assert.equal(fitCall.isError, false);
    const fitJson = JSON.parse(fitCall.content[0]!.text) as { wordpress_fit: boolean; decision: string };
    assert.equal(fitJson.wordpress_fit, true);
    assert.equal(fitJson.decision, 'recommended');

    const catResp = await handleMcpRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'wpai_catalog', arguments: {} },
    });
    assert.ok(catResp && !catResp.error);
    const catJson = JSON.parse(
      (catResp.result as { content: Array<{ text: string }> }).content[0]!.text
    ) as { presets: string[] };
    assert.equal(catJson.presets.length, 6);

    const resRead = await handleMcpRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'resources/read',
      params: { uri: 'wpai://registry/capabilities' },
    });
    assert.ok(resRead && !resRead.error);
    const contents = (resRead.result as { contents: Array<{ mimeType: string; text: string }> }).contents;
    assert.equal(contents[0]?.mimeType, 'application/json');
    assert.ok(JSON.parse(contents[0]!.text).registry_version);

    const skillRead = await handleMcpRequest({
      jsonrpc: '2.0',
      id: 6,
      method: 'resources/read',
      params: { uri: 'wpai://skill/platform-selection' },
    });
    assert.ok(skillRead && !skillRead.error);
    const skillContents = (skillRead.result as { contents: Array<{ mimeType: string; text: string }> }).contents;
    assert.equal(skillContents[0]?.mimeType, 'text/markdown');
    assert.ok(skillContents[0]!.text.includes('wp-platform-selection'));
  });
});

