import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type ExportResult,
  handleMcpRequest,
  type MaterializedState,
  PRESET_NAMES,
  type VerifyReport,
} from '../src/index.js';

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

  it('materializes runPHP presets into content.wxr + wpai-state.json + MANIFEST.sha256 via CLI and MCP without --allow-partial', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpai-stage2-int-'));
    try {
      // 1. CLI Stage 2 export on small-business (5 pages + 1 post + static front page + posts page)
      const sbSite = path.join(tmpDir, 'sb-site');
      const sbOut = path.join(tmpDir, 'sb-dist');
      execFileSync(
        process.execPath,
        [cliEntry, 'init', 'small-business', '--dir', sbSite, '--name', 'Test Co', '--json'],
        { encoding: 'utf8' }
      );
      const sbExpRaw = execFileSync(
        process.execPath,
        [cliEntry, 'export', sbSite, '--out', sbOut, '--timeout', '90000', '--json'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const sbExp = JSON.parse(sbExpRaw) as ExportResult;
      assert.equal(sbExp.ok, true, JSON.stringify(sbExp.skipped_steps));
      assert.equal(sbExp.complete, true);
      assert.equal(sbExp.mode, 'materialized');
      assert.deepEqual(sbExp.wp_content_files, [path.join('wp-content', 'mu-plugins', 'wpai-business.php')]);
      assert.equal(sbExp.materialized?.page_on_front_slug, 'home');
      assert.equal(sbExp.materialized?.page_for_posts_slug, 'updates');

      const sbWxr = fs.readFileSync(path.join(sbOut, 'content.wxr'), 'utf8');
      for (const slug of ['home', 'services', 'about', 'contact', 'updates', 'autumn-pastry-menu']) {
        assert.match(sbWxr, new RegExp(`<wp:post_name><!\\[CDATA\\[${slug}\\]\\]></wp:post_name>|<wp:post_name>${slug}</wp:post_name>`));
      }
      assert.doesNotMatch(sbWxr, /sample-page|hello-world/, 'untouched default install boilerplate should be stripped');

      const shaRes = spawnSync('sha256sum', ['-c', 'MANIFEST.sha256'], { cwd: sbOut, encoding: 'utf8' });
      assert.equal(shaRes.status, 0, shaRes.stderr || shaRes.stdout);

      // Dry-run of materialized setup.sh must never invoke wp
      const emptyPathEnv = { ...process.env, PATH: '/usr/bin:/bin' };
      const dryRes = spawnSync('bash', [path.join(sbOut, 'setup.sh'), '--dry-run'], {
        cwd: sbOut,
        env: emptyPathEnv,
        encoding: 'utf8',
      });
      assert.equal(dryRes.status, 0, dryRes.stderr);
      assert.match(dryRes.stdout, /content\.wxr/);
      assert.match(dryRes.stdout, /Dry run complete; nothing was changed/);

      // 2. MCP wpai_export on publishing (categories + 4 articles + 3 non-admin editorial users)
      const pubDir = path.resolve(__dirname, '../../../../blueprints/publishing');
      const pubOut = path.join(tmpDir, 'pub-dist');
      const mcpResp = (await handleMcpRequest({
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: { name: 'wpai_export', arguments: { target: pubDir, out_dir: pubOut } },
      })) as { result: { isError: boolean; content: Array<{ text: string }> } };
      assert.equal(mcpResp.result.isError, false, mcpResp.result.content[0]?.text);
      const pubExp = JSON.parse(mcpResp.result.content[0]!.text) as ExportResult;
      assert.equal(pubExp.ok, true);
      assert.equal(pubExp.complete, true);
      assert.equal(pubExp.mode, 'materialized');
      assert.equal(pubExp.materialized?.users_count, 3);

      const pubState = JSON.parse(fs.readFileSync(path.join(pubOut, 'wpai-state.json'), 'utf8')) as MaterializedState;
      const logins = pubState.users.map((u) => `${u.user_login}:${u.role}`).sort();
      assert.deepEqual(logins, ['david_author:author', 'maya_editor:editor', 'priya_contributor:contributor']);
      assert.doesNotMatch(JSON.stringify(pubState), /user_pass|administrator/);

      // 3. Custom non-core DB tables created by runPHP fail safe unless --allow-partial is passed
      const customTblDir = path.join(tmpDir, 'custom-tbl-site');
      const customTblOut = path.join(tmpDir, 'custom-tbl-dist');
      fs.mkdirSync(customTblDir, { recursive: true });
      fs.writeFileSync(
        path.join(customTblDir, 'blueprint.json'),
        JSON.stringify({
          $schema: 'https://playground.wordpress.net/blueprint-schema.json',
          steps: [
            {
              step: 'runPHP',
              code: "<?php require_once '/wordpress/wp-load.php'; global $wpdb; $wpdb->query(\"CREATE TABLE {$wpdb->prefix}custom_ledger (id INT PRIMARY KEY)\");",
            },
          ],
        }),
        'utf8'
      );
      const tblFail = spawnSync(
        process.execPath,
        [cliEntry, 'export', customTblDir, '--out', customTblOut, '--json'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      assert.equal(tblFail.status, 1);
      const tblFailJson = JSON.parse(tblFail.stdout) as ExportResult;
      assert.equal(tblFailJson.ok, false);
      assert.ok(tblFailJson.skipped_steps.some((s) => s.location === 'database' && /custom_ledger/.test(s.reason)));
      assert.equal(fs.existsSync(customTblOut), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});


