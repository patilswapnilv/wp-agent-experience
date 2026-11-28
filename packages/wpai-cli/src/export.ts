import fs from 'node:fs';
import path from 'node:path';
import type { Blueprint, BlueprintStep } from './types.js';
import { validateBlueprintFile } from './validator.js';

export interface ExportOptions {
  target: string;
  outDir: string;
  /** Write the bundle even when some Blueprint operations could not be translated. */
  allowPartial?: boolean;
}

export interface SkippedStep {
  /** Where the operation came from, e.g. `steps[3]`, `plugins[0]`, `constants`, `login`, `wp-content/<file>`. */
  location: string;
  /** Blueprint step name, or the top-level key for shorthand properties. */
  step: string;
  reason: string;
  /** `true` when production will be missing something the Blueprint does; `false` for Playground-only operations. */
  blocking: boolean;
}

export interface ExportResult {
  ok: boolean;
  /** `true` when every Blueprint operation that affects production was translated. */
  complete: boolean;
  source_blueprint: string;
  out_dir: string;
  wp_content_files: string[];
  wp_cli_commands: string[];
  skipped_steps: SkippedStep[];
  files_written: string[];
}

// ---------------------------------------------------------------------------
// Security primitives (see docs/export-security-and-parity.md, threats T1–T7)
// ---------------------------------------------------------------------------

/** WordPress.org plugin/theme slug (T4). Rejects URLs, local zips, paths, and leading-dash flags. */
export const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Option names we emit as positional WP-CLI arguments. Must not start with `-` (T4). */
const OPTION_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;

/** Locale codes accepted by `wp language core install` / `wp site switch-language`. */
const LOCALE_RE = /^[a-z]{2,3}(_[A-Z]{2})?(_[a-z0-9]+)?$/;

/**
 * Options that change site identity, access control, or code loading. They are never written
 * by the exporter, regardless of source (`siteOptions`, `setSiteOptions`, or a `wp-cli` step).
 */
const SENSITIVE_OPTION_KEYS = new Set([
  'siteurl',
  'home',
  'active_plugins',
  'active_sitewide_plugins',
  'recently_activated',
  'default_role',
  'users_can_register',
  'admin_email',
  'new_admin_email',
  'template',
  'stylesheet',
  'cron',
  'upload_path',
  'upload_url_path',
  'auth_key',
  'auth_salt',
  'secure_auth_key',
  'secure_auth_salt',
  'logged_in_key',
  'logged_in_salt',
  'nonce_key',
  'nonce_salt',
]);

function isSensitiveOptionKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_OPTION_KEYS.has(k) || k.endsWith('user_roles');
}

/** WP-CLI global flags that execute code or retarget the command; blocked everywhere (T1). */
const BLOCKED_GLOBAL_FLAGS = new Set(['exec', 'require', 'ssh', 'http', 'path', 'url', 'allow-root', 'user', 'context']);

/** Files that must never be shipped in a deployable bundle (T5), matched against the basename. */
const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /^wp-config.*\.php$/i,
  /\.env([._-]|$)/i,
  /\.sql(\.(gz|bz2|xz|zip))?$/i,
  /\.sqlite/i,
  /^debug\.log$/i,
  /\.(pem|key|p12|pfx)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.htaccess$/i,
  /^\.htpasswd$/i,
  /^\.user\.ini$/i,
];

export function isSensitiveFileName(name: string): boolean {
  return SENSITIVE_FILE_PATTERNS.some((re) => re.test(name));
}

const PLUGIN_PHP_FILE_RE = /^[a-z0-9][a-z0-9_.-]*\.php$/i;

/**
 * Valid WordPress plugin activation identifier: either a directory slug (`jetpack`),
 * a `<slug>/<file>.php` plugin basename (`custom/addon.php`), or a root `<file>.php` (`hello.php`).
 */
export function isValidPluginIdentifier(id: string): boolean {
  if (!id || id.includes('..')) return false;
  if (SLUG_RE.test(id)) return true;
  if (PLUGIN_PHP_FILE_RE.test(id)) return true;
  const parts = id.split('/');
  return parts.length === 2 && SLUG_RE.test(parts[0]!) && PLUGIN_PHP_FILE_RE.test(parts[1]!);
}

function shellEscapeSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

