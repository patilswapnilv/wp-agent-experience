import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const cliEntry = path.join(repoRoot, 'packages', 'wpai-cli', 'dist', 'cli.js');
const probePath = path.join(repoRoot, 'packages', 'wpai-cli', 'assets', 'php', 'verify-probe.php');

const PRESETS = [
  'small-business',
  'commerce',
  'publishing',
  'nonprofit',
  'course',
  'migration',
];

const skipPlaygroundVerify = process.argv.includes('--skip-playground-verify');

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function httpGet(url, options = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, {
        redirect: options.redirect ?? 'follow',
        headers: { connection: 'close' },
      });
      const text = await resp.text();
      return { status: resp.status, text };
    } catch (err) {
      lastErr = err;
      await sleep(250);
    }
  }
  throw lastErr;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

async function waitFor(label, timeoutMs, fn) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const ok = await fn();
      if (ok) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms${lastErr ? `: ${lastErr.message ?? lastErr}` : ''}`);
}

function compareSemverMajorMinor(versionStr, minMajor, minMinor) {
  const m = /^(\d+)\.(\d+)/.exec(String(versionStr).trim());
  if (!m) return false;
  const maj = Number.parseInt(m[1], 10);
  const min = Number.parseInt(m[2], 10);
  return maj > minMajor || (maj === minMajor && min >= minMinor);
}

const runId = `${process.pid}-${Date.now().toString(36)}`;
const netName = `wpai-parity-net-${runId}`;
const dbContainer = `wpai-parity-db-${runId}`;
const wpContainer = `wpai-parity-wp-${runId}`;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wpai-parity-'));

const DB_NAME = 'wordpress';
const DB_USER = 'wp';
const DB_PASS = 'wp_parity_ephemeral';
const DB_ROOT_PASS = 'wp_root_parity_ephemeral';

function dockerExecRoot(script) {
  return run('docker', ['exec', wpContainer, 'bash', '-lc', script]);
}

function dockerExecWww(script) {
  return run('docker', ['exec', '-u', 'www-data', '-w', '/var/www/html', wpContainer, 'bash', '-lc', script]);
}

try {
  assert.ok(fs.existsSync(cliEntry), `Missing built CLI at ${cliEntry}. Run "npm run build" first.`);
  assert.ok(fs.existsSync(probePath), `Missing bundled verify-probe.php at ${probePath}. Run "npm run build" first.`);

  const hostPort = await findFreePort();
  const baseUrl = `http://127.0.0.1:${hostPort}`;

  console.log(`[Gate 3] Starting MariaDB 10.11 + WordPress (PHP 8.3 + Apache + WP-CLI) on ${baseUrl}...`);
  run('docker', ['network', 'create', netName]);

  run('docker', [
    'run',
    '-d',
    '--name',
    dbContainer,
    '--network',
    netName,
    '-e',
    `MARIADB_DATABASE=${DB_NAME}`,
    '-e',
    `MARIADB_USER=${DB_USER}`,
    '-e',
    `MARIADB_PASSWORD=${DB_PASS}`,
    '-e',
    `MARIADB_ROOT_PASSWORD=${DB_ROOT_PASS}`,
    'mariadb:10.11',
  ]);

  await waitFor('MariaDB 10.11 readiness', 90000, async () => {
    const res = spawnSync(
      'docker',
      ['exec', dbContainer, 'mariadb-admin', 'ping', '-h', '127.0.0.1', `-u${DB_USER}`, `-p${DB_PASS}`, '--silent'],
      { encoding: 'utf8' }
    );
    return res.status === 0;
  });

  run('docker', [
    'run',
    '-d',
    '--name',
    wpContainer,
    '--network',
    netName,
    '-p',
    `127.0.0.1:${hostPort}:80`,
    '-e',
    `WORDPRESS_DB_HOST=${dbContainer}:3306`,
    '-e',
    `WORDPRESS_DB_NAME=${DB_NAME}`,
    '-e',
    `WORDPRESS_DB_USER=${DB_USER}`,
    '-e',
    `WORDPRESS_DB_PASSWORD=${DB_PASS}`,
    '-e',
    'WP_CLI_CONFIG_PATH=/etc/wp-cli/config.yml',
    '-e',
    'WP_CLI_CACHE_DIR=/tmp/wp-cli-cache',
    'wordpress:php8.3-apache',
  ]);

  await waitFor('WordPress Apache container HTTP readiness', 90000, async () => {
    const checkCfg = spawnSync('docker', ['exec', wpContainer, 'test', '-f', '/var/www/html/wp-config.php']);
    if (checkCfg.status !== 0) return false;
    const resp = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    return resp.status === 200 || resp.status === 302;
  });

  console.log('[Gate 3] Installing default-mysql-client and WP-CLI inside WordPress container...');
  dockerExecRoot([
    'set -euo pipefail',
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -qq',
    'apt-get install -y -qq --no-install-recommends default-mysql-client less ca-certificates curl >/dev/null',
    'curl -fsSL https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar -o /usr/local/bin/wp',
    'chmod 0755 /usr/local/bin/wp',
    'mkdir -p /etc/wp-cli /tmp/wp-cli-cache /tmp/verify',
    "printf 'apache_modules:\\n  - mod_rewrite\\n' > /etc/wp-cli/config.yml",
    'chown -R www-data:www-data /var/www/html /tmp/wp-cli-cache /tmp/verify',
  ].join(' && '));

  run('docker', ['cp', probePath, `${wpContainer}:/tmp/verify/verify-probe.php`]);
  dockerExecRoot('chown www-data:www-data /tmp/verify/verify-probe.php');

  // Ensure WordPress core inside container is >= 6.9 so native Abilities API (`WP_Ability`) is present
  dockerExecWww(
    `wp core install --url='${baseUrl}' --title='Bootstrap' --admin_user='admin' --admin_password='bootstrap_pass_only' --admin_email='admin@example.com' --skip-email`
  );
  let wpVer = dockerExecWww('wp core version').trim();
  if (!compareSemverMajorMinor(wpVer, 6, 9)) {
    console.log(`[Gate 3] Container WordPress is ${wpVer} (< 6.9); updating WordPress core...`);
    dockerExecWww('wp core update --yes');
    wpVer = dockerExecWww('wp core version').trim();
    if (!compareSemverMajorMinor(wpVer, 6, 9)) {
      dockerExecWww('wp core update --version=nightly --yes');
      wpVer = dockerExecWww('wp core version').trim();
    }
  }
  console.log(`[Gate 3] Container running WordPress ${wpVer} with MariaDB 10.11 + Apache + WP-CLI.`);

  for (const preset of PRESETS) {
    const siteName = `Parity ${preset} Site`;
    const siteDir = path.join(tmpRoot, `site-${preset}`);
    const distDir = path.join(tmpRoot, `dist-${preset}`);

    console.log(`\n[Gate 3] === Verifying preset "${preset}" (${siteName}) ===`);

    // a. Scaffold preset
    const initJson = JSON.parse(
      run(process.execPath, [cliEntry, 'init', preset, '--dir', siteDir, '--name', siteName, '--json'])
    );
    assert.equal(initJson.ok, true, `${preset}: wpai init failed`);

    // b. Gate 1: Verify in WordPress Playground WASM (unless skipped by CLI flag)
    if (!skipPlaygroundVerify) {
      const pgVerify = JSON.parse(
        run(process.execPath, [cliEntry, 'verify', siteDir, '--timeout', '90000', '--json'])
      );
      assert.equal(pgVerify.ok, true, `${preset}: Playground verify failed: ${JSON.stringify(pgVerify.checks)}`);
    }

    // c. Stage 2 Materialized Export (no --allow-partial needed!)
    const expJson = JSON.parse(
      run(process.execPath, [cliEntry, 'export', siteDir, '--out', distDir, '--timeout', '90000', '--json'])
    );
    assert.equal(expJson.ok, true, `${preset}: wpai export failed: ${JSON.stringify(expJson.skipped_steps)}`);
    assert.equal(expJson.complete, true, `${preset}: expected complete=true, got skipped=${JSON.stringify(expJson.skipped_steps)}`);
    assert.equal(expJson.mode, 'materialized', `${preset}: expected materialized export mode`);
    assert.ok(fs.existsSync(path.join(distDir, 'content.wxr')), `${preset}: missing content.wxr`);
    assert.ok(fs.existsSync(path.join(distDir, 'wpai-state.json')), `${preset}: missing wpai-state.json`);
    assert.ok(fs.existsSync(path.join(distDir, 'MANIFEST.sha256')), `${preset}: missing MANIFEST.sha256`);

    // f. Verify MANIFEST.sha256 on host before copying
    run('sha256sum', ['-c', 'MANIFEST.sha256'], { cwd: distDir });

    const stateJson = JSON.parse(fs.readFileSync(path.join(distDir, 'wpai-state.json'), 'utf8'));

    // d. Reset fresh MariaDB WordPress DB and clean wp-content/ so nothing leaks across presets
    dockerExecWww([
      'set -euo pipefail',
      'wp db reset --yes >/dev/null',
      'rm -rf /var/www/html/wp-content/mu-plugins /var/www/html/wp-content/uploads /var/www/html/.htaccess',
      "find /var/www/html/wp-content/plugins -mindepth 1 -maxdepth 1 ! -name 'akismet' ! -name 'hello.php' ! -name 'index.php' -exec rm -rf {} +",
      "find /var/www/html/wp-content/themes -mindepth 1 -maxdepth 1 ! -name 'twentytwenty*' ! -name 'index.php' -exec rm -rf {} +",
      `wp core install --url='${baseUrl}' --title='Fresh Target' --admin_user='admin' --admin_password='parity_admin_password_only' --admin_email='admin@example.com' --skip-email >/dev/null`,
    ].join(' && '));

    // e. Copy bundle and verify.json into container, then copy wp-content/ into /var/www/html/wp-content/
    dockerExecRoot('rm -rf /tmp/dist /tmp/verify/verify.json && mkdir -p /tmp/dist');
    run('docker', ['cp', `${distDir}/.`, `${wpContainer}:/tmp/dist`]);
    run('docker', ['cp', path.join(siteDir, 'verify.json'), `${wpContainer}:/tmp/verify/verify.json`]);
    dockerExecRoot([
      'set -euo pipefail',
      'chown -R www-data:www-data /tmp/dist /tmp/verify/verify.json',
      '(cd /tmp/dist && sha256sum -c MANIFEST.sha256 >/dev/null)',
      'if [ -d /tmp/dist/wp-content ]; then cp -R /tmp/dist/wp-content/. /var/www/html/wp-content/; fi',
      'chown -R www-data:www-data /var/www/html/wp-content',
    ].join(' && '));

    // g. Preview with --dry-run, then apply setup.sh --yes inside WordPress container as www-data
    const dryOut = dockerExecWww('/tmp/dist/setup.sh --dry-run');
    assert.match(dryOut, /Dry run complete; nothing was changed/);

    const applyOut1 = dockerExecWww('/tmp/dist/setup.sh --yes');
    assert.match(applyOut1, /Production WordPress provisioning complete/);

    // Bundle directory checksums must remain untouched after running setup.sh
    dockerExecWww('(cd /tmp/dist && sha256sum -c MANIFEST.sha256 >/dev/null)');

    // h. Execute shared verify-probe.php against real MariaDB WordPress
    const probeRaw1 = dockerExecWww('wp eval-file /tmp/verify/verify-probe.php /tmp/verify/verify.json');
    const report1 = JSON.parse(probeRaw1);
    assert.equal(report1.ok, true, `${preset}: MariaDB verify-probe failed:\n${JSON.stringify(report1, null, 2)}`);
    assert.equal(report1.wordpress_loaded, true);
    assert.equal(report1.blogname, siteName);
    assert.equal(report1.abilities_api, true);
    assert.equal(report1.rest_api.types_status, 200);

    // Front-page parity check
    if (stateJson.page_on_front_slug) {
      assert.equal(report1.front_page?.show_on_front, 'page', `${preset}: expected show_on_front='page'`);
      assert.equal(
        report1.front_page?.page_on_front_slug,
        stateJson.page_on_front_slug,
        `${preset}: expected front page slug "${stateJson.page_on_front_slug}", got "${report1.front_page?.page_on_front_slug}"`
      );
    }
    if (stateJson.page_for_posts_slug) {
      assert.equal(
        report1.front_page?.page_for_posts_slug,
        stateJson.page_for_posts_slug,
        `${preset}: expected posts page slug "${stateJson.page_for_posts_slug}"`
      );
    }

    // Publishing authorship & role parity check
    if (preset === 'publishing') {
      const summaryResp = await httpGet(`${baseUrl}/wp-json/wpai/v1/editorial-summary`);
      assert.equal(summaryResp.status, 200);
      const summaryData = JSON.parse(summaryResp.text);
      assert.equal(summaryData.publication, siteName);
      assert.ok(summaryData.published_posts >= 4);
      const logins = new Map(summaryData.editorial_team.map((u) => [u.login, u.roles]));
      assert.deepEqual(logins.get('maya_editor'), ['editor']);
      assert.deepEqual(logins.get('david_author'), ['author']);
      assert.deepEqual(logins.get('priya_contributor'), ['contributor']);

      // Confirm articles preserved their distinct non-admin authors rather than falling back to admin
      const authorIds = dockerExecWww("wp post list --post_type=post --post_status=publish --name=town-council-approves-riverwalk-trail --field=post_author").trim();
      const mayaId = dockerExecWww("wp user get maya_editor --field=ID").trim();
      assert.equal(authorIds, mayaId, 'publishing: article author must map to maya_editor');
    }

    // i. Real HTTP checks over Apache (/, required pages, /wp-json/wp/v2/types, required REST routes)
    const verifySpec = JSON.parse(fs.readFileSync(path.join(siteDir, 'verify.json'), 'utf8'));
    const homeResp = await httpGet(`${baseUrl}/`);
    assert.equal(homeResp.status, 200, `${preset}: GET / returned ${homeResp.status}`);
    assert.ok(homeResp.text.includes(siteName), `${preset}: GET / HTML should contain site title "${siteName}"`);

    for (const slug of verifySpec.required_pages ?? []) {
      const pageUrl = `${baseUrl}/${encodeURIComponent(slug.toLowerCase())}/`;
      const pageResp = await httpGet(pageUrl);
      assert.equal(pageResp.status, 200, `${preset}: GET ${pageUrl} returned ${pageResp.status}`);
    }

    const typesHttp = await httpGet(`${baseUrl}/wp-json/wp/v2/types`);
    assert.equal(typesHttp.status, 200, `${preset}: GET /wp-json/wp/v2/types returned ${typesHttp.status}`);

    for (const route of verifySpec.required_rest_routes ?? []) {
      const normRoute = route.startsWith('/') ? route : `/${route}`;
      const restUrl = `${baseUrl}/wp-json${normRoute}`;
      const restResp = await httpGet(restUrl);
      assert.equal(restResp.status, 200, `${preset}: GET ${restUrl} returned ${restResp.status}`);
    }

    // j. Idempotency check: snapshot counts after initial front-end render (Twenty Twenty-Five creates
    //    a fallback `wp_navigation` post on first GET /), run setup.sh --yes a SECOND time, and assert
    //    zero page/post/CPT/category/user changes.
    const preRerunReport = JSON.parse(
      dockerExecWww('wp eval-file /tmp/verify/verify-probe.php /tmp/verify/verify.json')
    );
    const applyOut2 = dockerExecWww('/tmp/dist/setup.sh --yes');
    assert.match(applyOut2, /Production WordPress provisioning complete/);

    const probeRaw2 = dockerExecWww('wp eval-file /tmp/verify/verify-probe.php /tmp/verify/verify.json');
    const report2 = JSON.parse(probeRaw2);
    assert.equal(report2.ok, true, `${preset}: second setup.sh run failed verify-probe`);
    assert.deepEqual(
      report2.counts,
      preRerunReport.counts,
      `${preset}: setup.sh is not idempotent! Counts changed on re-run:\nbefore=${JSON.stringify(preRerunReport.counts)}\nafter=${JSON.stringify(report2.counts)}`
    );

    console.log(
      `[Gate 3] PASS "${preset}" — pages=${report2.counts.pages}, posts=${report2.counts.posts}, categories=${report2.counts.categories}, users=${report2.counts.users} (HTTP 200 + idempotent re-run verified)`
    );
  }

  console.log('\nPASS: All 6 presets passed Gate 3 MariaDB + WordPress Production Parity & Idempotency verification.');
} finally {
  spawnSync('docker', ['rm', '-f', wpContainer, dbContainer], { stdio: 'ignore' });
  spawnSync('docker', ['network', 'rm', netName], { stdio: 'ignore' });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
