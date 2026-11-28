import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findPlaygroundCli, resolveBlueprintTarget } from './paths.js';
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

/**
 * Recursively collect all `bundled` resource relative paths from a Blueprint object.
 */
function collectBundledResourcePaths(node: unknown, out: Set<string>): void {
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

function copyBundledAssets(
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

function buildVerifyPhpScript(spec: VerifySpec): string {
  const specB64 = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');

  return `<?php
$wpai_report_path = '/wpai-out/report.json';
$wpai_written = false;

register_shutdown_function( function () use ( &$wpai_report_path, &$wpai_written ) {
    if ( $wpai_written ) {
        return;
    }
    $err = error_get_last();
    $fallback = array(
        'ok' => false,
        'wordpress_loaded' => defined( 'ABSPATH' ),
        'wordpress_version' => function_exists( 'get_bloginfo' ) ? get_bloginfo( 'version' ) : null,
        'php_version' => PHP_VERSION,
        'blogname' => function_exists( 'get_option' ) ? get_option( 'blogname' ) : null,
        'active_theme' => null,
        'active_plugins' => array(),
        'mu_plugins' => array(),
        'abilities_api' => class_exists( 'WP_Ability' ),
        'registered_abilities_count' => 0,
        'counts' => array(
            'pages' => 0,
            'posts' => 0,
            'post_types' => array(),
            'categories' => 0,
            'users' => 0,
        ),
        'rest_api' => array(
            'types_status' => null,
            'routes' => array(),
        ),
        'php_last_error' => $err,
        'checks' => array(
            array(
                'name' => 'php_shutdown',
                'passed' => false,
                'detail' => $err ? ( $err['message'] . ' in ' . $err['file'] . ':' . $err['line'] ) : 'Verification script terminated unexpectedly',
            ),
        ),
    );
    @file_put_contents( $wpai_report_path, json_encode( $fallback, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) );
} );

if ( file_exists( '/wordpress/wp-load.php' ) ) {
    require_once '/wordpress/wp-load.php';
}

$spec = json_decode( base64_decode( '${specB64}' ), true );
if ( ! is_array( $spec ) ) {
    $spec = array();
}

$checks = array();
$add_check = function ( $name, $passed, $detail ) use ( &$checks ) {
    $checks[] = array(
        'name' => (string) $name,
        'passed' => (bool) $passed,
        'detail' => (string) $detail,
    );
};

$wp_loaded = defined( 'ABSPATH' ) && function_exists( 'get_bloginfo' );
$wp_version = $wp_loaded ? (string) get_bloginfo( 'version' ) : null;
$php_version = PHP_VERSION;
$add_check( 'wordpress_loaded', $wp_loaded, $wp_loaded ? "WordPress {$wp_version} on PHP {$php_version}" : 'WordPress failed to bootstrap' );

$blogname = $wp_loaded ? (string) get_option( 'blogname', '' ) : null;
$active_theme = null;
$active_plugins = array();
$mu_plugins = array();
$abilities_api = false;
$registered_abilities_count = 0;
$counts = array(
    'pages' => 0,
    'posts' => 0,
    'post_types' => array(),
    'categories' => 0,
    'users' => 0,
);
$rest_api = array(
    'types_status' => null,
    'routes' => array(),
);

if ( $wp_loaded ) {
    if ( file_exists( ABSPATH . 'wp-admin/includes/plugin.php' ) ) {
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
    }

    $theme = wp_get_theme();
    $active_theme = array(
        'stylesheet' => (string) $theme->get_stylesheet(),
        'name' => (string) $theme->get( 'Name' ),
    );

    $active_plugins = array_values( (array) get_option( 'active_plugins', array() ) );
    if ( function_exists( 'get_mu_plugins' ) ) {
        $mu_plugins = array_keys( get_mu_plugins() );
    }

    if ( ! empty( $spec['required_mu_plugins'] ) && is_array( $spec['required_mu_plugins'] ) ) {
        foreach ( $spec['required_mu_plugins'] as $req_mu ) {
            $mu_name = (string) $req_mu;
            $has_mu = in_array( $mu_name, $mu_plugins, true );
            $add_check(
                "required_mu_plugin:{$mu_name}",
                $has_mu,
                $has_mu ? "MU-plugin '{$mu_name}' is loaded" : "Missing required MU-plugin '{$mu_name}'"
            );
        }
    }

    // Abilities API (WordPress 6.9+)
    $abilities_api = class_exists( 'WP_Ability' );
    $registered_ability_names = array();
    if ( $abilities_api ) {
        try {
            if ( function_exists( 'wp_get_abilities' ) ) {
                $all_abilities = wp_get_abilities();
                if ( is_array( $all_abilities ) ) {
                    $registered_abilities_count = count( $all_abilities );
                    foreach ( $all_abilities as $ab_key => $ab_obj ) {
                        if ( is_string( $ab_key ) && $ab_key !== '' ) {
                            $registered_ability_names[ $ab_key ] = true;
                        }
                        if ( is_object( $ab_obj ) && method_exists( $ab_obj, 'get_name' ) ) {
                            $registered_ability_names[ (string) $ab_obj->get_name() ] = true;
                        }
                    }
                }
            } elseif ( class_exists( 'WP_Abilities_Registry' ) && method_exists( 'WP_Abilities_Registry', 'get_instance' ) ) {
                $reg = WP_Abilities_Registry::get_instance();
                if ( $reg && method_exists( $reg, 'get_all_registered' ) ) {
                    $all_reg = $reg->get_all_registered();
                    if ( is_array( $all_reg ) ) {
                        $registered_abilities_count = count( $all_reg );
                        foreach ( $all_reg as $ab_key => $ab_obj ) {
                            if ( is_string( $ab_key ) && $ab_key !== '' ) {
                                $registered_ability_names[ $ab_key ] = true;
                            }
                            if ( is_object( $ab_obj ) && method_exists( $ab_obj, 'get_name' ) ) {
                                $registered_ability_names[ (string) $ab_obj->get_name() ] = true;
                            }
                        }
                    }
                }
            }
        } catch ( \\Throwable $e ) {
            $registered_abilities_count = 0;
        }
    }

    if ( ! empty( $spec['require_abilities_api'] ) ) {
        $add_check(
            'abilities_api_available',
            $abilities_api,
            $abilities_api
                ? "WP_Ability available ({$registered_abilities_count} registered abilities)"
                : 'WP_Ability class not found (requires WordPress 6.9+)'
        );
    }

    if ( ! empty( $spec['required_abilities'] ) && is_array( $spec['required_abilities'] ) ) {
        foreach ( $spec['required_abilities'] as $req_ab ) {
            $ab_name = (string) $req_ab;
            $has_ab = $abilities_api && (
                isset( $registered_ability_names[ $ab_name ] ) ||
                ( function_exists( 'wp_has_ability' ) && wp_has_ability( $ab_name ) )
            );
            $add_check(
                "required_ability:{$ab_name}",
                $has_ab,
                $has_ab ? "Ability '{$ab_name}' is registered" : "Missing required ability '{$ab_name}'"
            );
        }
    }

    // Content counts
    $page_counts = wp_count_posts( 'page' );
    $post_counts = wp_count_posts( 'post' );
    $counts['pages'] = isset( $page_counts->publish ) ? (int) $page_counts->publish : 0;
    $counts['posts'] = isset( $post_counts->publish ) ? (int) $post_counts->publish : 0;

    $all_post_types = get_post_types( array(), 'names' );
    foreach ( $all_post_types as $pt ) {
        $c = wp_count_posts( $pt );
        $pub = isset( $c->publish ) ? (int) $c->publish : 0;
        if ( $pub > 0 || ! in_array( $pt, array( 'revision', 'nav_menu_item', 'custom_css', 'customize_changeset', 'oembed_cache', 'user_request', 'wp_block', 'wp_template', 'wp_template_part', 'wp_global_styles', 'wp_navigation', 'wp_font_family', 'wp_font_face' ), true ) ) {
            $counts['post_types'][ $pt ] = $pub;
        }
    }

    $cats = get_terms( array( 'taxonomy' => 'category', 'hide_empty' => false ) );
    $counts['categories'] = ( ! is_wp_error( $cats ) && is_array( $cats ) ) ? count( $cats ) : 0;

    $user_counts = count_users();
    $counts['users'] = isset( $user_counts['total_users'] ) ? (int) $user_counts['total_users'] : 0;

    // expected_blogname
    if ( isset( $spec['expected_blogname'] ) && is_string( $spec['expected_blogname'] ) && $spec['expected_blogname'] !== '' ) {
        $expected = $spec['expected_blogname'];
        $matched = ( $blogname === $expected );
        $add_check(
            'expected_blogname',
            $matched,
            $matched ? "blogname matches '{$expected}'" : "Expected blogname '{$expected}', got '{$blogname}'"
        );
    }

    // required_pages (match by slug or title, case-insensitive)
    if ( ! empty( $spec['required_pages'] ) && is_array( $spec['required_pages'] ) ) {
        $published_pages = get_posts( array(
            'post_type' => 'page',
            'post_status' => 'publish',
            'numberposts' => -1,
        ) );
        $slugs = array();
        $titles = array();
        foreach ( $published_pages as $p ) {
            $slugs[ strtolower( (string) $p->post_name ) ] = true;
            $titles[ strtolower( trim( (string) $p->post_title ) ) ] = true;
        }
        foreach ( $spec['required_pages'] as $req_page ) {
            $needle = strtolower( trim( (string) $req_page ) );
            $found = isset( $slugs[ $needle ] ) || isset( $titles[ $needle ] );
            $add_check(
                "required_page:{$req_page}",
                $found,
                $found ? "Published page '{$req_page}' exists" : "Missing required published page '{$req_page}'"
            );
        }
    }

    // required_posts_min (numeric post count or post_type => min map)
    if ( isset( $spec['required_posts_min'] ) ) {
        if ( is_numeric( $spec['required_posts_min'] ) ) {
            $min = (int) $spec['required_posts_min'];
            $ok_posts = $counts['posts'] >= $min;
            $add_check(
                'required_posts_min',
                $ok_posts,
                "Published posts: {$counts['posts']} (minimum required: {$min})"
            );
        } elseif ( is_array( $spec['required_posts_min'] ) ) {
            foreach ( $spec['required_posts_min'] as $pt_key => $pt_min ) {
                if ( ! is_string( $pt_key ) || ! is_numeric( $pt_min ) ) {
                    continue;
                }
                $min_pt = (int) $pt_min;
                if ( isset( $counts['post_types'][ $pt_key ] ) ) {
                    $actual_pt = (int) $counts['post_types'][ $pt_key ];
                } elseif ( post_type_exists( $pt_key ) ) {
                    $c_pt = wp_count_posts( $pt_key );
                    $actual_pt = isset( $c_pt->publish ) ? (int) $c_pt->publish : 0;
                } else {
                    $actual_pt = 0;
                }
                $ok_pt = $actual_pt >= $min_pt;
                $add_check(
                    "required_posts_min:{$pt_key}",
                    $ok_pt,
                    "Published '{$pt_key}': {$actual_pt} (minimum required: {$min_pt})"
                );
            }
        }
    }

    // required_post_types
    if ( ! empty( $spec['required_post_types'] ) && is_array( $spec['required_post_types'] ) ) {
        foreach ( $spec['required_post_types'] as $req_pt ) {
            $pt_name = (string) $req_pt;
            $exists = post_type_exists( $pt_name );
            $add_check(
                "required_post_type:{$pt_name}",
                $exists,
                $exists ? "Post type '{$pt_name}' is registered" : "Missing required post type '{$pt_name}'"
            );
        }
    }

    // required_categories
    if ( ! empty( $spec['required_categories'] ) && is_array( $spec['required_categories'] ) ) {
        $cat_slugs = array();
        $cat_names = array();
        if ( ! is_wp_error( $cats ) && is_array( $cats ) ) {
            foreach ( $cats as $c ) {
                $cat_slugs[ strtolower( (string) $c->slug ) ] = true;
                $cat_names[ strtolower( trim( (string) $c->name ) ) ] = true;
            }
        }
        foreach ( $spec['required_categories'] as $req_cat ) {
            $needle = strtolower( trim( (string) $req_cat ) );
            $found = isset( $cat_slugs[ $needle ] ) || isset( $cat_names[ $needle ] );
            $add_check(
                "required_category:{$req_cat}",
                $found,
                $found ? "Category '{$req_cat}' exists" : "Missing required category '{$req_cat}'"
            );
        }
    }

    // required_users_min
    if ( isset( $spec['required_users_min'] ) && is_numeric( $spec['required_users_min'] ) ) {
        $min_u = (int) $spec['required_users_min'];
        $ok_u = $counts['users'] >= $min_u;
        $add_check(
            'required_users_min',
            $ok_u,
            "Total users: {$counts['users']} (minimum required: {$min_u})"
        );
    }

    // required_options
    if ( ! empty( $spec['required_options'] ) && is_array( $spec['required_options'] ) ) {
        foreach ( $spec['required_options'] as $opt_key => $opt_expected ) {
            $actual = get_option( (string) $opt_key, '__WPAI_MISSING__' );
            if ( $opt_expected === null ) {
                $ok_opt = ( $actual !== '__WPAI_MISSING__' && $actual !== '' && $actual !== false );
                $detail = $ok_opt ? "Option '{$opt_key}' is set" : "Option '{$opt_key}' is missing or empty";
            } else {
                $ok_opt = ( $actual !== '__WPAI_MISSING__' && (string) $actual === (string) $opt_expected );
                $detail = $ok_opt
                    ? "Option '{$opt_key}' matches expected value"
                    : "Option '{$opt_key}' expected '" . (string) $opt_expected . "', got '" . ( is_scalar( $actual ) ? (string) $actual : gettype( $actual ) ) . "'";
            }
            $add_check( "required_option:{$opt_key}", $ok_opt, $detail );
        }
    }

    // REST API internal dispatch check
    $types_req = new WP_REST_Request( 'GET', '/wp/v2/types' );
    $types_res = rest_do_request( $types_req );
    $types_status = $types_res ? (int) $types_res->get_status() : 0;
    $rest_api['types_status'] = $types_status;
    $add_check(
        'rest_api_types_200',
        $types_status === 200,
        "GET /wp/v2/types returned HTTP {$types_status}"
    );

    if ( ! empty( $spec['required_rest_routes'] ) && is_array( $spec['required_rest_routes'] ) ) {
        foreach ( $spec['required_rest_routes'] as $route ) {
            $route_str = (string) $route;
            $req = new WP_REST_Request( 'GET', $route_str );
            $res = rest_do_request( $req );
            $status = $res ? (int) $res->get_status() : 0;
            $rest_api['routes'][ $route_str ] = $status;
            $add_check(
                "rest_route:{$route_str}",
                $status === 200,
                "GET {$route_str} returned HTTP {$status}"
            );
        }
    }
}

$php_last_error = error_get_last();
$fatal_mask = E_ERROR | E_PARSE | E_CORE_ERROR | E_COMPILE_ERROR | E_USER_ERROR | E_RECOVERABLE_ERROR;
$has_fatal = is_array( $php_last_error ) && ( ( $php_last_error['type'] & $fatal_mask ) !== 0 );
$add_check(
    'no_php_errors',
    ! $has_fatal,
    $has_fatal
        ? ( 'PHP error: ' . $php_last_error['message'] . ' in ' . $php_last_error['file'] . ':' . $php_last_error['line'] )
        : ( $php_last_error ? 'No fatal PHP errors (last non-fatal notice captured)' : 'No PHP errors' )
);

$all_passed = true;
foreach ( $checks as $c ) {
    if ( ! $c['passed'] ) {
        $all_passed = false;
        break;
    }
}

$report = array(
    'ok' => $all_passed,
    'wordpress_loaded' => $wp_loaded,
    'wordpress_version' => $wp_version,
    'php_version' => $php_version,
    'blogname' => $blogname,
    'active_theme' => $active_theme,
    'active_plugins' => $active_plugins,
    'mu_plugins' => $mu_plugins,
    'abilities_api' => $abilities_api,
    'registered_abilities_count' => $registered_abilities_count,
    'counts' => $counts,
    'rest_api' => $rest_api,
    'php_last_error' => $php_last_error,
    'checks' => $checks,
);

file_put_contents( $wpai_report_path, json_encode( $report, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) );
$wpai_written = true;
`;
}

function runSubprocess(
  command: string,
  args: string[],
  options: {
    inheritStdio: boolean;
    timeoutMs?: number;
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
      stdio: options.inheritStdio ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: process.env,
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
    // Auto-mount sibling wp-content/themes/*, wp-content/plugins/*, and wp-content/mu-plugins
    // when present alongside blueprint.json (copying into tmpRoot so host sandboxes are never mutated).
    const localWpContent = path.join(baseDir, 'wp-content');
    if (fs.existsSync(localWpContent) && fs.statSync(localWpContent).isDirectory()) {
      const mountStage = path.join(tmpRoot, 'wp-content');
      for (const kind of ['themes', 'plugins'] as const) {
        const kindDir = path.join(localWpContent, kind);
        if (fs.existsSync(kindDir) && fs.statSync(kindDir).isDirectory()) {
          for (const entry of fs.readdirSync(kindDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
            const src = path.join(kindDir, entry.name);
            const dst = path.join(mountStage, kind, entry.name);
            fs.cpSync(src, dst, { recursive: true });
            args.push(`--mount=${dst}:/wordpress/wp-content/${kind}/${entry.name}`);
          }
        }
      }
      const muDir = path.join(localWpContent, 'mu-plugins');
      if (fs.existsSync(muDir) && fs.statSync(muDir).isDirectory()) {
        const muDst = path.join(mountStage, 'mu-plugins');
        fs.cpSync(muDir, muDst, { recursive: true });
        args.push(`--mount=${muDst}:/wordpress/wp-content/mu-plugins`);
      }
    }
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