type PositionalCheck = (args: string[]) => string | null;

interface WpCliRule {
  min: number;
  max: number;
  flags: string[];
  check?: PositionalCheck;
}

const checkSlugs: PositionalCheck = (args) => {
  const bad = args.find((a) => !SLUG_RE.test(a));
  return bad === undefined ? null : `"${bad}" is not a WordPress.org slug (${SLUG_RE.source}).`;
};

const checkPluginIds: PositionalCheck = (args) => {
  const bad = args.find((a) => !isValidPluginIdentifier(a));
  return bad === undefined ? null : `"${bad}" is not a valid WordPress plugin slug or plugin file identifier.`;
};

const checkOptionKeys = (count: number): PositionalCheck => (args) => {
  for (const key of args.slice(0, count)) {
    if (!OPTION_KEY_RE.test(key)) return `Option name "${key}" is not allowed.`;
    if (isSensitiveOptionKey(key)) return `Option "${key}" is security-sensitive; set it manually on production.`;
  }
  return null;
};

const checkLocales: PositionalCheck = (args) => {
  const bad = args.find((a) => !LOCALE_RE.test(a));
  return bad === undefined ? null : `"${bad}" is not a locale code.`;
};

const POST_FLAGS = [
  'post_type',
  'post_title',
  'post_content',
  'post_status',
  'post_name',
  'post_excerpt',
  'post_parent',
  'post_date',
  'menu_order',
  'comment_status',
  'ping_status',
  'page_template',
  'porcelain',
];

/**
 * Per-subcommand allowlist for raw `wp-cli` steps (T1). Anything not listed here is reported
 * as a blocking skipped step instead of being written to `setup.sh`.
 */
const WP_CLI_ALLOWLIST: Record<string, WpCliRule> = {
  'option update': { min: 2, max: 2, flags: ['format', 'autoload'], check: checkOptionKeys(1) },
  'option add': { min: 2, max: 2, flags: ['format', 'autoload'], check: checkOptionKeys(1) },
  'option delete': { min: 1, max: 20, flags: [], check: checkOptionKeys(20) },
  'plugin install': { min: 1, max: 20, flags: ['activate', 'version', 'force'], check: checkSlugs },
  'plugin activate': { min: 1, max: 20, flags: [], check: checkPluginIds },
  'plugin deactivate': { min: 1, max: 20, flags: [], check: checkPluginIds },
  'theme install': { min: 1, max: 20, flags: ['activate', 'version', 'force'], check: checkSlugs },
  'theme activate': { min: 1, max: 1, flags: [], check: checkSlugs },
  'rewrite structure': { min: 1, max: 1, flags: ['category-base', 'tag-base', 'hard'] },
  'rewrite flush': { min: 0, max: 0, flags: ['hard'] },
  'post create': { min: 0, max: 0, flags: POST_FLAGS },
  'term create': { min: 2, max: 2, flags: ['slug', 'description', 'parent', 'porcelain'] },
  'menu create': { min: 1, max: 1, flags: ['porcelain'] },
  'menu location assign': { min: 2, max: 2, flags: [] },
  'menu item add-custom': {
    min: 3,
    max: 3,
    flags: ['description', 'attr-title', 'target', 'classes', 'position', 'parent-id', 'porcelain'],
  },
  'menu item add-post': { min: 2, max: 2, flags: ['title', 'position', 'parent-id', 'porcelain'] },
  'language core install': { min: 1, max: 10, flags: ['activate'], check: checkLocales },
  'site switch-language': { min: 1, max: 1, flags: [], check: checkLocales },
  'cache flush': { min: 0, max: 0, flags: [] },
};

type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Split a `wp-cli` step command into argv the way a POSIX shell would for plain words and
 * single/double-quoted strings, but refuse anything that would have shell meaning (T1).
 */
