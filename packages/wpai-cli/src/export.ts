import fs from 'node:fs';
import path from 'node:path';
import type { Blueprint } from './types.js';
import { validateBlueprintFile } from './validator.js';

export interface ExportOptions {
  target: string;
  outDir: string;
}

export interface SkippedExportStep {
  index: number;
  step: string;
  reason: string;
}

export interface ExportResult {
  ok: boolean;
  source_blueprint: string;
  out_dir: string;
  wp_content_files: string[];
  setup_scripts: string[];
  wp_cli_commands: string[];
  skipped_steps: SkippedExportStep[];
  warnings: string[];
  files_written: string[];
}

function shellEscapeSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const WP_LOAD_BOOTSTRAP_RE =
  /(?:require|include)(?:_once)?\s*(?:\(\s*)?['"]\/wordpress\/wp-load\.php['"]\s*\)?\s*;\s*/g;

function extractStepLiteral(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (
    value &&
    typeof value === 'object' &&
    (value as Record<string, unknown>).resource === 'literal' &&
    typeof (value as Record<string, unknown>).contents === 'string'
  ) {
    return (value as Record<string, unknown>).contents as string;
  }
  return null;
}

/**
 * Prepare a Playground runPHP script for `wp eval-file` execution on a production WordPress install.
 * WP-CLI already loads WordPress before evaluating the file, so Playground's `/wordpress/wp-load.php`
 * require/include statement is stripped.
 */
function transformRunPhpForWpCli(rawCode: string): { code: string; hasResidualPlaygroundPath: boolean } {
  let code = rawCode.replace(WP_LOAD_BOOTSTRAP_RE, '');
  // Clean up excessive blank lines right after <?php
  code = code.replace(/^<\?php[ \t]*\r?\n(\r?\n)+/, '<?php\n');
  if (!code.trimStart().startsWith('<?php')) {
    code = `<?php\n${code}`;
  }
  if (!code.endsWith('\n')) {
    code += '\n';
  }
  const hasResidualPlaygroundPath = /\/wordpress(?:\/|['"])/.test(code);
  return { code, hasResidualPlaygroundPath };
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

function copyDirCollect(srcDir: string, dstDir: string, rootOut: string, collected: string[]): void {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyDirCollect(src, dst, rootOut, collected);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst);
      collected.push(path.relative(rootOut, dst));
    }
  }
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
  fs.mkdirSync(outDir, { recursive: true });

  const wpContentOut = path.join(outDir, 'wp-content');
  const wpContentFiles: string[] = [];
  const setupScripts: string[] = [];
  const wpCliCommands: string[] = [];
  const skippedSteps: SkippedExportStep[] = [];
  const warnings: string[] = [];
  const filesWritten: string[] = [];

  // 1. Copy any local sibling wp-content/ directory
  const localWpContent = path.join(baseDir, 'wp-content');
  if (fs.existsSync(localWpContent) && fs.statSync(localWpContent).isDirectory()) {
    copyDirCollect(localWpContent, wpContentOut, outDir, wpContentFiles);
  }

  // 2. Top-level siteOptions -> wp option update
  if (bp.siteOptions && typeof bp.siteOptions === 'object') {
    for (const [k, v] of Object.entries(bp.siteOptions)) {
      wpCliCommands.push(`wp option update ${shellEscapeSingle(k)} ${shellEscapeSingle(String(v))}`);
    }
  }

  // 3. Top-level plugins -> wp plugin install --activate
  if (Array.isArray(bp.plugins)) {
    for (const p of bp.plugins) {
      if (typeof p === 'string' && p.trim()) {
        wpCliCommands.push(`wp plugin install ${shellEscapeSingle(p.trim())} --activate`);
      } else if (p && typeof p === 'object') {
        warnings.push(
          'Top-level plugins entry is a resource object rather than a wordpress.org slug and was not added to setup.sh.'
        );
      }
    }
  }

  // 4. Walk Blueprint steps in order: extract files, runPHP scripts, and WP-CLI provisioning commands
  const steps = Array.isArray(bp.steps) ? bp.steps : [];
  let phpStepCount = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step !== 'object') continue;
    const stepType = typeof step.step === 'string' ? step.step : 'unknown';

    switch (stepType) {
      case 'mkdir': {
        const dirPath = typeof step.path === 'string' ? step.path : '';
        const wpContentPrefix = '/wordpress/wp-content/';
        if (dirPath === '/wordpress/wp-content' || dirPath.startsWith(wpContentPrefix)) {
          const relInside = dirPath.startsWith(wpContentPrefix)
            ? dirPath.slice(wpContentPrefix.length).replace(/^\/+/, '')
            : '';
          if (relInside && !relInside.includes('..')) {
            fs.mkdirSync(path.join(wpContentOut, relInside), { recursive: true });
          }
        } else {
          skippedSteps.push({
            index: i,
            step: stepType,
            reason: `Directory "${dirPath || '(missing path)'}" is outside /wordpress/wp-content/ and was not created in the export bundle.`,
          });
        }
        break;
      }

      case 'writeFile': {
        const destPath = typeof step.path === 'string' ? step.path : '';
        const wpContentPrefix = '/wordpress/wp-content/';
        if (!destPath.startsWith(wpContentPrefix)) {
          skippedSteps.push({
            index: i,
            step: stepType,
            reason: `File "${destPath || '(missing path)'}" is outside /wordpress/wp-content/ and was not exported.`,
          });
          break;
        }
        const relInside = destPath.slice(wpContentPrefix.length).replace(/^\/+/, '');
        if (!relInside || relInside.includes('..')) {
          skippedSteps.push({
            index: i,
            step: stepType,
            reason: `File path "${destPath}" is invalid or traverses outside wp-content/.`,
          });
          break;
        }
        const content = extractStepLiteral(step.data);
        if (content === null) {
          skippedSteps.push({
            index: i,
            step: stepType,
            reason: `File "${destPath}" uses a non-literal data resource that cannot be exported offline.`,
          });
          break;
        }
        const targetFile = path.join(wpContentOut, relInside);
        fs.mkdirSync(path.dirname(targetFile), { recursive: true });
        fs.writeFileSync(targetFile, content, 'utf8');
        const rel = path.relative(outDir, targetFile);
        if (!wpContentFiles.includes(rel)) {
          wpContentFiles.push(rel);
        }
        break;
      }

      case 'setSiteOptions': {
        const opts = step.options;
        if (opts && typeof opts === 'object') {
          for (const [k, v] of Object.entries(opts as Record<string, unknown>)) {
            wpCliCommands.push(`wp option update ${shellEscapeSingle(k)} ${shellEscapeSingle(String(v))}`);
          }
        }
        break;
      }

      case 'installPlugin': {
        const pluginData = step.pluginData as Record<string, unknown> | undefined;
        if (pluginData && pluginData.resource === 'wordpress.org/plugins' && typeof pluginData.slug === 'string') {
          const activate =
            !step.options || (step.options as Record<string, unknown>).activate !== false;
          wpCliCommands.push(
            `wp plugin install ${shellEscapeSingle(pluginData.slug)}${activate ? ' --activate' : ''}`
          );
        } else {
          skippedSteps.push({
            index: i,
            step: stepType,
            reason: 'Only wordpress.org/plugins slugs can be translated automatically; install this plugin manually.',
          });
        }
        break;
      }

      case 'activatePlugin': {
        if (typeof step.pluginPath === 'string' && step.pluginPath.trim()) {
          wpCliCommands.push(`wp plugin activate ${shellEscapeSingle(step.pluginPath.trim())}`);
        } else {
          skippedSteps.push({
            index: i,
            step: stepType,
            reason: 'Missing pluginPath string for activatePlugin step.',
          });
        }
        break;
      }

      case 'installTheme': {
        const themeData = step.themeData as Record<string, unknown> | undefined;
        if (themeData && themeData.resource === 'wordpress.org/themes' && typeof themeData.slug === 'string') {
          const activate =
            !step.options || (step.options as Record<string, unknown>).activate !== false;
          wpCliCommands.push(
            `wp theme install ${shellEscapeSingle(themeData.slug)}${activate ? ' --activate' : ''}`
          );
        } else {
          skippedSteps.push({
            index: i,
            step: stepType,
            reason: 'Only wordpress.org/themes slugs can be translated automatically; install this theme manually.',
          });
        }
        break;
      }

      case 'activateTheme': {
        if (typeof step.themeFolderName === 'string' && step.themeFolderName.trim()) {
          wpCliCommands.push(`wp theme activate ${shellEscapeSingle(step.themeFolderName.trim())}`);
        } else {
          skippedSteps.push({
            index: i,
            step: stepType,
            reason: 'Missing themeFolderName string for activateTheme step.',
          });
        }
        break;
      }

      case 'wp-cli': {
        if (typeof step.command === 'string' && step.command.trim()) {
          wpCliCommands.push(step.command.trim());
        } else {
          skippedSteps.push({
            index: i,
            step: stepType,
            reason: 'Empty or non-string command in wp-cli step.',
          });
        }
        break;
      }

      case 'runPHP': {
        const rawCode = extractStepLiteral(step.code);
        if (rawCode === null || !rawCode.trim()) {
          skippedSteps.push({
            index: i,
            step: stepType,
            reason: 'runPHP step has missing or non-literal code and could not be exported.',
          });
          break;
        }
        phpStepCount += 1;
        const scriptRel = path.posix.join('setup.d', `${String(phpStepCount).padStart(2, '0')}-run-php.php`);
        const scriptAbs = path.join(outDir, ...scriptRel.split('/'));
        const { code, hasResidualPlaygroundPath } = transformRunPhpForWpCli(rawCode);
        fs.mkdirSync(path.dirname(scriptAbs), { recursive: true });
        fs.writeFileSync(scriptAbs, code, 'utf8');
        setupScripts.push(scriptRel);
        filesWritten.push(scriptRel);
        wpCliCommands.push(`wp eval-file "$SCRIPT_DIR/${scriptRel}"`);
        if (hasResidualPlaygroundPath) {
          warnings.push(
            `${scriptRel} still references "/wordpress/" after removing wp-load.php; review paths before running in production.`
          );
        }
        break;
      }

      default:
        skippedSteps.push({
          index: i,
          step: stepType,
          reason: `Blueprint step "${stepType}" is not automatically translated by wpai export and must be applied manually.`,
        });
        break;
    }
  }

  // 5. Copy blueprint.json for reference
  const bpOut = path.join(outDir, 'blueprint.json');
  fs.copyFileSync(blueprintPath, bpOut);
  filesWritten.push('blueprint.json');

  // 6. Write executable setup.sh WP-CLI handoff script
  const setupShPath = path.join(outDir, 'setup.sh');
  const setupLines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    '# Generated by `wpai export` from blueprint.json',
    '# Copy wp-content/ first, then run this script from your production WordPress root (MySQL/MariaDB + WP-CLI required).',
    '',
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    '',
    'if ! command -v wp >/dev/null 2>&1; then',
    '  echo "Error: wp-cli (wp) is required on PATH." >&2',
    '  exit 1',
    'fi',
    '',
    ...(wpCliCommands.length > 0
      ? wpCliCommands
      : ['echo "No WP-CLI options/plugin/content commands extracted from blueprint.json."']),
    '',
    'wp rewrite flush --hard || true',
    'echo "Production WordPress provisioning complete."',
    '',
  ];
  fs.writeFileSync(setupShPath, setupLines.join('\n'), 'utf8');
  fs.chmodSync(setupShPath, 0o755);
  filesWritten.push('setup.sh');

  // 7. Write DEPLOY.md production handoff checklist
  const deployMdPath = path.join(outDir, 'DEPLOY.md');
  const siteTitle =
    (bp.meta && typeof bp.meta.title === 'string' && bp.meta.title) ||
    (bp.siteOptions && typeof bp.siteOptions.blogname === 'string' && bp.siteOptions.blogname) ||
    'WordPress Site';

  const artifactLines = [
    `- \`wp-content/\` — ${wpContentFiles.length} extracted theme/plugin/mu-plugin file(s) ready to copy into your production WordPress \`wp-content/\` directory.`,
    ...(setupScripts.length > 0
      ? [
          `- \`setup.d/\` — ${setupScripts.length} PHP provisioning script(s) exported from Blueprint \`runPHP\` steps and executed via \`wp eval-file\` by \`setup.sh\`.`,
        ]
      : []),
    `- \`setup.sh\` — ${wpCliCommands.length} WP-CLI provisioning command(s) for options, plugins, themes, and content seeding.`,
    `- \`blueprint.json\` — Original declarative WordPress Playground Blueprint for local preview and CI verification.`,
  ];

  const warningsSection =
    warnings.length > 0
      ? `\n## Export Warnings\n\n${warnings.map((w) => `- ${w}`).join('\n')}\n`
      : '';

  const skippedSection =
    skippedSteps.length > 0
      ? `\n## Manual Steps Required (Skipped Blueprint Steps)\n\nThe following Blueprint step(s) were not automatically exported into \`setup.sh\`:\n\n${skippedSteps
          .map((s) => `- Step #${s.index + 1} (\`${s.step}\`): ${s.reason}`)
          .join('\n')}\n`
      : '';

  const deployMd = `# Production Deployment Handoff — ${siteTitle}

