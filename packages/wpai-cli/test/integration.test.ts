import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PRESET_NAMES, type VerifyReport } from '../src/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliEntry = path.resolve(__dirname, '../../dist/cli.js');

describe('wpai live WordPress Playground integration smoke test', () => {
  it('runs wpai init small-business -> wpai validate -> wpai verify against real WordPress Playground', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpai-smoke-'));
    try {
      // 1. Init small-business preset
      const initOut = execFileSync(
        process.execPath,
        [cliEntry, 'init', 'small-business', '--dir', tmpDir, '--name', 'Sunny Bakery', '--json'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const initJson = JSON.parse(initOut) as { ok: boolean; preset: string; name: string; source: string };
      assert.equal(initJson.ok, true);
      assert.equal(initJson.preset, 'small-business');
      assert.equal(initJson.name, 'Sunny Bakery');
      assert.equal(initJson.source, 'built-in');

      // 2. Validate generated blueprint
      const bpPath = path.join(tmpDir, 'blueprint.json');
      const valOut = execFileSync(
        process.execPath,
        [cliEntry, 'validate', bpPath, '--json'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const valJson = JSON.parse(valOut) as { valid: boolean; errors: unknown[] };
      assert.equal(valJson.valid, true, JSON.stringify(valJson.errors));

      // 3. Verify against REAL WordPress Playground
      const verifyOut = execFileSync(
        process.execPath,
        [cliEntry, 'verify', tmpDir, '--timeout', '90000', '--json'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const report = JSON.parse(verifyOut) as VerifyReport;

      assert.equal(report.ok, true, JSON.stringify(report, null, 2));
      assert.equal(report.wordpress_loaded, true);
      assert.equal(report.blogname, 'Sunny Bakery');
      assert.equal(report.abilities_api, true, 'Expected WP 6.9+ Abilities API (WP_Ability) to be available');
      assert.equal(report.rest_api.types_status, 200);
      assert.ok(report.counts.pages >= 4, `Expected >=4 published pages, got ${report.counts.pages}`);
      assert.ok(
        report.checks.some((c) => c.name === 'required_ability:wpai/get-business-info' && c.passed),
        'Expected required_ability:wpai/get-business-info check to pass'
      );
      assert.ok(
        report.checks.some((c) => c.name === 'required_mu_plugin:wpai-business.php' && c.passed),
        'Expected required_mu_plugin:wpai-business.php check to pass'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  for (const preset of PRESET_NAMES) {
    it(`verifies repo blueprint "${preset}" end-to-end in WordPress Playground`, () => {
      const bpDir = path.resolve(__dirname, '../../../../blueprints', preset);
      const verifyOut = execFileSync(
        process.execPath,
        [cliEntry, 'verify', bpDir, '--timeout', '90000', '--json'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const report = JSON.parse(verifyOut) as VerifyReport;
      assert.equal(report.ok, true, JSON.stringify(report, null, 2));
      assert.equal(report.wordpress_loaded, true);
      assert.equal(report.abilities_api, true);
      assert.equal(report.rest_api.types_status, 200);
      assert.equal(report.php_last_error, null);
      if (preset === 'commerce') {
        assert.ok(report.checks.some((c) => c.name === 'required_posts_min:wpai_product' && c.passed));
        assert.ok(report.checks.some((c) => c.name === 'required_ability:wpai/list-products' && c.passed));
        assert.ok(report.checks.some((c) => c.name === 'required_mu_plugin:wpai-store.php' && c.passed));
      }
      if (preset === 'publishing') {
        assert.ok(report.checks.some((c) => c.name === 'required_posts_min' && c.passed));
        assert.ok(report.checks.some((c) => c.name === 'required_ability:wpai/editorial-summary' && c.passed));
        assert.ok(report.checks.some((c) => c.name === 'required_mu_plugin:wpai-publishing.php' && c.passed));
      }
    });
  }

  it('fails verification when required_posts_min (map, scalar, or malformed), required_abilities, or required_mu_plugins are unmet', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpai-verify-fail-'));
    try {
      const commerceDir = path.resolve(__dirname, '../../../../blueprints/commerce');
      const strictChecksPath = path.join(tmpDir, 'strict-verify.json');
      fs.writeFileSync(
        strictChecksPath,
        JSON.stringify({
          required_posts_min: { wpai_product: 99, post: 50, bad_entry: 'not-a-number' },
          required_abilities: ['wpai/get-business-info'],
          required_mu_plugins: ['wpai-business.php'],
        }),
        'utf8'
      );

      const res = spawnSync(
        process.execPath,
        [cliEntry, 'verify', commerceDir, '--checks', strictChecksPath, '--timeout', '90000', '--json'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      assert.equal(res.status, 1, `Expected exit status 1 when minimums/requirements are unmet, got ${res.status}`);
      const report = JSON.parse(res.stdout) as VerifyReport;
      assert.equal(report.ok, false);
      const byName = new Map(report.checks.map((c) => [c.name, c]));
      assert.equal(byName.get('required_posts_min:wpai_product')?.passed, false);
      assert.equal(byName.get('required_posts_min:post')?.passed, false);
      assert.equal(byName.get('required_posts_min:bad_entry')?.passed, false);
      assert.equal(byName.get('required_ability:wpai/get-business-info')?.passed, false);
      assert.equal(byName.get('required_mu_plugin:wpai-business.php')?.passed, false);

      // Scalar numeric required_posts_min (used by publishing) must also fail when unmet
      const publishingDir = path.resolve(__dirname, '../../../../blueprints/publishing');
      const scalarChecksPath = path.join(tmpDir, 'scalar-verify.json');
      fs.writeFileSync(scalarChecksPath, JSON.stringify({ required_posts_min: 99 }), 'utf8');
      const scalarRes = spawnSync(
        process.execPath,
        [cliEntry, 'verify', publishingDir, '--checks', scalarChecksPath, '--timeout', '90000', '--json'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      assert.equal(scalarRes.status, 1);
      const scalarReport = JSON.parse(scalarRes.stdout) as VerifyReport;
      assert.equal(scalarReport.ok, false);
      const scalarByName = new Map(scalarReport.checks.map((c) => [c.name, c]));
      assert.equal(scalarByName.get('required_posts_min')?.passed, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

