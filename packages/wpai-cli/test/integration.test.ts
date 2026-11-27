import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
      const initJson = JSON.parse(initOut) as { ok: boolean; preset: string; name: string };
      assert.equal(initJson.ok, true);
      assert.equal(initJson.preset, 'small-business');
      assert.equal(initJson.name, 'Sunny Bakery');

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
        report.mu_plugins.includes('wpai-business.php') ||
          report.mu_plugins.includes('wpai-business-essentials.php'),
        `Expected wpai business mu-plugin in mu_plugins: ${JSON.stringify(report.mu_plugins)}`
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
    });
  }
});

