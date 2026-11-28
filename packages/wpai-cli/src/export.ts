import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findPhpAssetPath, findPlaygroundCli } from './paths.js';
import {
  collectBundledResourcePaths,
  copyBundledAssets,
  runSubprocess,
  stageLocalWpContentMounts,
  stripPhpOpenTag,
} from './playground.js';
import type { Blueprint, BlueprintStep, ExportMode } from './types.js';
import { validateBlueprintFile } from './validator.js';

export interface ExportOptions {
  target: string;
  outDir: string;
  /** Write the bundle even when some Blueprint operations could not be translated. */
  allowPartial?: boolean;
}

export interface MaterializedExportOptions extends ExportOptions {
  /**
   * Export execution mode:
   * - `'auto'` (default): uses fast offline static export when every Blueprint operation translates
   *   statically, and boots isolated WordPress Playground materialization when content-seeding steps
   *   (`runPHP`, `runPHPWithOptions`, `importWxr`) are present.
   * - `'materialized'`: always boots WordPress Playground to emit `content.wxr` + `wpai-state.json`.
   * - `'static'`: offline Stage 1 translation only (never boots Playground; skips `runPHP`).
   */
  mode?: ExportMode;
  timeoutMs?: number;
  wp?: string;
  php?: string;
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

export interface SecretScanWarning {
  /** Relative POSIX path inside the export bundle where the token pattern matched. */
  file: string;
  /** Identifier of the matched secret pattern (the raw token value is never echoed). */
  pattern: string;
  /** 1-indexed line number inside `file`. */
  line: number;
}

export interface MaterializedUser {
  user_login: string;
  user_email: string;
  display_name: string;
  role: string;
}

export interface MaterializedAttachment {
  slug: string;
  title: string;
  alt: string;
  file: string;
  featured_for: Array<{ post_type: string; post_name: string }>;
}

export interface MaterializedState {
  schema_version: '1.0';
  wordpress_version: string;
  origin_url: string;
  options: Record<string, unknown>;
  page_on_front_slug: string | null;
  page_for_posts_slug: string | null;
  active_theme: {
    stylesheet: string;
    changed: boolean;
  };
  active_plugins: string[];
  users: MaterializedUser[];
  attachments: MaterializedAttachment[];
  custom_tables: string[];
}

export interface ExportResult {
  ok: boolean;
  /** `true` when every Blueprint operation that affects production was translated. */
  complete: boolean;
  /** Whether the bundle was produced via offline `'static'` translation or Stage 2 `'materialized'` Playground extraction. */
  mode: 'static' | 'materialized';
  source_blueprint: string;
  out_dir: string;
  wp_content_files: string[];
  wp_cli_commands: string[];
  skipped_steps: SkippedStep[];
  secret_warnings: SecretScanWarning[];
  files_written: string[];
  materialized?: {
    wxr_file: string;
    state_file: string;
    users_count: number;
    attachments_count: number;
    page_on_front_slug: string | null;
    page_for_posts_slug: string | null;
  };
}

// ---------------------------------------------------------------------------
// Security primitives (see docs/export-security-and-parity.md, threats T1–T7)
// ---------------------------------------------------------------------------

/** WordPress.org plugin/theme slug (T4). Rejects URLs, local zips, paths, and leading-dash flags. */
export const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Safe post/page/attachment slug for WP-CLI `--name=<slug>` lookups. */
const POST_SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/i;

/** Safe WordPress non-admin login (`user_login`) for exported editorial accounts. */
const USER_LOGIN_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,59}$/;