export function tokenizeWpCliCommand(command: string): Result<string[]> {
  if (/[\0\r\\]/.test(command)) {
    return { ok: false, reason: 'Command contains NUL, carriage return, or backslash characters.' };
  }
  const argv: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (ch === '\n') {
        return { ok: false, reason: 'Command spans multiple lines; only a single WP-CLI command is allowed.' };
      }
      if (inToken) {
        argv.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    if (/[;|&$`<>(){}*?~#!]/.test(ch)) {
      return { ok: false, reason: `Command contains the shell metacharacter "${ch}" outside quotes.` };
    }
    current += ch;
    inToken = true;
  }
  if (quote) {
    return { ok: false, reason: 'Command has an unterminated quote.' };
  }
  if (inToken) argv.push(current);
  return { ok: true, value: argv };
}

/**
 * Validate a `wp-cli` step against the allowlist and return a safely re-quoted command line.
 * The original string is never written to `setup.sh`.
 */
export function sanitizeWpCliCommand(command: string): Result<string> {
  const tokens = tokenizeWpCliCommand(command.trim());
  if (!tokens.ok) return tokens;
  const argv = tokens.value;
  if (argv[0] !== 'wp') {
    return { ok: false, reason: 'Command must start with "wp".' };
  }

  const positionals: string[] = [];
  const flags: Array<{ name: string; value: string | null }> = [];
  for (const tok of argv.slice(1)) {
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
      const value = eq === -1 ? null : tok.slice(eq + 1);
      if (BLOCKED_GLOBAL_FLAGS.has(name)) {
        return { ok: false, reason: `WP-CLI global flag --${name} is blocked (code execution or retargeting).` };
      }
      if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
        return { ok: false, reason: `Malformed WP-CLI flag "${tok}".` };
      }
      flags.push({ name, value });
    } else if (tok.startsWith('-') && tok.length > 1 && !/^-\d/.test(tok)) {
      return { ok: false, reason: `Short flag "${tok}" is not allowed.` };
    } else {
      positionals.push(tok);
    }
  }

  let ruleKey: string | null = null;
  let rule: WpCliRule | undefined;
  for (const len of [3, 2]) {
    const candidate = positionals.slice(0, len).join(' ');
    if (positionals.length >= len && Object.hasOwn(WP_CLI_ALLOWLIST, candidate)) {
      ruleKey = candidate;
      rule = WP_CLI_ALLOWLIST[candidate];
      break;
    }
  }
  if (!ruleKey || !rule) {
    const shown = positionals.slice(0, 2).join(' ') || '(none)';
    return { ok: false, reason: `WP-CLI subcommand "${shown}" is not on the export allowlist.` };
  }
  const args = positionals.slice(ruleKey.split(' ').length);
  if (args.length < rule.min || args.length > rule.max) {
    return {
      ok: false,
      reason: `"wp ${ruleKey}" expects ${rule.min === rule.max ? rule.min : `${rule.min}-${rule.max}`} positional argument(s), got ${args.length}.`,
    };
  }
  for (const f of flags) {
    if (!rule.flags.includes(f.name)) {
      return { ok: false, reason: `Flag --${f.name} is not allowed for "wp ${ruleKey}".` };
    }
  }
  const problem = rule.check ? rule.check(args) : null;
  if (problem) return { ok: false, reason: problem };

  const parts = [
    'wp',
    ruleKey,
    ...args.map(shellEscapeSingle),
    ...flags.map((f) => (f.value === null ? `--${f.name}` : `--${f.name}=${shellEscapeSingle(f.value)}`)),
  ];
  return { ok: true, value: parts.join(' ') };
}

/**
 * Map a Blueprint `/wordpress/wp-content/...` path to a safe relative path inside the bundle's
 * wp-content/ (T3). Returns `null` when the path escapes, is empty, or is otherwise unsafe.
 */
function safeWpContentRel(destPath: string, allowEmpty: boolean): string | null {
  const prefix = '/wordpress/wp-content';
  if (destPath !== prefix && !destPath.startsWith(`${prefix}/`)) return null;
  const raw = destPath.slice(prefix.length);
  if (/[\0\\:]/.test(raw)) return null;
  const segments = raw.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) return null;
  const rel = segments.join('/');
  if (!rel && !allowEmpty) return null;
  return rel;
}

function isInside(root: string, candidate: string): boolean {
  const resolved = path.resolve(root, candidate);
  return resolved === root || resolved.startsWith(root + path.sep);
}

function resolveBlueprintAndBase(target: string): { blueprintPath: string; baseDir: string } {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) {
    throw new Error(`Export target not found: ${abs}`);
  }
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    const bp = path.join(abs, 'blueprint.json');
    if (!fs.existsSync(bp)) {
      throw new Error(`No blueprint.json found in directory: ${abs}`);
    }
    return { blueprintPath: bp, baseDir: abs };
  }
  return { blueprintPath: abs, baseDir: path.dirname(abs) };
}

/**
 * Walk a local wp-content/ tree without following symlinks (T3) and without picking up
 * sensitive files (T5). Returns the relative file list to copy; problems go to `skip`.
 */
function planWpContentCopy(
  srcDir: string,
  relDir: string,
  files: string[],
  skip: (location: string, step: string, reason: string, blocking?: boolean) => void
): void {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    const location = `wp-content/${rel}`;
    const st = fs.lstatSync(path.join(srcDir, entry.name));
    if (st.isSymbolicLink()) {
      skip(location, 'wp-content', 'Symbolic link not followed; copy the real files into the bundle manually.');
      continue;
    }
    if (isSensitiveFileName(entry.name)) {
      skip(location, 'wp-content', 'Sensitive file (credentials, database dump, or debug log) excluded from the bundle.', false);
      continue;
    }
    if (entry.name.startsWith('.')) continue;
    if (st.isDirectory()) {
      planWpContentCopy(path.join(srcDir, entry.name), rel, files, skip);
    } else if (st.isFile()) {
      files.push(rel);
    }
  }
}

function buildSetupScript(commands: string[], complete: boolean, blockingCount: number): string {
  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    '# Generated by `wpai export` from blueprint.json',
    '# Run from your production WordPress root (MySQL/MariaDB + WP-CLI required).',
    '#',
    '# Usage: ./setup.sh [--dry-run] [--yes]',
    '#   --dry-run  Print the WP-CLI commands without running them.',
    '#   --yes      Apply without the interactive confirmation prompt (CI/automation).',
    ...(complete
      ? []
      : [
          '#',
          `# INCOMPLETE EXPORT: ${blockingCount} Blueprint operation(s) were not exported.`,
          '# See "Manual Steps Required" in DEPLOY.md before relying on this site.',
        ]),
    '',
    'DRY_RUN=0',
    'ASSUME_YES=0',
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    --dry-run|-n) DRY_RUN=1 ;;',
    '    --yes|-y) ASSUME_YES=1 ;;',
    '    -h|--help)',
    '      echo "Usage: ./setup.sh [--dry-run] [--yes]"',
    '      echo "  --dry-run  Print the WP-CLI commands without running them."',
    '      echo "  --yes      Apply without the interactive confirmation prompt."',
    '      exit 0 ;;',
    '    *) echo "Unknown option: $arg (see --help)" >&2; exit 2 ;;',
    '  esac',
    'done',
    '',
    'run() {',
    '  if [ "$DRY_RUN" -eq 1 ]; then',
    "    printf '[dry-run]'; printf ' %q' \"$@\"; printf '\\n'",
    '  else',
    '    "$@"',
    '  fi',
    '}',
    '',
    'if [ "$DRY_RUN" -eq 0 ]; then',
    '  if ! command -v wp >/dev/null 2>&1; then',
    '    echo "Error: wp-cli (wp) is required on PATH." >&2',
    '    exit 1',
    '  fi',
    '  if [ "$ASSUME_YES" -ne 1 ]; then',
    '    if [ ! -t 0 ]; then',
    '      echo "Refusing to modify WordPress non-interactively without --yes. Preview first with --dry-run." >&2',
    '      exit 1',
    '    fi',
    '    SITE_URL="$(wp option get siteurl 2>/dev/null || echo unknown)"',
    `    printf 'About to apply ${commands.length} WP-CLI command(s) to %s (WordPress root: %s).\\n' "$SITE_URL" "$(pwd)"`,
    "    read -r -p 'Continue? [y/N] ' REPLY",
    '    case "$REPLY" in',
    '      y|Y|yes|YES) ;;',
    '      *) echo "Aborted; nothing was changed."; exit 1 ;;',
    '    esac',
    '  fi',
    'fi',
    '',
    ...(commands.length > 0
      ? commands.map((c) => `run ${c}`)
      : ['echo "No WP-CLI options/plugin commands extracted from blueprint.json."']),
    '',
    'run wp rewrite flush --hard || true',
    '',
    'if [ "$DRY_RUN" -eq 1 ]; then',
    '  echo "Dry run complete; nothing was changed."',
    '  exit 0',
    'fi',
    complete
      ? 'echo "Production WordPress provisioning complete."'
      : `echo "WARNING: incomplete export. ${blockingCount} Blueprint operation(s) were not applied; see Manual Steps Required in DEPLOY.md." >&2`,
    '',
  ];
  return lines.join('\n');
}