Exported by \`wpai export\` from \`${path.basename(blueprintPath)}\`.

## Included Artifacts

${artifactLines.join('\n')}
${warningsSection}${skippedSection}
## Production Checklist (MySQL / Managed Hosting)

1. **Provision WordPress on MySQL 8.0+ or MariaDB 10.11+** (managed host, VPS, or WordPress Studio sync) rather than Playground SQLite.
2. **Copy \`wp-content/\`** from this export bundle into your production WordPress \`wp-content/\` directory so custom themes, plugins, and mu-plugins are active before seeding content.
3. **Run \`./setup.sh\`** (or \`/path/to/export/setup.sh\`) from the production WordPress root to apply site options, install plugins/themes, run \`setup.d/*.php\` provisioning scripts, and flush rewrite rules.
4. **Configure production secrets & payments:** Set real SMTP credentials, HTTPS/TLS certificates, payment gateway keys (Stripe/WooCommerce), and automated off-site backups.
5. **Verify admin access:** Change any default/demo passwords and confirm \`wp_get_abilities()\` / REST routes return HTTP 200.
`;
  fs.writeFileSync(deployMdPath, deployMd, 'utf8');
  filesWritten.push('DEPLOY.md');

  for (const f of wpContentFiles) {
    filesWritten.push(f);
  }

  return {
    ok: true,
    source_blueprint: blueprintPath,
    out_dir: outDir,
    wp_content_files: wpContentFiles.sort(),
    setup_scripts: setupScripts,
    wp_cli_commands: wpCliCommands,
    skipped_steps: skippedSteps,
    warnings,
    files_written: filesWritten.sort(),
  };
}