/** Safe email address without shell/quote/flag characters. */
const USER_EMAIL_RE = /^[A-Za-z0-9_][^\s@'"\\`\0]*@[^\s@'"\\`\0]+\.[^\s@'"\\`\0]+$/;

/** Safe HTTP(S) origin URL for `wp search-replace`. */
const SAFE_ORIGIN_URL_RE = /^https?:\/\/[A-Za-z0-9.:-]+(\/[A-Za-z0-9._~:/?#[\]@!$&()*+,;=%-]*)?$/;

/** Option names we emit as positional WP-CLI arguments. Must not start with `-` (T4). */
const OPTION_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;

/** Locale codes accepted by `wp language core install` / `wp site switch-language`. */
const LOCALE_RE = /^[a-z]{2,3}(_[A-Z]{2})?(_[a-z0-9]+)?$/;

/** Pinned WordPress Importer release installed by `setup.sh` when absent on the target host. */
export const PINNED_WP_IMPORTER_VERSION = '0.9.7';

/** Steps materialized cleanly by booting WordPress Playground in Stage 2 (`content.wxr` + `wpai-state.json`). */
const PLAYGROUND_MATERIALIZABLE_STEPS = new Set(['runPHP', 'runPHPWithOptions', 'importWxr']);

/**
 * Options that change site identity, access control, or code loading. They are never written
 * by the exporter, regardless of source (`siteOptions`, `setSiteOptions`, `wpai-state.json`, or `wp-cli`).
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
const BLOCKED_GLOBAL_FLAGS = new Set([
  'exec',
  'require',
  'ssh',
  'http',
  'path',
  'url',
  'allow-root',
  'user',
  'context',
]);

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

/**
 * Common secret/API token patterns scanned across exported text files (T5 warning scanner).
 * Matched values are never included in warnings, logs, or JSON output.
 */
const SECRET_TOKEN_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'openai-or-anthropic-secret-key', re: /\bsk-(?:live-|test-|ant-|proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'private-key-header', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
];

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp4',
  '.webm',
  '.mp3',
]);

export function scanSecretTokens(relPosixPath: string, content: string): SecretScanWarning[] {
  const warnings: SecretScanWarning[] = [];
  const lines = content.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!;
    for (const { name, re } of SECRET_TOKEN_PATTERNS) {
      if (re.test(line)) {
        warnings.push({ file: relPosixPath, pattern: name, line: idx + 1 });
      }
    }
  }
  return warnings;
}

function scanStageDirectorySecrets(stageDir: string, relFiles: string[]): SecretScanWarning[] {
  const warnings: SecretScanWarning[] = [];
  for (const rel of relFiles) {
    if (rel === 'MANIFEST.sha256' || rel === 'DEPLOY.md') continue;
    const ext = path.extname(rel).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) continue;
    const full = path.join(stageDir, ...rel.split('/'));
    const st = fs.lstatSync(full, { throwIfNoEntry: false });
    if (!st || !st.isFile() || st.size > 5 * 1024 * 1024) continue;
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) continue;
    warnings.push(...scanSecretTokens(rel, buf.toString('utf8')));
  }
  return warnings;
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeSha256Manifest(stageDir: string, filesWritten: string[]): void {
  const uniquePosix = Array.from(
    new Set(filesWritten.map((f) => f.split(path.sep).join('/')))
  )
    .filter((f) => f !== 'MANIFEST.sha256')
    .sort();
  const lines = uniquePosix.map((rel) => {
    const full = path.join(stageDir, ...rel.split('/'));
    return `${sha256File(full)}  ${rel}`;
  });
  fs.writeFileSync(path.join(stageDir, 'MANIFEST.sha256'), `${lines.join('\n')}\n`, 'utf8');
  if (!filesWritten.includes('MANIFEST.sha256')) {
    filesWritten.push('MANIFEST.sha256');
  }
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
 * Walk a `wp-content/` tree without following symlinks (T3) and without picking up
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
      skip(
        location,
        'wp-content',
        'Sensitive file (credentials, database dump, or debug log) excluded from the bundle.',
        false
      );
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

function formatOptionUpdateCommand(
  location: string,
  step: string,
  key: string,
  value: unknown,
  skip: (location: string, step: string, reason: string, blocking?: boolean) => void
): string | null {
  if (!OPTION_KEY_RE.test(key)) {
    skip(location, step, `Option name "${key}" is not allowed in an exported WP-CLI command; set it manually.`);
    return null;
  }
  if (isSensitiveOptionKey(key)) {
    skip(location, step, `Option "${key}" is security-sensitive and is not exported; set it manually on production.`);
    return null;
  }
  const structured = value === null || typeof value === 'object' || typeof value === 'boolean';
  const serialized = structured ? JSON.stringify(value) : String(value);
  if (serialized.includes('\0')) {
    skip(location, step, `Value for option "${key}" contains a NUL byte and cannot be passed safely; set it manually.`);
    return null;
  }
  if (serialized.startsWith('--')) {
    // WP-CLI would parse a value starting with `--` as a flag, even when shell-quoted (T4).
    skip(location, step, `Value for option "${key}" starts with "--" and cannot be passed safely; set it manually.`);
    return null;
  }
  return `wp option update ${shellEscapeSingle(key)} ${shellEscapeSingle(serialized)}${structured ? ' --format=json' : ''}`;
}

interface StaticAnalysisPlan {
  blueprintPath: string;
  baseDir: string;
  bp: Blueprint;
  outDir: string;
  wpContentOut: string;
  wpCliCommands: string[];
  preImportCommands: string[];
  postImportWpCliCommands: string[];
  explicitOptionKeys: string[];
  skippedSteps: SkippedStep[];
  pendingWrites: Array<{ rel: string; content: string }>;
  pendingDirs: string[];
  sensitiveWriteSteps: Set<number>;
  localWpContent: string;
  filesToCopy: string[];
  hasMaterializableSteps: boolean;
}

function analyzeBlueprintStatic(
  target: string,
  rawOutDir: string,
  options: { materializeMode: boolean }
): StaticAnalysisPlan {
  const { blueprintPath, baseDir } = resolveBlueprintAndBase(target);
  const validation = validateBlueprintFile(blueprintPath);
  if (!validation.valid) {
    const first = validation.errors[0];
    throw new Error(
      `Blueprint failed validation before export: ${first ? `${first.path}: ${first.message}` : 'invalid blueprint'}`
    );
  }

  const bp = JSON.parse(fs.readFileSync(blueprintPath, 'utf8')) as Blueprint;
  const outDir = path.resolve(rawOutDir);
  const wpContentOut = path.join(outDir, 'wp-content');
  const wpCliCommands: string[] = [];
  const preImportCommands: string[] = [];
  const postImportWpCliCommands: string[] = [];
  const explicitOptionKeys: string[] = [];
  const skippedSteps: SkippedStep[] = [];
  const pendingWrites: Array<{ rel: string; content: string }> = [];
  const pendingDirs: string[] = [];
  const sensitiveWriteSteps = new Set<number>();
  let hasMaterializableSteps = false;

  const skip = (location: string, step: string, reason: string, blocking = true): void => {
    skippedSteps.push({ location, step, reason, blocking });
  };

  const addOptionUpdate = (location: string, step: string, key: string, value: unknown): void => {
    const cmd = formatOptionUpdateCommand(location, step, key, value, skip);
    if (cmd) {
      wpCliCommands.push(cmd);
      if (!explicitOptionKeys.includes(key)) {
        explicitOptionKeys.push(key);
      }
    }
  };

  const addInstall = (
    location: string,
    step: string,
    kind: 'plugin' | 'theme',
    slug: string,
    activate: boolean
  ): void => {
    if (!SLUG_RE.test(slug)) {
      skip(location, step, `"${slug}" is not a valid WordPress.org ${kind} slug; install this ${kind} manually.`);
      return;
    }
    const cmd = `wp ${kind} install ${shellEscapeSingle(slug)}${activate ? ' --activate' : ''}`;
    wpCliCommands.push(cmd);
    preImportCommands.push(cmd);
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

  // 4. Walk Blueprint steps
  const steps: unknown[] = Array.isArray(bp.steps) ? bp.steps : [];
  steps.forEach((rawStep, i) => {
    const location = `steps[${i}]`;
    if (!rawStep || typeof rawStep !== 'object') {
      skip(location, String(rawStep), 'Step is not an object and was not exported.');
      return;
    }
    const step = rawStep as BlueprintStep;
    const name = typeof step.step === 'string' ? step.step : '(unnamed)';

    if (PLAYGROUND_MATERIALIZABLE_STEPS.has(name)) {
      hasMaterializableSteps = true;
    }

    switch (name) {
      case 'writeFile': {
        const destPath = typeof step.path === 'string' ? step.path : '';
        if (destPath && isSensitiveFileName(path.posix.basename(destPath))) {
          sensitiveWriteSteps.add(i);
        }
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
          sensitiveWriteSteps.add(i);
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
          // In materialized mode, bundled files written under /wordpress/wp-content/ are extracted from Playground
          if (
            options.materializeMode &&
            data &&
            typeof data === 'object' &&
            (data as Record<string, unknown>).resource === 'bundled'
          ) {
            hasMaterializableSteps = true;
            break;
          }
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
        if (
          pluginData &&
          pluginData.resource === 'wordpress.org/plugins' &&
          typeof pluginData.slug === 'string' &&
          pluginData.slug.trim()
        ) {
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
        if (
          themeData &&
          themeData.resource === 'wordpress.org/themes' &&
          typeof themeData.slug === 'string' &&
          themeData.slug.trim()
        ) {
          const activate = !step.options || (step.options as Record<string, unknown>).activate !== false;
          addInstall(location, name, 'theme', themeData.slug.trim(), activate);
        } else {
          const source = themeData && typeof themeData.resource === 'string' ? themeData.resource : 'unknown';
          skip(location, name, `Theme source "${source}" has no usable WordPress.org slug; install this theme manually.`);
        }
        break;
      }

      case 'activatePlugin': {
        const raw = typeof step.pluginPath === 'string' ? step.pluginPath.trim() : '';
        const pluginId = raw.replace(/^\/wordpress\/wp-content\/plugins\/+/, '').replace(/\/+$/, '');
        if (isValidPluginIdentifier(pluginId) && !raw.startsWith('/wordpress/wp-content/plugins//')) {
          const cmd = `wp plugin activate ${shellEscapeSingle(pluginId)}`;
          wpCliCommands.push(cmd);
          preImportCommands.push(cmd);
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
          const cmd = `wp theme activate ${shellEscapeSingle(folder)}`;
          wpCliCommands.push(cmd);
          preImportCommands.push(cmd);
        }
        break;
      }

      case 'wp-cli': {
        if (typeof step.command === 'string' && step.command.trim()) {
          const sanitized = sanitizeWpCliCommand(step.command);
          if (sanitized.ok) {
            wpCliCommands.push(sanitized.value);
            postImportWpCliCommands.push(sanitized.value);
          } else {
            skip(location, name, `WP-CLI command not exported: ${sanitized.reason} Run an equivalent command manually.`);
          }
        } else {
          skip(location, name, 'No command string; nothing exported.');
        }
        break;
      }

      case 'runPHP':
      case 'runPHPWithOptions':
      case 'importWxr': {
        if (options.materializeMode) {
          // Materialized cleanly via WordPress Playground into content.wxr + wpai-state.json + wp-content/
          break;
        }
        if (name === 'runPHP') {
          skip(
            location,
            name,
            'PHP is not replayed in production; content or settings it creates (pages, posts, front page, users) must be recreated manually.'
          );
        } else {
          skip(location, name, `No static production translation for "${name}"; run materialized export or reproduce manually.`);
        }
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
  const localWpContentStat = fs.lstatSync(localWpContent, { throwIfNoEntry: false });
  if (localWpContentStat) {
    if (localWpContentStat.isSymbolicLink()) {
      skip('wp-content', 'wp-content', 'Local wp-content/ is a symbolic link and was not followed; copy the real directory manually.');
    } else if (localWpContentStat.isDirectory()) {
      planWpContentCopy(localWpContent, '', filesToCopy, skip);
    }
  }

  return {
    blueprintPath,
    baseDir,
    bp,
    outDir,
    wpContentOut,
    wpCliCommands,
    preImportCommands,
    postImportWpCliCommands,
    explicitOptionKeys,
    skippedSteps,
    pendingWrites,
    pendingDirs,
    sensitiveWriteSteps,
    localWpContent,
    filesToCopy,
    hasMaterializableSteps,
  };
}

function buildStaticSetupScript(commands: string[], complete: boolean, blockingCount: number): string {
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

function buildMaterializedSetupScript(params: {
  preImportCommands: string[];
  optionCommands: string[];
  postImportWpCliCommands: string[];
  users: MaterializedUser[];
  attachments: MaterializedAttachment[];
  pageOnFrontSlug: string | null;
  pageForPostsSlug: string | null;
  activeThemeSlug: string | null;
  activePluginIds: string[];
  originUrl: string | null;
  muPluginFiles: string[];
  complete: boolean;
  blockingCount: number;
}): string {
  const {
    preImportCommands,
    optionCommands,
    postImportWpCliCommands,
    users,
    attachments,
    pageOnFrontSlug,
    pageForPostsSlug,
    activeThemeSlug,
    activePluginIds,
    originUrl,
    muPluginFiles,
    complete,
    blockingCount,
  } = params;

  const lines: string[] = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    '# Generated by `wpai export` (Stage 2 Materialized Export: content.wxr + wpai-state.json)',
    '# Run from your production WordPress root after copying `wp-content/` (MySQL/MariaDB + WP-CLI required).',
    '#',
    '# Usage: ./setup.sh [--dry-run] [--yes]',
    '#   --dry-run  Print the planned WP-CLI operations without running them.',
    '#   --yes      Apply without the interactive confirmation prompt (CI/automation).',
    ...(complete
      ? []
      : [
          '#',
          `# INCOMPLETE EXPORT: ${blockingCount} Blueprint operation(s) were not exported.`,
          '# See "Manual Steps Required" in DEPLOY.md before relying on this site.',
        ]),
    '',
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'DRY_RUN=0',
    'ASSUME_YES=0',
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    --dry-run|-n) DRY_RUN=1 ;;',
    '    --yes|-y) ASSUME_YES=1 ;;',
    '    -h|--help)',
    '      echo "Usage: ./setup.sh [--dry-run] [--yes]"',
    '      echo "  --dry-run  Print the planned WP-CLI operations without running them."',
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
    '    printf "About to import materialized WordPress bundle (%s) into %s (WordPress root: %s).\\n" "$SCRIPT_DIR" "$SITE_URL" "$(pwd)"',
    "    read -r -p 'Continue? [y/N] ' REPLY",
    '    case "$REPLY" in',
    '      y|Y|yes|YES) ;;',
    '      *) echo "Aborted; nothing was changed."; exit 1 ;;',
    '    esac',
    '  fi',
  ];

  for (const muFile of muPluginFiles) {
    lines.push(
      `  if [ ! -f ${shellEscapeSingle(`./${muFile}`)} ]; then`,
      `    echo ${shellEscapeSingle(`WARNING: ./${muFile} not found in $(pwd). Copy wp-content/ from the bundle before running setup.sh so custom post types and abilities are registered.`)} >&2`,
      '  fi'
    );
  }
  lines.push('fi', '');

  // 1. Pre-import plugin/theme installs & activations (registers CPTs/taxonomies before WXR import)
  if (preImportCommands.length > 0) {
    lines.push('# 1. Install/activate declared WordPress.org plugins & themes before WXR import');
    for (const cmd of preImportCommands) {
      lines.push(`run ${cmd}`);
    }
    lines.push('');
  }

  if (activeThemeSlug) {
    lines.push(
      'if [ "$DRY_RUN" -eq 1 ]; then',
      `  run wp theme activate ${shellEscapeSingle(activeThemeSlug)}`,
      `elif wp theme is-installed ${shellEscapeSingle(activeThemeSlug)} >/dev/null 2>&1; then`,
      `  wp theme activate ${shellEscapeSingle(activeThemeSlug)}`,
      'fi',
      ''
    );
  }

  for (const pluginId of activePluginIds) {
    lines.push(
      'if [ "$DRY_RUN" -eq 1 ]; then',
      `  run wp plugin activate ${shellEscapeSingle(pluginId)}`,
      `elif ! wp plugin is-active ${shellEscapeSingle(pluginId)} >/dev/null 2>&1; then`,
      `  wp plugin activate ${shellEscapeSingle(pluginId)} || true`,
      'fi',
      ''
    );
  }

  // 2. Pre-create non-admin editorial users (never exporting password hashes) & build authors.csv
  if (users.length > 0) {
    lines.push('# 2. Ensure non-admin editorial users exist before WXR import (preserving post authorship)');
    for (const u of users) {
      const loginQ = shellEscapeSingle(u.user_login);
      const emailQ = shellEscapeSingle(u.user_email);
      const roleQ = shellEscapeSingle(u.role);
      const displayQ = shellEscapeSingle(u.display_name || u.user_login);
      lines.push(
        'if [ "$DRY_RUN" -eq 1 ]; then',
        `  printf '[dry-run] ensure user %s (%s)\\n' ${loginQ} ${roleQ}`,
        `elif ! wp user get ${loginQ} --field=ID >/dev/null 2>&1; then`,
        '  WPAI_TMP_PASS="$(wp eval \'echo wp_generate_password(24, true, true);\')"',
        `  wp user create ${loginQ} ${emailQ} --role=${roleQ} --display_name=${displayQ} --user_pass="$WPAI_TMP_PASS" >/dev/null`,
        '  unset WPAI_TMP_PASS',
        'fi'
      );
    }
    lines.push('');
  }

  // 3. Import content.wxr via pinned wordpress-importer with explicit author mapping & --skip=attachment
  lines.push('# 3. Import materialized content.wxr (idempotent duplicate detection; no remote Playground fetches)');
  lines.push(
    'if [ "$DRY_RUN" -eq 1 ]; then',
    `  run wp plugin install 'wordpress-importer' --version=${shellEscapeSingle(PINNED_WP_IMPORTER_VERSION)} --activate`,
    '  run wp import "$SCRIPT_DIR/content.wxr" --authors=authors.csv --skip=attachment',
    'else',
    "  if ! wp plugin is-installed 'wordpress-importer' >/dev/null 2>&1; then",
    `    wp plugin install 'wordpress-importer' --version=${shellEscapeSingle(PINNED_WP_IMPORTER_VERSION)} --activate`,
    "  elif ! wp plugin is-active 'wordpress-importer' >/dev/null 2>&1; then",
    "    wp plugin activate 'wordpress-importer'",
    '  fi',
    '  WPAI_AUTHORS_CSV="$(mktemp)"',
    '  trap \'rm -f "$WPAI_AUTHORS_CSV"\' EXIT',
    "  printf 'old_user_login,new_user_login\\n' > \"$WPAI_AUTHORS_CSV\"",
    "  if wp user get 'admin' --field=user_login >/dev/null 2>&1; then",
    "    WPAI_DEFAULT_AUTHOR='admin'",
    '  else',
    '    WPAI_DEFAULT_AUTHOR="$(wp user list --role=administrator --field=user_login --number=1)"',
    '  fi',
    '  if [ -n "$WPAI_DEFAULT_AUTHOR" ]; then',
    '    printf \'admin,%s\\n\' "$WPAI_DEFAULT_AUTHOR" >> "$WPAI_AUTHORS_CSV"',
    '  fi',
    ...users.map(
      (u) =>
        `  printf '%s,%s\\n' ${shellEscapeSingle(u.user_login)} ${shellEscapeSingle(u.user_login)} >> "$WPAI_AUTHORS_CSV"`
    ),
    '  wp import "$SCRIPT_DIR/content.wxr" --authors="$WPAI_AUTHORS_CSV" --skip=attachment',
    'fi',
    ''
  );

  // 4. Local attachment import (--skip-copy) & featured-image (_thumbnail_id) restoration
  if (attachments.length > 0) {
    lines.push('# 4. Restore local media attachments from copied wp-content/uploads/ (--skip-copy)');
    for (const att of attachments) {
      const slugQ = shellEscapeSingle(att.slug);
      const fileQ = shellEscapeSingle(`./${att.file}`);
      const titleQ = shellEscapeSingle(att.title || att.slug);
      const altQ = shellEscapeSingle(att.alt || '');
      lines.push(
        'if [ "$DRY_RUN" -eq 1 ]; then',
        `  run wp media import ${fileQ} --skip-copy --title=${titleQ} --alt=${altQ} --porcelain`,
        `elif [ -f ${fileQ} ]; then`,
        `  WPAI_ATT_ID="$(wp post list --post_type=attachment --post_status=any --name=${slugQ} --posts_per_page=1 --field=ID)"`,
        '  if [ -z "$WPAI_ATT_ID" ]; then',
        `    WPAI_ATT_ID="$(wp media import ${fileQ} --skip-copy --title=${titleQ} --alt=${altQ} --porcelain)"`,
        '  fi'
      );
      for (const ref of att.featured_for) {
        lines.push(
          '  if [ -n "$WPAI_ATT_ID" ]; then',
          `    WPAI_FEAT_POST="$(wp post list --post_type=${shellEscapeSingle(ref.post_type)} --post_status=publish --name=${shellEscapeSingle(ref.post_name)} --posts_per_page=1 --field=ID)"`,
          '    if [ -n "$WPAI_FEAT_POST" ]; then',
          '      wp post meta update "$WPAI_FEAT_POST" \'_thumbnail_id\' "$WPAI_ATT_ID" >/dev/null',
          '    fi',
          '  fi'
        );
      }
      lines.push('fi');
    }
    lines.push('');
  }

  // 5. Remap Playground origin URL to target site URL (excluding immutable WXR GUIDs)
  if (originUrl) {
    const originQ = shellEscapeSingle(originUrl);
    lines.push(
      '# 5. Remap Playground origin URL references in content and post meta',
      'if [ "$DRY_RUN" -eq 1 ]; then',
      `  printf '[dry-run] wp search-replace %s <target-home-url> --skip-columns=guid\\n' ${originQ}`,
      'else',
      '  WPAI_TARGET_HOME="$(wp option get home 2>/dev/null || wp option get siteurl 2>/dev/null || true)"',
      `  if [ -n "$WPAI_TARGET_HOME" ] && [ "$WPAI_TARGET_HOME" != ${originQ} ]; then`,
      `    wp search-replace ${originQ} "$WPAI_TARGET_HOME" --skip-columns=guid --quiet >/dev/null || true`,
      '  fi',
      'fi',
      ''
    );
  }

  // 6. Apply allowlisted site options & resolve front-page / posts-page IDs by slug
  if (optionCommands.length > 0) {
    lines.push('# 6. Apply allowlisted site options from wpai-state.json');
    for (const cmd of optionCommands) {
      lines.push(`run ${cmd}`);
    }
    lines.push('');
  }

  if (pageOnFrontSlug) {
    const slugQ = shellEscapeSingle(pageOnFrontSlug);
    lines.push(
      '# Resolve static front page ID by published page slug',
      'if [ "$DRY_RUN" -eq 1 ]; then',
      `  printf '[dry-run] resolve published page slug %s -> wp option update page_on_front <ID>\\n' ${slugQ}`,
      'else',
      `  WPAI_FRONT_ID="$(wp post list --post_type=page --post_status=publish --name=${slugQ} --posts_per_page=1 --field=ID)"`,
      '  if [ -n "$WPAI_FRONT_ID" ]; then',
      '    wp option update \'page_on_front\' "$WPAI_FRONT_ID"',
      '  else',
      `    echo "WARNING: Published front page with slug ${pageOnFrontSlug} was not found." >&2`,
      '  fi',
      'fi',
      ''
    );
  }

  if (pageForPostsSlug) {
    const slugQ = shellEscapeSingle(pageForPostsSlug);
    lines.push(
      '# Resolve posts page ID by published page slug',
      'if [ "$DRY_RUN" -eq 1 ]; then',
      `  printf '[dry-run] resolve published page slug %s -> wp option update page_for_posts <ID>\\n' ${slugQ}`,
      'else',
      `  WPAI_POSTS_ID="$(wp post list --post_type=page --post_status=publish --name=${slugQ} --posts_per_page=1 --field=ID)"`,
      '  if [ -n "$WPAI_POSTS_ID" ]; then',
      '    wp option update \'page_for_posts\' "$WPAI_POSTS_ID"',
      '  else',
      `    echo "WARNING: Published posts page with slug ${pageForPostsSlug} was not found." >&2`,
      '  fi',
      'fi',
      ''
    );
  }

  if (postImportWpCliCommands.length > 0) {
    lines.push('# Additional allowlisted Blueprint WP-CLI commands');
    for (const cmd of postImportWpCliCommands) {
      lines.push(`run ${cmd}`);
    }
    lines.push('');
  }

  lines.push(
    'run wp rewrite flush --hard || true',
    '',
    'if [ "$DRY_RUN" -eq 1 ]; then',
    '  echo "Dry run complete; nothing was changed."',
    '  exit 0',
    'fi',
    complete
      ? 'echo "Production WordPress provisioning complete."'
      : `echo "WARNING: incomplete export. ${blockingCount} Blueprint operation(s) were not applied; see Manual Steps Required in DEPLOY.md." >&2`,
    ''
  );

  return lines.join('\n');
}