export function exportForProduction(options: ExportOptions): ExportResult {
  const { blueprintPath, baseDir } = resolveBlueprintAndBase(options.target);
  const validation = validateBlueprintFile(blueprintPath);
  if (!validation.valid) {
    const first = validation.errors[0];
    throw new Error(
      `Blueprint failed validation before export: ${first ? `${first.path}: ${first.message}` : 'invalid blueprint'}`
    );
  }

  const bp = JSON.parse(fs.readFileSync(blueprintPath, 'utf8')) as Blueprint;
  const outDir = path.resolve(options.outDir);
  const wpContentOut = path.join(outDir, 'wp-content');
  const wpCliCommands: string[] = [];
  const skippedSteps: SkippedStep[] = [];
  const pendingWrites: Array<{ rel: string; content: string }> = [];
  const pendingDirs: string[] = [];

  const skip = (location: string, step: string, reason: string, blocking = true): void => {
    skippedSteps.push({ location, step, reason, blocking });
  };

  const addOptionUpdate = (location: string, step: string, key: string, value: unknown): void => {
    if (!OPTION_KEY_RE.test(key)) {
      skip(location, step, `Option name "${key}" is not allowed in an exported WP-CLI command; set it manually.`);
      return;
    }
    if (isSensitiveOptionKey(key)) {
      skip(location, step, `Option "${key}" is security-sensitive and is not exported; set it manually on production.`);
      return;
    }
    const structured = value === null || typeof value === 'object' || typeof value === 'boolean';
    const serialized = structured ? JSON.stringify(value) : String(value);
    if (serialized.startsWith('--')) {
      // WP-CLI would parse a value starting with `--` as a flag, even when shell-quoted (T4).
      skip(location, step, `Value for option "${key}" starts with "--" and cannot be passed safely; set it manually.`);
      return;
    }
    wpCliCommands.push(
      `wp option update ${shellEscapeSingle(key)} ${shellEscapeSingle(serialized)}${structured ? ' --format=json' : ''}`
    );
  };

  const addInstall = (location: string, step: string, kind: 'plugin' | 'theme', slug: string, activate: boolean): void => {
    if (!SLUG_RE.test(slug)) {
      skip(location, step, `"${slug}" is not a valid WordPress.org ${kind} slug; install this ${kind} manually.`);
      return;
    }
    wpCliCommands.push(`wp ${kind} install ${shellEscapeSingle(slug)}${activate ? ' --activate' : ''}`);
  };

  // 1. Top-level siteOptions -> wp option update
  if (bp.siteOptions && typeof bp.siteOptions === 'object') {
    for (const [k, v] of Object.entries(bp.siteOptions)) {
      addOptionUpdate('siteOptions', 'siteOptions', k, v);
    }
  }

  // 2. Top-level plugins -> wp plugin install --activate
  if (Array.isArray(bp.plugins)) {
    bp.plugins.forEach((p, i) => {
      if (typeof p === 'string' && p.trim()) {
        addInstall(`plugins[${i}]`, 'plugins', 'plugin', p.trim(), true);
      } else {
        skip(`plugins[${i}]`, 'plugins', 'Only WordPress.org plugin slugs can be exported; install this plugin manually.');
      }
    });
  }

  // 3. Top-level shorthands with no production equivalent
  if (bp.constants && typeof bp.constants === 'object' && Object.keys(bp.constants).length > 0) {
    skip(
      'constants',
      'constants',
      `wp-config.php constants are not exported; define them on the production host: ${Object.keys(bp.constants).join(', ')}.`
    );
  }
  if (bp.login !== undefined && bp.login !== false) {
    skip('login', 'login', 'Playground auto-login only; no production equivalent.', false);
  }

  // 4. Walk Blueprint steps and translate what has a production equivalent
  const steps: unknown[] = Array.isArray(bp.steps) ? bp.steps : [];
  steps.forEach((rawStep, i) => {
    const location = `steps[${i}]`;
    if (!rawStep || typeof rawStep !== 'object') {
      skip(location, String(rawStep), 'Step is not an object and was not exported.');
      return;
    }
    const step = rawStep as BlueprintStep;
    const name = typeof step.step === 'string' ? step.step : '(unnamed)';

    switch (name) {
      case 'writeFile': {
        const destPath = typeof step.path === 'string' ? step.path : '';
        if (!destPath.startsWith('/wordpress/wp-content/')) {
          skip(location, name, `Writes outside wp-content/ (${destPath || 'no path'}); only wp-content/ files are exported.`);
          break;
        }
        const relInside = safeWpContentRel(destPath, false);
        if (!relInside || !isInside(wpContentOut, relInside) || relInside === '') {
          skip(location, name, `Unsafe or empty wp-content path (${destPath}); file not exported.`);
          break;
        }
        if (isSensitiveFileName(path.posix.basename(relInside))) {
          skip(location, name, `Sensitive file name (${destPath}); not exported. Create it manually on production if needed.`);
          break;
        }
        const data = step.data;
        let content: string | null = null;
        if (typeof data === 'string') {
          content = data;
        } else if (
          data &&
          typeof data === 'object' &&
          (data as Record<string, unknown>).resource === 'literal' &&
          typeof (data as Record<string, unknown>).contents === 'string'
        ) {
          content = (data as Record<string, unknown>).contents as string;
        }
        if (content === null) {
          skip(location, name, `File data is not an inline string or literal resource (${destPath}); copy this file manually.`);
          break;
        }
        pendingWrites.push({ rel: relInside, content });
        break;
      }

      case 'mkdir': {
        const dirPath = typeof step.path === 'string' ? step.path : '';
        if (dirPath === '/wordpress/wp-content' || dirPath.startsWith('/wordpress/wp-content/')) {
          const relInside = safeWpContentRel(dirPath, true);
          if (relInside === null || !isInside(wpContentOut, relInside)) {
            skip(location, name, `Unsafe wp-content path (${dirPath}); directory not exported.`);
            break;
          }
          // Recreate the directory in the bundle so even an empty one reaches production.
          pendingDirs.push(relInside);
        } else {
          skip(location, name, `Creates a directory outside wp-content/ (${dirPath || 'no path'}); create it manually.`);
        }
        break;
      }

      case 'login': {
        skip(location, name, 'Playground auto-login only; no production equivalent.', false);
        break;
      }

      case 'setSiteOptions': {
        const opts = step.options;
        if (opts && typeof opts === 'object') {
          for (const [k, v] of Object.entries(opts as Record<string, unknown>)) {
            addOptionUpdate(location, name, k, v);
          }
        } else {
          skip(location, name, 'No options object; nothing exported.');
        }
        break;
      }

      case 'installPlugin': {
        const pluginData = step.pluginData as Record<string, unknown> | undefined;
        if (pluginData && pluginData.resource === 'wordpress.org/plugins' && typeof pluginData.slug === 'string' && pluginData.slug.trim()) {
          const activate = !step.options || (step.options as Record<string, unknown>).activate !== false;
          addInstall(location, name, 'plugin', pluginData.slug.trim(), activate);
        } else {
          const source = pluginData && typeof pluginData.resource === 'string' ? pluginData.resource : 'unknown';
          skip(location, name, `Plugin source "${source}" has no usable WordPress.org slug; install this plugin manually.`);
        }
        break;
      }

      case 'installTheme': {
        const themeData = step.themeData as Record<string, unknown> | undefined;
        if (themeData && themeData.resource === 'wordpress.org/themes' && typeof themeData.slug === 'string' && themeData.slug.trim()) {
          const activate = !step.options || (step.options as Record<string, unknown>).activate !== false;
          addInstall(location, name, 'theme', themeData.slug.trim(), activate);
        } else {
          const source = themeData && typeof themeData.resource === 'string' ? themeData.resource : 'unknown';
          skip(location, name, `Theme source "${source}" has no usable WordPress.org slug; install this theme manually.`);
        }
        break;
      }

      case 'activatePlugin': {
        // Normalize `/wordpress/wp-content/plugins/<slug>/<file>.php`, `<slug>/<file>.php`, `<file>.php`, or `<slug>` (T4).
        const raw = typeof step.pluginPath === 'string' ? step.pluginPath.trim() : '';
        const pluginId = raw.replace(/^\/wordpress\/wp-content\/plugins\/+/, '').replace(/\/+$/, '');
        if (isValidPluginIdentifier(pluginId) && !raw.startsWith('/wordpress/wp-content/plugins//')) {
          wpCliCommands.push(`wp plugin activate ${shellEscapeSingle(pluginId)}`);
        } else {
          skip(location, name, `Plugin path "${raw || '(none)'}" does not resolve to a valid plugin identifier; activate it manually.`);
        }
        break;
      }

      case 'activateTheme': {
        const folder = typeof step.themeFolderName === 'string' ? step.themeFolderName.trim() : '';
        if (!folder) {
          skip(location, name, 'No themeFolderName; nothing exported.');
        } else if (!SLUG_RE.test(folder)) {
          skip(location, name, `Theme folder "${folder}" is not a valid theme slug; activate it manually.`);
        } else {
          wpCliCommands.push(`wp theme activate ${shellEscapeSingle(folder)}`);
        }
        break;
      }

      case 'wp-cli': {
        if (typeof step.command === 'string' && step.command.trim()) {
          const sanitized = sanitizeWpCliCommand(step.command);
          if (sanitized.ok) {
            wpCliCommands.push(sanitized.value);
          } else {
            skip(location, name, `WP-CLI command not exported: ${sanitized.reason} Run an equivalent command manually.`);
          }
        } else {
          skip(location, name, 'No command string; nothing exported.');
        }
        break;
      }

      case 'runPHP': {
        skip(location, name, 'PHP is not replayed in production; content or settings it creates (pages, posts, front page, users) must be recreated manually.');
        break;
      }

      default: {
        skip(location, name, `No production translation for "${name}"; reproduce its effect manually.`);
        break;
      }
    }
  });

  // 5. Plan the local sibling wp-content/ copy (symlinks and sensitive files are never copied)
  const localWpContent = path.join(baseDir, 'wp-content');
  const filesToCopy: string[] = [];
  if (fs.existsSync(localWpContent)) {
    const st = fs.lstatSync(localWpContent);
    if (st.isSymbolicLink()) {
      skip('wp-content', 'wp-content', 'Local wp-content/ is a symbolic link and was not followed; copy the real directory manually.');
    } else if (st.isDirectory()) {
      planWpContentCopy(localWpContent, '', filesToCopy, skip);
    }
  }

  const blocking = skippedSteps.filter((s) => s.blocking);
  const complete = blocking.length === 0;
  const ok = complete || options.allowPartial === true;

  if (!ok) {
    // Fail safe: write nothing, so no incomplete bundle can be mistaken for a deployable one.
    return {
      ok: false,
      complete: false,
      source_blueprint: blueprintPath,
      out_dir: outDir,
      wp_content_files: [],
      wp_cli_commands: wpCliCommands,
      skipped_steps: skippedSteps,
      files_written: [],
    };
  }

  if (outDir === path.parse(outDir).root || outDir === baseDir || isInside(outDir, baseDir)) {
    throw new Error(`Export output directory (${outDir}) must be distinct from the source project directory (${baseDir}).`);
  }

  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  const stageDir = fs.mkdtempSync(path.join(path.dirname(outDir), `.wpai-export-${path.basename(outDir)}-`));
  const stageWpContent = path.join(stageDir, 'wp-content');
  const wpContentFiles: string[] = [];
  const filesWritten: string[] = [];

  try {
    // 6. Build the bundle in a clean staging directory so stale/excluded files never remain in a reused outDir
    for (const rel of filesToCopy) {
      const dst = path.join(stageWpContent, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(localWpContent, ...rel.split('/')), dst);
      wpContentFiles.push(path.relative(stageDir, dst));
    }
    for (const relInside of pendingDirs) {
      fs.mkdirSync(path.join(stageWpContent, relInside), { recursive: true });
    }
    for (const { rel: relInside, content } of pendingWrites) {
      const targetFile = path.join(stageWpContent, relInside);
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.writeFileSync(targetFile, content, 'utf8');
      const rel = path.relative(stageDir, targetFile);
      if (!wpContentFiles.includes(rel)) {
        wpContentFiles.push(rel);
      }
    }

    // 7. Copy blueprint.json for reference
    const bpOut = path.join(stageDir, 'blueprint.json');
    fs.copyFileSync(blueprintPath, bpOut);
    filesWritten.push('blueprint.json');

    // 8. Write executable setup.sh WP-CLI handoff script (guarded by --dry-run / --yes, T7)
    const setupShPath = path.join(stageDir, 'setup.sh');
    fs.writeFileSync(setupShPath, buildSetupScript(wpCliCommands, complete, blocking.length), 'utf8');
    fs.chmodSync(setupShPath, 0o755);
    filesWritten.push('setup.sh');

    // 9. Write DEPLOY.md production handoff checklist
    const deployMdPath = path.join(stageDir, 'DEPLOY.md');
    const siteTitle =
      (bp.meta && typeof bp.meta.title === 'string' && bp.meta.title) ||
      (bp.siteOptions && typeof bp.siteOptions.blogname === 'string' && bp.siteOptions.blogname) ||
      'WordPress Site';
    const describeSkipped = (s: SkippedStep): string => `- \`${s.location}\` (\`${s.step}\`): ${s.reason}`;
    const nonBlocking = skippedSteps.filter((s) => !s.blocking);
    const manualSection = complete
      ? ''
      : `
> **Incomplete export.** ${blocking.length} Blueprint operation(s) could not be translated to production. This bundle was written only because \`--allow-partial\` was set. The production site will not match what \`wpai verify\` checked until you complete the steps below.

## Manual Steps Required

${blocking.map(describeSkipped).join('\n')}
`;
    const playgroundOnlySection =
      nonBlocking.length === 0
        ? ''
        : `
## Not Exported (Playground-Only or Excluded, No Action Needed)

${nonBlocking.map(describeSkipped).join('\n')}
`;
    const deployMd = `# Production Deployment Handoff — ${siteTitle}

Exported by \`wpai export\` from \`${path.basename(blueprintPath)}\`.
${manualSection}
## Included Artifacts

- \`wp-content/\` — ${wpContentFiles.length} extracted theme/plugin/mu-plugin file(s) ready to copy into your production WordPress \`wp-content/\` directory. Symlinks and sensitive files (\`wp-config*.php\`, \`.env\`, \`*.sql\`, \`debug.log\`, keys) are never included.
- \`setup.sh\` — ${wpCliCommands.length} WP-CLI provisioning command(s) for options, plugins, and theme activation. Raw \`wp-cli\` steps are only included when they match the export allowlist.
- \`blueprint.json\` — Original declarative WordPress Playground Blueprint for local preview and CI verification.
${playgroundOnlySection}
## Production Checklist (MySQL / Managed Hosting)

1. **Provision WordPress on MySQL 8.0+ or MariaDB 10.11+** (managed host, VPS, or WordPress Studio sync) rather than Playground SQLite.
2. **Copy \`wp-content/\`** from this export bundle into your production WordPress \`wp-content/\` directory.
3. **Preview with \`./setup.sh --dry-run\`**, then run \`./setup.sh\` from the production WordPress root (it asks for confirmation; use \`./setup.sh --yes\` in automation) to apply site options, install plugins/themes, and flush rewrite rules.${complete ? '' : '\n4. **Complete every item under Manual Steps Required** above.'}
${complete ? 4 : 5}. **Configure production secrets & payments:** Set real SMTP credentials, HTTPS/TLS certificates, payment gateway keys (Stripe/WooCommerce), and automated off-site backups.
${complete ? 5 : 6}. **Verify admin access:** Change any default/demo passwords and confirm \`wp_get_abilities()\` / REST routes return HTTP 200.
`;
    fs.writeFileSync(deployMdPath, deployMd, 'utf8');
    filesWritten.push('DEPLOY.md');

    fs.rmSync(outDir, { recursive: true, force: true });
    fs.renameSync(stageDir, outDir);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }

  for (const f of wpContentFiles) {
    filesWritten.push(f);
  }

  return {
    ok: true,
    complete,
    source_blueprint: blueprintPath,
    out_dir: outDir,
    wp_content_files: wpContentFiles.sort(),
    wp_cli_commands: wpCliCommands,
    skipped_steps: skippedSteps,
    files_written: filesWritten.sort(),
  };
}
