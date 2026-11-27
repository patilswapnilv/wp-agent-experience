#!/usr/bin/env node
import { exportForProduction } from './export.js';
import { runMcpStdioServer } from './mcp.js';
import { getPackageVersion } from './paths.js';
import { bootBlueprint, verifyBlueprint } from './playground.js';
import { initProject, isValidPreset } from './presets.js';
import { evaluateFit, loadRegistry, validateRegistry } from './registry.js';
import { PRESET_NAMES } from './types.js';
import { validateBlueprintFile } from './validator.js';

const VERSION = getPackageVersion();

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set([
  'json',
  'headless',
  'help',
  'h',
  'version',
  'v',
]);

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;

    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eqIdx = body.indexOf('=');
      if (eqIdx !== -1) {
        const key = body.slice(0, eqIdx);
        const val = body.slice(eqIdx + 1);
        flags[key] = val;
      } else if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
    } else if (token.startsWith('-') && token.length === 2) {
      const short = token.slice(1);
      flags[short] = true;
    } else {
      positionals.push(token);
    }
  }

  return { positionals, flags };
}

function getStringFlag(
  flags: Record<string, string | boolean>,
  name: string
): string | undefined {
  const val = flags[name];
  return typeof val === 'string' ? val : undefined;
}

function getBoolFlag(
  flags: Record<string, string | boolean>,
  name: string
): boolean {
  return flags[name] === true || flags[name] === 'true';
}

function printHelp(): void {
  console.log(`wpai v${VERSION} — WordPress Agent Experience CLI (wraps @wp-playground/cli@3.1.66)

Usage:
  wpai init <${PRESET_NAMES.join('|')}> [--dir <path>] [--name <title>] [--wp <ver>] [--php <ver>] [--json]
  wpai validate <blueprint-path> [--json]
  wpai boot <dir-or-blueprint> [--headless] [--port <port>] [--wp <ver>] [--php <ver>] [--json]
  wpai verify <dir-or-blueprint> [--checks <verify.json>] [--timeout <ms>] [--wp <ver>] [--php <ver>] [--json]
  wpai export <dir-or-blueprint> [--out <dir>] [--json]
  wpai mcp
  wpai catalog [--registry <path>] [--json]
  wpai check-fit "<prompt>" [--registry <path>] [--json]
  wpai validate-registry [path] [--schema <path>] [--json]
  wpai --help | --version
`);
}

