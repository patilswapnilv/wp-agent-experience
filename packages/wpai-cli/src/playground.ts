import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findPlaygroundCli,
  findVerifyProbePhpPath,
  resolveBlueprintTarget,
} from './paths.js';
import type {
  Blueprint,
  ValidationResult,
  VerifyCheckResult,
  VerifyReport,
  VerifySpec,
} from './types.js';
import { validateBlueprintFile } from './validator.js';

export interface BootOptions {
  headless?: boolean;
  port?: number;
  wp?: string;
  php?: string;
  json?: boolean;
}

export interface BootResult {
  ok: boolean;
  mode: 'headless' | 'server';
  blueprint: string;
  exit_code: number | null;
  duration_ms: number;
  validation: ValidationResult;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface VerifyOptions {
  checksPath?: string;
  timeoutMs?: number;
  wp?: string;
  php?: string;
}

export interface VerifyTargetOptions {
  /** Local WordPress installation root directory (passed to `wp --path=<wpPath>`). */
  wpPath: string;
  /** Path to `verify.json` contract. */
  checksPath: string;
  /** Optional live base URL (e.g. `http://127.0.0.1:8080`) for real HTTP checks over /, pages, and /wp-json. */
  url?: string;
  /** Optional custom `wp` binary command (defaults to `wp`). */
  wpCommand?: string;
  /** Optional extra args before `eval-file` (e.g. `['--allow-root']` inside Docker containers). */
  wpArgs?: string[];
  timeoutMs?: number;
}

/**
 * Strip a leading `<?php` tag so a standalone `.php` file can be prefixed with inline variables
 * for WordPress Playground `runPHP` steps.
 */
export function stripPhpOpenTag(phpSource: string): string {
  return phpSource.replace(/^\s*<\?php\b/, '');
}

/**
 * Recursively collect all `bundled` resource relative paths from a Blueprint object.
 */
export function collectBundledResourcePaths(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectBundledResourcePaths(item, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (obj.resource === 'bundled' && typeof obj.path === 'string' && obj.path.trim().length > 0) {
    out.add(obj.path.trim());
  }
  for (const val of Object.values(obj)) {
    collectBundledResourcePaths(val, out);
  }
}

export function copyBundledAssets(
  baseDir: string,
  destDir: string,
  bundledPaths: Set<string>
): void {
  const resolvedBase = path.resolve(baseDir);
  for (const rel of bundledPaths) {
    const cleanRel = rel.replace(/^\/+/, '');
    const src = path.resolve(resolvedBase, cleanRel);
    if (!src.startsWith(resolvedBase + path.sep) && src !== resolvedBase) {
      throw new Error(`Bundled resource path escapes blueprint directory: ${rel}`);
    }
    if (!fs.existsSync(src)) {
      throw new Error(`Referenced bundled resource does not exist: ${src}`);
    }
    const dest = path.resolve(destDir, cleanRel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
  }
}

/**
 * Stage sibling `wp-content/themes/*`, `wp-content/plugins/*`, and `wp-content/mu-plugins/` into
 * `tmpRoot` (so host directories are never mutated by Playground) and return `--mount=...` flags
 * plus the mounted relative prefixes inside `/wordpress/wp-content/`.
 */
export function stageLocalWpContentMounts(
  baseDir: string,
  tmpRoot: string
): { mountArgs: string[]; mountedPrefixes: string[] } {
  const mountArgs: string[] = [];
  const mountedPrefixes: string[] = [];
  const localWpContent = path.join(baseDir, 'wp-content');
  const rootStat = fs.lstatSync(localWpContent, { throwIfNoEntry: false });
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { mountArgs, mountedPrefixes };
  }

  const mountStage = path.join(tmpRoot, 'wp-content');
  for (const kind of ['themes', 'plugins'] as const) {
    const kindDir = path.join(localWpContent, kind);
    const kindStat = fs.lstatSync(kindDir, { throwIfNoEntry: false });
    if (kindStat && !kindStat.isSymbolicLink() && kindStat.isDirectory()) {
      for (const entry of fs.readdirSync(kindDir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const entryPath = path.join(kindDir, entry.name);
        const entryStat = fs.lstatSync(entryPath, { throwIfNoEntry: false });
        if (!entryStat || entryStat.isSymbolicLink() || !entryStat.isDirectory()) continue;
        const dst = path.join(mountStage, kind, entry.name);
        fs.cpSync(entryPath, dst, { recursive: true, dereference: false });
        mountArgs.push(`--mount=${dst}:/wordpress/wp-content/${kind}/${entry.name}`);
        mountedPrefixes.push(`${kind}/${entry.name}`);
      }
    }
  }
  const muDir = path.join(localWpContent, 'mu-plugins');
  const muStat = fs.lstatSync(muDir, { throwIfNoEntry: false });
  if (muStat && !muStat.isSymbolicLink() && muStat.isDirectory()) {
    const muDst = path.join(mountStage, 'mu-plugins');
    fs.cpSync(muDir, muDst, { recursive: true, dereference: false });
    mountArgs.push(`--mount=${muDst}:/wordpress/wp-content/mu-plugins`);
    mountedPrefixes.push('mu-plugins');
  }
  return { mountArgs, mountedPrefixes };
}

export function buildVerifyPhpScript(spec: VerifySpec): string {
  const specB64 = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');
  const probeBody = stripPhpOpenTag(fs.readFileSync(findVerifyProbePhpPath(), 'utf8'));
  return `<?php\n$wpai_inline_spec_b64 = '${specB64}';\n$wpai_report_path = '/wpai-out/report.json';\n${probeBody}`;
}

export function runSubprocess(
  command: string,
  args: string[],
  options: {
    inheritStdio: boolean;
    timeoutMs?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: options.inheritStdio ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: options.env ?? process.env,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const onSigInt = () => child.kill('SIGINT');
    const onSigTerm = () => child.kill('SIGTERM');

    if (options.inheritStdio) {
      process.on('SIGINT', onSigInt);
      process.on('SIGTERM', onSigTerm);
    }

    if (!options.inheritStdio) {
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
    }

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3000).unref();
      }, options.timeoutMs);
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (options.inheritStdio) {
        process.off('SIGINT', onSigInt);
        process.off('SIGTERM', onSigTerm);
      }
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (options.inheritStdio) {
        process.off('SIGINT', onSigInt);
        process.off('SIGTERM', onSigTerm);
      }
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

export async function bootBlueprint(
  dirOrBlueprint: string,
  options: BootOptions = {}
): Promise<BootResult> {
  const started = Date.now();
  const { blueprintPath } = resolveBlueprintTarget(dirOrBlueprint);
  const validation = validateBlueprintFile(blueprintPath);
  const mode: 'headless' | 'server' = options.headless ? 'headless' : 'server';

  if (!validation.valid) {
    return {
      ok: false,
      mode,
      blueprint: blueprintPath,
      exit_code: 1,
      duration_ms: Date.now() - started,
      validation,
      error: 'Blueprint failed validation before boot.',
    };
  }

  const blueprintObj = JSON.parse(fs.readFileSync(blueprintPath, 'utf8')) as Blueprint;
  const bundled = new Set<string>();
  collectBundledResourcePaths(blueprintObj, bundled);

  const pg = findPlaygroundCli();
  const subcommand = options.headless ? 'run-blueprint' : 'server';
  const args = [
    ...pg.baseArgs,
    subcommand,
    `--blueprint=${blueprintPath}`,
  ];

  if (!options.headless) {
    args.push(`--port=${options.port ?? 9400}`);
  }
  if (bundled.size > 0) {
    args.push('--blueprint-may-read-adjacent-files');
  }
  if (options.wp) {
    args.push(`--wp=${options.wp}`);
  }
  if (options.php) {
    args.push(`--php=${options.php}`);
  }
  if (options.json) {
    args.push('--verbosity=quiet');
  }

  const res = await runSubprocess(pg.command, args, {
    inheritStdio: !options.json && !options.headless,
  });

  return {
    ok: res.code === 0,
    mode,
    blueprint: blueprintPath,
    exit_code: res.code,
    duration_ms: Date.now() - started,
    validation,
    ...(options.json || options.headless
      ? { stdout: res.stdout, stderr: res.stderr }
      : {}),
  };
}

export async function verifyBlueprint(
  dirOrBlueprint: string,
  options: VerifyOptions = {}
): Promise<VerifyReport> {
  const started = Date.now();
  const { blueprintPath, baseDir, verifySpecPath } = resolveBlueprintTarget(
    dirOrBlueprint,
    options.checksPath
  );

  const emptyReport = (
    checks: VerifyCheckResult[],
    error?: string
  ): VerifyReport => ({
    ok: false,
    blueprint: blueprintPath,
    checks_file: verifySpecPath,
    duration_ms: Date.now() - started,
    wordpress_loaded: false,
    wordpress_version: null,
    php_version: null,
    blogname: null,
    active_theme: null,
    active_plugins: [],
    mu_plugins: [],
    abilities_api: false,
    registered_abilities_count: 0,
    counts: {
      pages: 0,
      posts: 0,
      post_types: {},
      categories: 0,
      users: 0,
    },
    rest_api: {
      types_status: null,
      routes: {},
    },
    php_last_error: null,
    checks,
    ...(error ? { error } : {}),
  });

  const validation = validateBlueprintFile(blueprintPath);
  if (!validation.valid) {
    return emptyReport(
      validation.errors.map((e) => ({
        name: `blueprint_validation:${e.code}`,
        passed: false,
        detail: `${e.path}: ${e.message}`,
      })),
      'Blueprint failed static validation before verification.'
    );
  }

  let verifySpec: VerifySpec = {};
  if (verifySpecPath) {
    try {
      verifySpec = JSON.parse(fs.readFileSync(verifySpecPath, 'utf8')) as VerifySpec;
    } catch (err) {
      return emptyReport(
        [
          {
            name: 'verify_spec_parse',
            passed: false,
            detail: `Failed to parse verify spec ${verifySpecPath}: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        'Invalid verify.json file.'
      );
    }
  }

  const originalBlueprint = JSON.parse(
    fs.readFileSync(blueprintPath, 'utf8')
  ) as Blueprint;
  const bundledPaths = new Set<string>();
  collectBundledResourcePaths(originalBlueprint, bundledPaths);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wpai-verify-'));
  const bpDir = path.join(tmpRoot, 'bp');
  const outDir = path.join(tmpRoot, 'out');
  fs.mkdirSync(bpDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  try {
    if (bundledPaths.size > 0) {
      copyBundledAssets(baseDir, bpDir, bundledPaths);
    }

    const augmented: Blueprint = structuredClone(originalBlueprint);
    const verifyStep = {
      step: 'runPHP',
      code: buildVerifyPhpScript(verifySpec),
    };
    augmented.steps = [...(augmented.steps ?? []), verifyStep];

    const augmentedPath = path.join(bpDir, 'blueprint.json');
    fs.writeFileSync(
      augmentedPath,
      `${JSON.stringify(augmented, null, 2)}\n`,
      'utf8'
    );

    const pg = findPlaygroundCli();
    const args = [
      ...pg.baseArgs,
      'run-blueprint',
      `--blueprint=${augmentedPath}`,
      `--mount=${outDir}:/wpai-out`,
      '--verbosity=quiet',
    ];
    const { mountArgs } = stageLocalWpContentMounts(baseDir, tmpRoot);
    args.push(...mountArgs);
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

    const reportFile = path.join(outDir, 'report.json');
    if (res.timedOut) {
      return emptyReport(
        [
          {
            name: 'playground_timeout',
            passed: false,
            detail: `WordPress Playground verification timed out after ${timeoutMs}ms`,
          },
        ],
        `Verification timed out after ${timeoutMs}ms`
      );
    }

    if (!fs.existsSync(reportFile)) {
      const detail = (res.stderr || res.stdout || `exit code ${String(res.code)}`).trim();
      return emptyReport(
        [
          {
            name: 'playground_execution',
            passed: false,
            detail: `Playground exited (${String(res.code)}) without writing /wpai-out/report.json: ${detail.slice(0, 600)}`,
          },
        ],
        'Verification report was not produced by WordPress Playground.'
      );
    }

    const parsed = JSON.parse(
      fs.readFileSync(reportFile, 'utf8')
    ) as Omit<VerifyReport, 'blueprint' | 'checks_file' | 'duration_ms'>;

    return {
      ...parsed,
      blueprint: blueprintPath,
      checks_file: verifySpecPath,
      duration_ms: Date.now() - started,
    };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

/**
 * Verify a live MySQL/MariaDB WordPress target via the shared `verify-probe.php` (`wp eval-file`)
 * plus optional real HTTP checks against `options.url` (`/`, required pages, and `/wp-json/...`).
 */
export async function verifyTarget(options: VerifyTargetOptions): Promise<VerifyReport> {
  const started = Date.now();
  const wpPath = path.resolve(options.wpPath);
  const checksPath = path.resolve(options.checksPath);
  const probePath = findVerifyProbePhpPath();
  const timeoutMs = options.timeoutMs ?? 60000;

  if (!fs.existsSync(checksPath)) {
    throw new Error(`Verification checks file not found: ${checksPath}`);
  }
  const spec = JSON.parse(fs.readFileSync(checksPath, 'utf8')) as VerifySpec;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpai-verify-target-'));
  const reportFile = path.join(tmpDir, 'report.json');

  try {
    const wpCommand = options.wpCommand ?? 'wp';
    const wpArgs = [
      ...(options.wpArgs ?? []),
      `--path=${wpPath}`,
      'eval-file',
      probePath,
      checksPath,
    ];

    const res = await runSubprocess(wpCommand, wpArgs, {
      inheritStdio: false,
      timeoutMs,
      env: {
        ...process.env,
        WPAI_REPORT_PATH: reportFile,
      },
    });

    if (res.timedOut || !fs.existsSync(reportFile)) {
      const detail = res.timedOut
        ? `wp eval-file timed out after ${timeoutMs}ms`
        : (res.stderr || res.stdout || `exit code ${String(res.code)}`).trim();
      return {
        ok: false,
        blueprint: wpPath,
        checks_file: checksPath,
        duration_ms: Date.now() - started,
        wordpress_loaded: false,
        wordpress_version: null,
        php_version: null,
        blogname: null,
        active_theme: null,
        active_plugins: [],
        mu_plugins: [],
        abilities_api: false,
        registered_abilities_count: 0,
        counts: { pages: 0, posts: 0, post_types: {}, categories: 0, users: 0 },
        rest_api: { types_status: null, routes: {} },
        php_last_error: null,
        checks: [
          {
            name: 'wp_eval_file',
            passed: false,
            detail: detail.slice(0, 600),
          },
        ],
        error: 'Target verification probe failed to produce report.json.',
      };
    }

    const parsed = JSON.parse(
      fs.readFileSync(reportFile, 'utf8')
    ) as Omit<VerifyReport, 'blueprint' | 'checks_file' | 'duration_ms'>;

    const checks = [...parsed.checks];
    const httpChecks: Record<string, number> = {};

    if (options.url) {
      const baseUrl = options.url.replace(/\/+$/, '');
      const urlsToCheck: Array<{ name: string; path: string }> = [
        { name: 'http_home', path: '/' },
        { name: 'http_rest_types', path: '/wp-json/wp/v2/types' },
      ];
      for (const slug of spec.required_pages ?? []) {
        const cleanSlug = encodeURIComponent(slug.trim().toLowerCase());
        urlsToCheck.push({ name: `http_page:${slug}`, path: `/${cleanSlug}/` });
      }
      for (const route of spec.required_rest_routes ?? []) {
        const normRoute = route.startsWith('/') ? route : `/${route}`;
        urlsToCheck.push({ name: `http_rest:${route}`, path: `/wp-json${normRoute}` });
      }

      for (const item of urlsToCheck) {
        const fullUrl = `${baseUrl}${item.path}`;
        try {
          const resp = await fetch(fullUrl, {
            redirect: 'follow',
            headers: { connection: 'close' },
          });
          await resp.arrayBuffer();
          httpChecks[item.path] = resp.status;
          checks.push({
            name: item.name,
            passed: resp.status === 200,
            detail: `HTTP GET ${fullUrl} -> ${resp.status}`,
          });
        } catch (err) {
          httpChecks[item.path] = 0;
          checks.push({
            name: item.name,
            passed: false,
            detail: `HTTP GET ${fullUrl} failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }

    const allPassed = checks.every((c) => c.passed);
    return {
      ...parsed,
      ok: allPassed,
      checks,
      ...(options.url ? { http_checks: httpChecks } : {}),
      blueprint: wpPath,
      checks_file: checksPath,
      duration_ms: Date.now() - started,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