function buildDeployMarkdown(params: {
  siteTitle: string;
  blueprintBasename: string;
  mode: 'static' | 'materialized';
  complete: boolean;
  blocking: SkippedStep[];
  nonBlocking: SkippedStep[];
  wpContentFiles: string[];
  wpCliCommandsCount: number;
  phpInventory: Array<{ file: string; sha256: string }>;
  secretWarnings: SecretScanWarning[];
  materializedSummary?: {
    usersCount: number;
    attachmentsCount: number;
    pageOnFrontSlug: string | null;
  };
}): string {
  const {
    siteTitle,
    blueprintBasename,
    mode,
    complete,
    blocking,
    nonBlocking,
    wpContentFiles,
    wpCliCommandsCount,
    phpInventory,
    secretWarnings,
    materializedSummary,
  } = params;

  const describeSkipped = (s: SkippedStep): string => `- \`${s.location}\` (\`${s.step}\`): ${s.reason}`;
  const manualSection = complete
    ? ''
    : `
> **Incomplete export.** ${blocking.length} Blueprint operation(s) could not be translated to production. This bundle was written only because \`--allow-partial\` was set. The production site will not match what \`wpai verify\` checked until you complete the steps below.

## Manual Steps Required

${blocking.map(describeSkipped).join('\n')}
`;

  const secretSection =
    secretWarnings.length === 0
      ? ''
      : `
> **Security review warning.** Potential credential/token pattern(s) were detected in ${secretWarnings.length} location(s) (${secretWarnings.map((w) => `\`${w.file}:${w.line}\` [${w.pattern}]`).join(', ')}). Inspect and remove any live secrets before deploying.
`;

  const phpInventorySection =
    phpInventory.length === 0
      ? ''
      : `