async function main(): Promise<number> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0) {
    printHelp();
    return 0;
  }

  const command = rawArgs[0];
  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return 0;
  }
  if (command === '--version' || command === '-v') {
    console.log(VERSION);
    return 0;
  }

  const { positionals, flags } = parseArgs(rawArgs.slice(1));
  const asJson = getBoolFlag(flags, 'json');

  if (getBoolFlag(flags, 'help') || getBoolFlag(flags, 'h')) {
    printHelp();
    return 0;
  }

  try {
    switch (command) {
      case 'init': {
        const preset = positionals[0];
        if (!preset || !isValidPreset(preset)) {
          const msg = `Invalid or missing preset "${preset ?? ''}". Expected one of: ${PRESET_NAMES.join(', ')}.`;
          if (asJson) {
            console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
          } else {
            console.error(`Error: ${msg}`);
          }
          return 1;
        }

        const result = initProject({
          preset,
          dir: getStringFlag(flags, 'dir') ?? '.',
          name: getStringFlag(flags, 'name'),
          wp: getStringFlag(flags, 'wp'),
          php: getStringFlag(flags, 'php'),
        });

        if (asJson) {
          console.log(JSON.stringify({ ok: true, ...result }, null, 2));
        } else {
          console.log(`Initialized WordPress preset "${result.preset}" in ${result.dir} (source: ${result.source})`);
          console.log(`Site name: ${result.name}`);
          console.log(`Files: ${result.files_written.join(', ')}`);
          console.log(`\nNext steps:\n  wpai validate "${result.dir}/blueprint.json"\n  wpai verify "${result.dir}"\n  wpai boot "${result.dir}"`);
        }
        return 0;
      }

      case 'validate': {
        const target = positionals[0];
        if (!target) {
          const msg = 'Missing <blueprint-path>. Usage: wpai validate <blueprint-path> [--json]';
          if (asJson) {
            console.log(JSON.stringify({ valid: false, error: msg }, null, 2));
          } else {
            console.error(`Error: ${msg}`);
          }
          return 1;
        }

        const result = validateBlueprintFile(target);
        if (asJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          if (result.valid) {
            console.log(`VALID: ${result.file}`);
          } else {
            console.error(`INVALID: ${result.file}`);
          }
          for (const err of result.errors) {
            console.error(`  [ERROR] (${err.code}) ${err.path}: ${err.message}`);
          }
          for (const warn of result.warnings) {
            console.warn(`  [WARN]  (${warn.code}) ${warn.path}: ${warn.message}`);
          }
        }
        return result.valid ? 0 : 1;
      }

      case 'boot': {
        const target = positionals[0];
        if (!target) {
          const msg = 'Missing <dir-or-blueprint>. Usage: wpai boot <dir-or-blueprint> [--headless] [--port <port>] [--wp <ver>] [--php <ver>] [--json]';
          if (asJson) {
            console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
          } else {
            console.error(`Error: ${msg}`);
          }
          return 1;
        }

        const portStr = getStringFlag(flags, 'port');
        const port = portStr ? Number.parseInt(portStr, 10) : undefined;
        if (portStr && Number.isNaN(port)) {
          const msg = `Invalid --port value "${portStr}".`;
          if (asJson) {
            console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
          } else {
            console.error(`Error: ${msg}`);
          }
          return 1;
        }

        const res = await bootBlueprint(target, {
          headless: getBoolFlag(flags, 'headless'),
          port,
          wp: getStringFlag(flags, 'wp'),
          php: getStringFlag(flags, 'php'),
          json: asJson,
        });

        if (asJson) {
          console.log(JSON.stringify(res, null, 2));
        } else if (!res.ok) {
          console.error(`Boot failed (${res.mode}): ${res.error ?? `exit code ${String(res.exit_code)}`}`);
          for (const err of res.validation.errors) {
            console.error(`  [ERROR] (${err.code}) ${err.path}: ${err.message}`);
          }
          if (res.stderr) console.error(res.stderr.trim());
        } else if (res.mode === 'headless') {
          console.log(`Headless blueprint run succeeded in ${res.duration_ms}ms: ${res.blueprint}`);
        }
        return res.ok ? 0 : 1;
      }

      case 'verify': {
        const target = positionals[0];
        if (!target) {
          const msg = 'Missing <dir-or-blueprint>. Usage: wpai verify <dir-or-blueprint> [--checks <verify.json>] [--timeout <ms>] [--json]';
          if (asJson) {
            console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
          } else {
            console.error(`Error: ${msg}`);
          }
          return 1;
        }

        const timeoutStr = getStringFlag(flags, 'timeout');
        const timeoutMs = timeoutStr ? Number.parseInt(timeoutStr, 10) : 90000;
        if (timeoutStr && (Number.isNaN(timeoutMs) || timeoutMs <= 0)) {
          const msg = `Invalid --timeout value "${timeoutStr}". Must be positive milliseconds.`;
          if (asJson) {
            console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
          } else {
            console.error(`Error: ${msg}`);
          }
          return 1;
        }

        const report = await verifyBlueprint(target, {
          checksPath: getStringFlag(flags, 'checks'),
          timeoutMs,
          wp: getStringFlag(flags, 'wp'),
          php: getStringFlag(flags, 'php'),
        });

        if (asJson) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          const status = report.ok ? 'PASS' : 'FAIL';
          console.log(`VERIFY ${status} (${report.duration_ms}ms) — ${report.blueprint}`);
          if (report.wordpress_loaded) {
            console.log(
              `  WordPress ${report.wordpress_version ?? '?'} | PHP ${report.php_version ?? '?'} | Site: "${report.blogname ?? ''}" | Theme: ${report.active_theme?.stylesheet ?? 'none'}`
            );
            console.log(
              `  Counts: pages=${report.counts.pages}, posts=${report.counts.posts}, categories=${report.counts.categories}, users=${report.counts.users} | Abilities API: ${report.abilities_api ? `yes (${report.registered_abilities_count})` : 'no'}`
            );
          }
          for (const check of report.checks) {
            const mark = check.passed ? 'PASS' : 'FAIL';
            console.log(`  [${mark}] ${check.name}: ${check.detail}`);
          }
          if (report.error) {
            console.error(`  Error: ${report.error}`);
          }
        }
        return report.ok ? 0 : 1;
      }

      case 'catalog': {
        const { registry, path: regPath } = loadRegistry(
          getStringFlag(flags, 'registry')
        );
        if (asJson) {
          console.log(JSON.stringify(registry, null, 2));
        } else {
          console.log(
            `WordPress Capability Registry v${registry.registry_version} (verified ${registry.last_verified})`
          );
          console.log(`Source: ${regPath}`);
          console.log(
            `Baseline: WP ${registry.wordpress_baseline.core_version_tested}, PHP ${registry.wordpress_baseline.php_recommended}, @wp-playground/cli@${registry.wordpress_baseline.playground_cli_version}`
          );
          console.log('\nRecommended for:');
          for (const d of registry.suitability.recommended_for) {
            console.log(`  - ${d.id}: ${d.label} (preset: ${d.blueprint_preset ?? 'none'})`);
          }
          console.log('\nContested for:');
          for (const d of registry.suitability.contested_for) {
            console.log(`  - ${d.id}: ${d.label} (preset: ${d.blueprint_preset ?? 'none'})`);
          }
          console.log('\nNOT recommended for (negative controls):');
          for (const d of registry.suitability.not_recommended_for) {
            console.log(`  - ${d.id}: ${d.label} -> ${d.preferred_alternatives.join(' / ')}`);
          }
          console.log('\nCore capabilities:');
          for (const cap of registry.core_capabilities) {
            console.log(`  - ${cap.name} (${cap.in_core ? `WP ${cap.min_wp_version}+ core` : 'official plugin'})`);
          }
        }
        return 0;
      }

      case 'check-fit': {
        const prompt = positionals.join(' ').trim();
        if (!prompt) {
          const msg = 'Missing prompt string. Usage: wpai check-fit "<prompt>" [--json]';
          if (asJson) {
            console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
          } else {
            console.error(`Error: ${msg}`);
          }
          return 1;
        }

        const { registry } = loadRegistry(getStringFlag(flags, 'registry'));
        const fit = evaluateFit(prompt, registry);

        if (asJson) {
          console.log(JSON.stringify(fit, null, 2));
        } else {
          console.log(`Decision: ${fit.decision} (wordpress_fit=${String(fit.wordpress_fit)})`);
          console.log(`Domain: ${fit.domain_label}${fit.domain_id ? ` [${fit.domain_id}]` : ''}`);
          if (fit.matched_signals.length > 0) {
            console.log(`Matched signals: ${fit.matched_signals.join(', ')}`);
          }
          console.log(`Rationale: ${fit.rationale}`);
          if (fit.blueprint_preset) {
            console.log(`Recommended preset: ${fit.blueprint_preset}`);
          }
          if (fit.preferred_alternatives && fit.preferred_alternatives.length > 0) {
            console.log(`Preferred alternatives: ${fit.preferred_alternatives.join(', ')}`);
          }
          if (fit.alternatives_to_consider && fit.alternatives_to_consider.length > 0) {
            console.log(`Alternatives to consider: ${fit.alternatives_to_consider.join(', ')}`);
          }
        }
        return 0;
      }

      case 'validate-registry': {
        const targetPath = positionals[0];
        const schemaPath = getStringFlag(flags, 'schema');
        const result = validateRegistry(targetPath, schemaPath);

        if (asJson) {
          console.log(JSON.stringify(result, null, 2));
        } else if (result.valid) {
          console.log(`VALID REGISTRY: ${result.registry_path}`);
          console.log(`  Schema: ${result.schema_path}`);
        } else {
          console.error(`INVALID REGISTRY: ${result.registry_path}`);
          for (const err of result.errors) {
            console.error(`  [ERROR] ${err.instancePath}: ${err.message} (${err.schemaPath})`);
          }
        }
        return result.valid ? 0 : 1;
      }

      case 'export': {
        const target = positionals[0] ?? '.';
        const outDir = getStringFlag(flags, 'out') ?? './dist-wp';
        const result = exportForProduction({ target, outDir });

        if (asJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Exported WordPress production bundle to ${result.out_dir}`);
          console.log(`  Source blueprint: ${result.source_blueprint}`);
          console.log(`  wp-content files: ${result.wp_content_files.length}`);
          console.log(`  WP-CLI commands:  ${result.wp_cli_commands.length}`);
          console.log(`  Next: see ${result.out_dir}/DEPLOY.md`);
        }
        return 0;
      }

      case 'mcp': {
        return await runMcpStdioServer();
      }

      default: {
        const msg = `Unknown command "${command}". Run "wpai --help" for usage.`;
        if (asJson) {
          console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
        } else {
          console.error(`Error: ${msg}`);
        }
        return 1;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (asJson) {
      console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    } else {
      console.error(`Error: ${msg}`);
    }
    return 1;
  }
}

const exitCode = await main();
process.exit(exitCode);