## PHP Code Inventory (\`wp-content/\` Review)

Review every bundled PHP file before copying to production:

${phpInventory.map((p) => `- \`${p.file}\` (\`sha256:${p.sha256}\`)`).join('\n')}
`;

  const playgroundOnlySection =
    nonBlocking.length === 0
      ? ''
      : `
## Not Exported (Playground-Only or Excluded, No Action Needed)

${nonBlocking.map(describeSkipped).join('\n')}
`;

  const materializedArtifacts =
    mode === 'materialized'
      ? `
- \`content.wxr\` — Materialized WordPress eXtended RSS export of pages, posts, custom post types, post meta, and taxonomies (zero raw \`runPHP\` replay on production).
- \`wpai-state.json\` — Declarative snapshot of allowlisted site options${materializedSummary?.pageOnFrontSlug ? ` (front page slug: \`${materializedSummary.pageOnFrontSlug}\`)` : ''}, ${materializedSummary?.usersCount ?? 0} non-admin editorial user(s), and ${materializedSummary?.attachmentsCount ?? 0} local media attachment mapping(s).`
      : '';

  return `# Production Deployment Handoff — ${siteTitle}

Exported by \`wpai export\` (${mode} mode) from \`${blueprintBasename}\`.
${manualSection}${secretSection}
## Included Artifacts

- \`wp-content/\` — ${wpContentFiles.length} extracted theme/plugin/mu-plugin/upload file(s) ready to copy into your production WordPress \`wp-content/\` directory. Symlinks, Playground SQLite drop-ins, and sensitive files (\`wp-config*.php\`, \`.env\`, \`*.sql\`, \`*.sqlite*\`, \`debug.log\`, keys) are never included.${materializedArtifacts}
- \`setup.sh\` — ${wpCliCommandsCount} WP-CLI provisioning command(s)${mode === 'materialized' ? ' plus idempotent WXR content, editorial user, and front-page import' : ' for options, plugins, and theme activation'}. Raw \`wp-cli\` steps are only included when they match the export allowlist.
- \`MANIFEST.sha256\` — SHA-256 checksums for every file in this bundle (\`sha256sum -c MANIFEST.sha256\`).
- \`blueprint.json\` — Original declarative WordPress Playground Blueprint for local preview and CI verification.
${phpInventorySection}${playgroundOnlySection}
## Production Checklist (MySQL / Managed Hosting)

1. **Verify bundle integrity:** Run \`(cd <bundle-dir> && sha256sum -c MANIFEST.sha256)\` and review any PHP files listed above.
2. **Provision WordPress on MySQL 8.0+ or MariaDB 10.11+** (managed host, VPS, or WordPress Studio sync) rather than Playground SQLite. On self-hosted Apache with WP-CLI, include \`apache_modules: [mod_rewrite]\` in \`wp-cli.yml\` so \`wp rewrite flush --hard\` writes \`.htaccess\`.
3. **Copy \`wp-content/\`** from this export bundle into your production WordPress \`wp-content/\` directory **before** running \`setup.sh\` so custom post types and taxonomies are registered during import.
4. **Preview with \`./setup.sh --dry-run\`**, then run \`./setup.sh\` from the production WordPress root (it asks for confirmation; use \`./setup.sh --yes\` in automation).${complete ? '' : '\n5. **Complete every item under Manual Steps Required** above.'}
${complete ? 5 : 6}. **Configure production secrets & payments:** Set real SMTP credentials, HTTPS/TLS certificates, payment gateway keys (Stripe/WooCommerce), and automated off-site backups.
${complete ? 6 : 7}. **Verify admin & editorial access:** Send password-reset links for any created editorial accounts and confirm \`wp_get_abilities()\` / REST routes return HTTP 200 (e.g. \`wpai verify-target <wp-root> --checks verify.json --url https://example.com\`).
`;
}

function writeSanitizedBlueprintCopy(
  blueprintPath: string,
  bp: Blueprint,
  sensitiveWriteSteps: Set<number>,
  bpOut: string
): void {
  if (sensitiveWriteSteps.size === 0) {
    fs.copyFileSync(blueprintPath, bpOut);
    return;
  }
  const sanitizedBp = structuredClone(bp);
  if (Array.isArray(sanitizedBp.steps)) {
    for (const idx of sensitiveWriteSteps) {
      const s = sanitizedBp.steps[idx];
      if (s && typeof s === 'object') {
        s.data = '[REDACTED by wpai export: sensitive file excluded]';
      }
    }
  }
  fs.writeFileSync(bpOut, `${JSON.stringify(sanitizedBp, null, 2)}\n`, 'utf8');
}

function collectPhpInventory(stageDir: string, wpContentFiles: string[]): Array<{ file: string; sha256: string }> {
  return wpContentFiles
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => f.toLowerCase().endsWith('.php'))
    .sort()
    .map((rel) => ({
      file: rel,
      sha256: sha256File(path.join(stageDir, ...rel.split('/'))),
    }));
}

/**
 * Stage 1 synchronous static exporter (zero Playground boot; fails safe on `runPHP` unless `allowPartial: true`).
 */
export function exportForProduction(options: ExportOptions): ExportResult {
  const plan = analyzeBlueprintStatic(options.target, options.outDir, { materializeMode: false });
  const {
    blueprintPath,
    baseDir,
    bp,
    outDir,
    wpCliCommands,
    skippedSteps,
    pendingWrites,
    pendingDirs,
    sensitiveWriteSteps,
    localWpContent,
    filesToCopy,
  } = plan;

  const blocking = skippedSteps.filter((s) => s.blocking);
  const complete = blocking.length === 0;
  const ok = complete || options.allowPartial === true;

  if (!ok) {
    return {
      ok: false,
      complete: false,
      mode: 'static',
      source_blueprint: blueprintPath,
      out_dir: outDir,
      wp_content_files: [],
      wp_cli_commands: wpCliCommands,
      skipped_steps: skippedSteps,
      secret_warnings: [],
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
  let secretWarnings: SecretScanWarning[] = [];

  try {
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

    const bpOut = path.join(stageDir, 'blueprint.json');
    writeSanitizedBlueprintCopy(blueprintPath, bp, sensitiveWriteSteps, bpOut);
    filesWritten.push('blueprint.json');

    const setupShPath = path.join(stageDir, 'setup.sh');
    fs.writeFileSync(setupShPath, buildStaticSetupScript(wpCliCommands, complete, blocking.length), 'utf8');
    fs.chmodSync(setupShPath, 0o755);
    filesWritten.push('setup.sh');

    for (const f of wpContentFiles) {
      filesWritten.push(f);
    }

    secretWarnings = scanStageDirectorySecrets(
      stageDir,
      filesWritten.map((f) => f.split(path.sep).join('/'))
    );
    const phpInventory = collectPhpInventory(stageDir, wpContentFiles);

    const siteTitle =
      (bp.meta && typeof bp.meta.title === 'string' && bp.meta.title) ||
      (bp.siteOptions && typeof bp.siteOptions.blogname === 'string' && bp.siteOptions.blogname) ||
      'WordPress Site';
    const deployMd = buildDeployMarkdown({
      siteTitle,
      blueprintBasename: path.basename(blueprintPath),
      mode: 'static',
      complete,
      blocking,
      nonBlocking: skippedSteps.filter((s) => !s.blocking),
      wpContentFiles,
      wpCliCommandsCount: wpCliCommands.length,
      phpInventory,
      secretWarnings,
    });
    fs.writeFileSync(path.join(stageDir, 'DEPLOY.md'), deployMd, 'utf8');
    filesWritten.push('DEPLOY.md');

    writeSha256Manifest(stageDir, filesWritten);

    fs.rmSync(outDir, { recursive: true, force: true });
    fs.renameSync(stageDir, outDir);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }

  return {
    ok: true,
    complete,
    mode: 'static',
    source_blueprint: blueprintPath,
    out_dir: outDir,
    wp_content_files: wpContentFiles.sort(),
    wp_cli_commands: wpCliCommands,
    skipped_steps: skippedSteps,
    secret_warnings: secretWarnings,
    files_written: filesWritten.sort(),
  };
}

/**
 * Stage 2 production exporter supporting `'auto'` (default), `'materialized'`, and `'static'` modes.
 *
 * When a Blueprint contains `runPHP`, `runPHPWithOptions`, or `importWxr` steps (or `mode === 'materialized'`),
 * boots the Blueprint inside an isolated WordPress Playground WASM sandbox, extracts `content.wxr`,
 * declarative `wpai-state.json`, and added/modified `wp-content/` files, and generates an injection-safe,
 * idempotent `setup.sh` + `MANIFEST.sha256` + `DEPLOY.md` with zero raw PHP replay on production.
 */
export async function exportProjectForProduction(
  options: MaterializedExportOptions
): Promise<ExportResult> {
  const requestedMode: ExportMode = options.mode ?? 'auto';
  if (requestedMode === 'static') {
    return exportForProduction(options);
  }

  const preflight = analyzeBlueprintStatic(options.target, options.outDir, { materializeMode: true });
  if (requestedMode === 'auto' && !preflight.hasMaterializableSteps) {
    return exportForProduction(options);
  }

  const {
    blueprintPath,
    baseDir,
    bp,
    outDir,
    wpContentOut,
    preImportCommands,
    postImportWpCliCommands,
    explicitOptionKeys,
    skippedSteps,
    pendingWrites,
    pendingDirs,
    sensitiveWriteSteps,
    localWpContent,
    filesToCopy,
  } = preflight;

  const skip = (location: string, step: string, reason: string, blocking = true): void => {
    skippedSteps.push({ location, step, reason, blocking });
  };

  // Fast fail before booting Playground if host-level untranslatable operations exist without allowPartial
  const preflightBlocking = skippedSteps.filter((s) => s.blocking);
  if (preflightBlocking.length > 0 && options.allowPartial !== true) {
    return {
      ok: false,
      complete: false,
      mode: 'materialized',
      source_blueprint: blueprintPath,
      out_dir: outDir,
      wp_content_files: [],
      wp_cli_commands: [...preImportCommands, ...postImportWpCliCommands],
      skipped_steps: skippedSteps,
      secret_warnings: [],
      files_written: [],
    };
  }

  if (outDir === path.parse(outDir).root || outDir === baseDir || isInside(outDir, baseDir)) {
    throw new Error(`Export output directory (${outDir}) must be distinct from the source project directory (${baseDir}).`);
  }

  // Boot Blueprint inside isolated WordPress Playground WASM sandbox to materialize content & state
  const bundledPaths = new Set<string>();
  collectBundledResourcePaths(bp, bundledPaths);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wpai-materialize-'));
  const bpDir = path.join(tmpRoot, 'bp');
  const pgOutDir = path.join(tmpRoot, 'out');
  fs.mkdirSync(bpDir, { recursive: true });
  fs.mkdirSync(pgOutDir, { recursive: true });

  let rawState: MaterializedState;
  let wxrContent: string;
  const extractedWpContentDir = path.join(pgOutDir, 'wp-content');

  try {
    if (bundledPaths.size > 0) {
      copyBundledAssets(baseDir, bpDir, bundledPaths);
    }

    const { mountArgs, mountedPrefixes } = stageLocalWpContentMounts(baseDir, tmpRoot);

    const preBody = stripPhpOpenTag(fs.readFileSync(findPhpAssetPath('materialize-presnapshot.php'), 'utf8'));
    const postBody = stripPhpOpenTag(fs.readFileSync(findPhpAssetPath('materialize-extract.php'), 'utf8'));

    const preStep: BlueprintStep = {
      step: 'runPHP',
      code: `<?php\n$wpai_mounted_prefixes = json_decode(${JSON.stringify(JSON.stringify(mountedPrefixes))}, true);\n$wpai_presnapshot_path = '/wpai-out/pre-snapshot.json';\n${preBody}`,
    };
    const postStep: BlueprintStep = {
      step: 'runPHP',
      code: `<?php\n$wpai_explicit_option_keys = json_decode(${JSON.stringify(JSON.stringify(explicitOptionKeys))}, true);\n$wpai_presnapshot_path = '/wpai-out/pre-snapshot.json';\n$wpai_out_dir = '/wpai-out';\n${postBody}`,
    };

    const augmented: Blueprint = structuredClone(bp);
    augmented.steps = [preStep, ...(augmented.steps ?? []), postStep];

    const augmentedPath = path.join(bpDir, 'blueprint.json');
    fs.writeFileSync(augmentedPath, `${JSON.stringify(augmented, null, 2)}\n`, 'utf8');

    const pg = findPlaygroundCli();
    const args = [
      ...pg.baseArgs,
      'run-blueprint',
      `--blueprint=${augmentedPath}`,
      `--mount=${pgOutDir}:/wpai-out`,
      '--verbosity=quiet',
      ...mountArgs,
    ];
    if (bundledPaths.size > 0) {
      args.push('--blueprint-may-read-adjacent-files');
    }
    if (options.wp) {
      args.push(`--wp=${options.wp}`);
    }
    if (options.php) {
      args.push(`--php=${options.php}`);
    }

    const timeoutMs = options.timeoutMs ?? 90000;
    const res = await runSubprocess(pg.command, args, {
      inheritStdio: false,
      timeoutMs,
    });

    if (res.timedOut) {
      throw new Error(`WordPress Playground materialization timed out after ${timeoutMs}ms.`);
    }

    const extractResFile = path.join(pgOutDir, 'extract-result.json');
    const stateFile = path.join(pgOutDir, 'wpai-state.json');
    const wxrFile = path.join(pgOutDir, 'content.wxr');

    if (!fs.existsSync(extractResFile)) {
      const detail = (res.stderr || res.stdout || `exit code ${String(res.code)}`).trim();
      throw new Error(`WordPress Playground exited without producing materialized artifacts: ${detail.slice(0, 600)}`);
    }

    const extractRes = JSON.parse(fs.readFileSync(extractResFile, 'utf8')) as {
      ok: boolean;
      symlinks?: string[];
      custom_tables?: string[];
      error?: string | null;
    };
    if (!extractRes.ok || !fs.existsSync(stateFile) || !fs.existsSync(wxrFile)) {
      throw new Error(`Materialized extraction failed inside Playground: ${extractRes.error ?? 'missing output files'}`);
    }

    for (const sym of extractRes.symlinks ?? []) {
      skip(sym, 'wp-content', 'Symbolic link inside Playground wp-content/ was not followed.');
    }

    rawState = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as MaterializedState;
    wxrContent = fs.readFileSync(wxrFile, 'utf8');

    if (Array.isArray(rawState.custom_tables) && rawState.custom_tables.length > 0) {
      skip(
        'database',
        'runPHP',
        `Custom non-core database table(s) (${rawState.custom_tables.join(', ')}) are not captured by WXR; migrate their schema and rows manually.`
      );
    }

    // Validate & sanitize every extracted state field on the Node host before staging
    const sanitizedOptions: Record<string, unknown> = {};
    const optionCommands: string[] = [];
    for (const [k, v] of Object.entries(rawState.options ?? {})) {
      if (isSensitiveOptionKey(k)) {
        // Explicit sensitive keys were already recorded in preflight; silently drop implicit runtime ones
        continue;
      }
      const cmd = formatOptionUpdateCommand('wpai-state.options', 'wpai-state', k, v, skip);
      if (cmd) {
        sanitizedOptions[k] = v;
        optionCommands.push(cmd);
      }
    }

    const sanitizedUsers: MaterializedUser[] = [];
    for (const u of rawState.users ?? []) {
      if (
        !u ||
        typeof u.user_login !== 'string' ||
        typeof u.user_email !== 'string' ||
        typeof u.role !== 'string'
      ) {
        continue;
      }
      const role = u.role.trim().toLowerCase();
      if (role === 'administrator' || role === 'super_admin' || !SLUG_RE.test(role)) {
        skip(`users[${u.user_login}]`, 'runPHP', `User "${u.user_login}" has privileged or invalid role "${u.role}" and was not exported.`);
        continue;
      }
      if (!USER_LOGIN_RE.test(u.user_login) || !USER_EMAIL_RE.test(u.user_email)) {
        skip(`users[${u.user_login}]`, 'runPHP', `User "${u.user_login}" has an unsafe login or email format and was not exported.`);
        continue;
      }
      const cleanDisplay = (typeof u.display_name === 'string' ? u.display_name : u.user_login).replace(/[\0\r\n]/g, '').trim();
      if (cleanDisplay.startsWith('--')) {
        skip(`users[${u.user_login}]`, 'runPHP', `User "${u.user_login}" display_name starts with "--" and was not exported.`);
        continue;
      }
      sanitizedUsers.push({
        user_login: u.user_login,
        user_email: u.user_email,
        display_name: cleanDisplay || u.user_login,
        role,
      });
    }

    const pageOnFrontSlug =
      typeof rawState.page_on_front_slug === 'string' && POST_SLUG_RE.test(rawState.page_on_front_slug)
        ? rawState.page_on_front_slug
        : null;
    const pageForPostsSlug =
      typeof rawState.page_for_posts_slug === 'string' && POST_SLUG_RE.test(rawState.page_for_posts_slug)
        ? rawState.page_for_posts_slug
        : null;

    const activeThemeSlug =
      rawState.active_theme?.changed &&
      typeof rawState.active_theme.stylesheet === 'string' &&
      SLUG_RE.test(rawState.active_theme.stylesheet)
        ? rawState.active_theme.stylesheet
        : null;

    const activePluginIds = (rawState.active_plugins ?? []).filter(
      (id) => typeof id === 'string' && isValidPluginIdentifier(id)
    );

    const originUrl =
      typeof rawState.origin_url === 'string' && SAFE_ORIGIN_URL_RE.test(rawState.origin_url)
        ? rawState.origin_url
        : null;

    // Plan files extracted from Playground's /wordpress/wp-content/
    const extractedFiles: string[] = [];
    if (fs.existsSync(extractedWpContentDir)) {
      planWpContentCopy(extractedWpContentDir, '', extractedFiles, skip);
    }

    const blocking = skippedSteps.filter((s) => s.blocking);
    const complete = blocking.length === 0;
    const ok = complete || options.allowPartial === true;
    const allWpCliCommands = [...preImportCommands, ...optionCommands, ...postImportWpCliCommands];

    if (!ok) {
      return {
        ok: false,
        complete: false,
        mode: 'materialized',
        source_blueprint: blueprintPath,
        out_dir: outDir,
        wp_content_files: [],
        wp_cli_commands: allWpCliCommands,
        skipped_steps: skippedSteps,
        secret_warnings: [],
        files_written: [],
      };
    }

    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    const stageDir = fs.mkdtempSync(path.join(path.dirname(outDir), `.wpai-export-${path.basename(outDir)}-`));
    const stageWpContent = path.join(stageDir, 'wp-content');
    const wpContentFilesSet = new Set<string>();
    const filesWritten: string[] = [];
    let secretWarnings: SecretScanWarning[] = [];
    const sanitizedAttachments: MaterializedAttachment[] = [];

    try {
      // 1. Copy Playground-materialized wp-content/ files (includes runPHP-created uploads/themes/plugins/mu-plugins)
      for (const rel of extractedFiles) {
        if (!isInside(wpContentOut, rel)) continue;
        const dst = path.join(stageWpContent, ...rel.split('/'));
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(extractedWpContentDir, ...rel.split('/')), dst);
        wpContentFilesSet.add(path.relative(stageDir, dst));
      }

      // 2. Overlay local sibling wp-content/ files and explicit mkdir / literal writeFile steps
      for (const rel of filesToCopy) {
        const dst = path.join(stageWpContent, ...rel.split('/'));
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(localWpContent, ...rel.split('/')), dst);
        wpContentFilesSet.add(path.relative(stageDir, dst));
      }
      for (const relInside of pendingDirs) {
        fs.mkdirSync(path.join(stageWpContent, relInside), { recursive: true });
      }
      for (const { rel: relInside, content } of pendingWrites) {
        const targetFile = path.join(stageWpContent, relInside);
        fs.mkdirSync(path.dirname(targetFile), { recursive: true });
        fs.writeFileSync(targetFile, content, 'utf8');
        wpContentFilesSet.add(path.relative(stageDir, targetFile));
      }

      const wpContentFiles = Array.from(wpContentFilesSet).sort();

      // 3. Validate attachments against staged wp-content/uploads/
      for (const att of rawState.attachments ?? []) {
        if (
          !att ||
          typeof att.slug !== 'string' ||
          !POST_SLUG_RE.test(att.slug) ||
          typeof att.file !== 'string' ||
          !att.file.startsWith('wp-content/uploads/')
        ) {
          continue;
        }
        const relUpload = safeWpContentRel(`/wordpress/${att.file}`, false);
        if (!relUpload || !relUpload.startsWith('uploads/')) continue;
        const stagedAttPath = path.join(stageWpContent, ...relUpload.split('/'));
        if (!fs.existsSync(stagedAttPath)) continue;
        const featuredFor = Array.isArray(att.featured_for)
          ? att.featured_for.filter(
              (f) =>
                f &&
                typeof f.post_type === 'string' &&
                SLUG_RE.test(f.post_type) &&
                typeof f.post_name === 'string' &&
                POST_SLUG_RE.test(f.post_name)
            )
          : [];
        sanitizedAttachments.push({
          slug: att.slug,
          title: typeof att.title === 'string' ? att.title.replace(/[\0\r\n]/g, '') : att.slug,
          alt: typeof att.alt === 'string' ? att.alt.replace(/[\0\r\n]/g, '') : '',
          file: `wp-content/${relUpload}`,
          featured_for: featuredFor,
        });
      }

      const cleanState: MaterializedState = {
        schema_version: '1.0',
        wordpress_version: typeof rawState.wordpress_version === 'string' ? rawState.wordpress_version : '',
        origin_url: originUrl ?? '',
        options: sanitizedOptions,
        page_on_front_slug: pageOnFrontSlug,
        page_for_posts_slug: pageForPostsSlug,
        active_theme: {
          stylesheet:
            typeof rawState.active_theme?.stylesheet === 'string' && SLUG_RE.test(rawState.active_theme.stylesheet)
              ? rawState.active_theme.stylesheet
              : '',
          changed: Boolean(activeThemeSlug),
        },
        active_plugins: activePluginIds,
        users: sanitizedUsers,
        attachments: sanitizedAttachments,
        custom_tables: Array.isArray(rawState.custom_tables) ? rawState.custom_tables : [],
      };

      // 4. Write content.wxr, wpai-state.json, sanitized blueprint.json, and setup.sh
      fs.writeFileSync(path.join(stageDir, 'content.wxr'), wxrContent, 'utf8');
      filesWritten.push('content.wxr');

      fs.writeFileSync(path.join(stageDir, 'wpai-state.json'), `${JSON.stringify(cleanState, null, 2)}\n`, 'utf8');
      filesWritten.push('wpai-state.json');

      const bpOut = path.join(stageDir, 'blueprint.json');
      writeSanitizedBlueprintCopy(blueprintPath, bp, sensitiveWriteSteps, bpOut);
      filesWritten.push('blueprint.json');

      const muPluginFiles = wpContentFiles
        .map((f) => f.split(path.sep).join('/'))
        .filter((f) => f.startsWith('wp-content/mu-plugins/') && f.endsWith('.php'));

      const setupSh = buildMaterializedSetupScript({
        preImportCommands,
        optionCommands,
        postImportWpCliCommands,
        users: sanitizedUsers,
        attachments: sanitizedAttachments,
        pageOnFrontSlug,
        pageForPostsSlug,
        activeThemeSlug,
        activePluginIds,
        originUrl,
        muPluginFiles,
        complete,
        blockingCount: blocking.length,
      });
      const setupShPath = path.join(stageDir, 'setup.sh');
      fs.writeFileSync(setupShPath, setupSh, 'utf8');
      fs.chmodSync(setupShPath, 0o755);
      filesWritten.push('setup.sh');

      for (const f of wpContentFiles) {
        filesWritten.push(f);
      }

      secretWarnings = scanStageDirectorySecrets(
        stageDir,
        filesWritten.map((f) => f.split(path.sep).join('/'))
      );
      const phpInventory = collectPhpInventory(stageDir, wpContentFiles);

      const siteTitle =
        (typeof sanitizedOptions.blogname === 'string' && sanitizedOptions.blogname) ||
        (bp.meta && typeof bp.meta.title === 'string' && bp.meta.title) ||
        'WordPress Site';
      const deployMd = buildDeployMarkdown({
        siteTitle,
        blueprintBasename: path.basename(blueprintPath),
        mode: 'materialized',
        complete,
        blocking,
        nonBlocking: skippedSteps.filter((s) => !s.blocking),
        wpContentFiles,
        wpCliCommandsCount: allWpCliCommands.length,
        phpInventory,
        secretWarnings,
        materializedSummary: {
          usersCount: sanitizedUsers.length,
          attachmentsCount: sanitizedAttachments.length,
          pageOnFrontSlug,
        },
      });
      fs.writeFileSync(path.join(stageDir, 'DEPLOY.md'), deployMd, 'utf8');
      filesWritten.push('DEPLOY.md');

      writeSha256Manifest(stageDir, filesWritten);

      fs.rmSync(outDir, { recursive: true, force: true });
      fs.renameSync(stageDir, outDir);
    } finally {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }

    return {
      ok: true,
      complete,
      mode: 'materialized',
      source_blueprint: blueprintPath,
      out_dir: outDir,
      wp_content_files: Array.from(wpContentFilesSet).sort(),
      wp_cli_commands: allWpCliCommands,
      skipped_steps: skippedSteps,
      secret_warnings: secretWarnings,
      files_written: filesWritten.sort(),
      materialized: {
        wxr_file: 'content.wxr',
        state_file: 'wpai-state.json',
        users_count: sanitizedUsers.length,
        attachments_count: sanitizedAttachments.length,
        page_on_front_slug: pageOnFrontSlug,
        page_for_posts_slug: pageForPostsSlug,
      },
    };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}
