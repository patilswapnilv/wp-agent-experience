import fs from 'node:fs';
import path from 'node:path';
import type { Blueprint } from './types.js';
import { validateBlueprintFile } from './validator.js';

export interface ExportOptions {
  target: string;
  outDir: string;
}

export interface ExportResult {
  ok: boolean;
  source_blueprint: string;
  out_dir: string;
  wp_content_files: string[];
  wp_cli_commands: string[];
  files_written: string[];
}

function shellEscapeSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
  const wpCliCommands: string[] = [];
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
      }
    }
  }

  // 4. Walk Blueprint steps: extract writeFile under /wordpress/wp-content/ and translate provisioning steps
  const steps = Array.isArray(bp.steps) ? bp.steps : [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    switch (step.step) {
      case 'writeFile': {
        const destPath = typeof step.path === 'string' ? step.path : '';
        const wpContentPrefix = '/wordpress/wp-content/';
        if (destPath.startsWith(wpContentPrefix)) {
          const relInside = destPath.slice(wpContentPrefix.length).replace(/^\/+/, '');
          if (relInside && !relInside.includes('..')) {
            const targetFile = path.join(wpContentOut, relInside);
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
            if (content !== null) {
              fs.mkdirSync(path.dirname(targetFile), { recursive: true });
              fs.writeFileSync(targetFile, content, 'utf8');
              const rel = path.relative(outDir, targetFile);
              if (!wpContentFiles.includes(rel)) {
                wpContentFiles.push(rel);
              }
            }
          }
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
        }
        break;
      }

      case 'activateTheme': {
        if (typeof step.themeFolderName === 'string' && step.themeFolderName.trim()) {
          wpCliCommands.push(`wp theme activate ${shellEscapeSingle(step.themeFolderName.trim())}`);
        }
        break;
      }

      case 'wp-cli': {
        if (typeof step.command === 'string' && step.command.trim()) {
          wpCliCommands.push(step.command.trim());
        }
        break;
      }

      default:
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
    '# Run from your production WordPress root (MySQL/MariaDB + WP-CLI required).',
    '',
    'if ! command -v wp >/dev/null 2>&1; then',
    '  echo "Error: wp-cli (wp) is required on PATH." >&2',
    '  exit 1',
    'fi',
    '',
    ...(wpCliCommands.length > 0
      ? wpCliCommands
      : ['echo "No WP-CLI options/plugin commands extracted from blueprint.json."']),
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
  const deployMd = `# Production Deployment Handoff — ${siteTitle}

Exported by \`wpai export\` from \`${path.basename(blueprintPath)}\`.

## Included Artifacts

- \`wp-content/\` — ${wpContentFiles.length} extracted theme/plugin/mu-plugin file(s) ready to copy into your production WordPress \`wp-content/\` directory.
- \`setup.sh\` — ${wpCliCommands.length} WP-CLI provisioning command(s) for options, plugins, and theme activation.
- \`blueprint.json\` — Original declarative WordPress Playground Blueprint for local preview and CI verification.

## Production Checklist (MySQL / Managed Hosting)

1. **Provision WordPress on MySQL 8.0+ or MariaDB 10.11+** (managed host, VPS, or WordPress Studio sync) rather than Playground SQLite.
2. **Copy \`wp-content/\`** from this export bundle into your production WordPress \`wp-content/\` directory.
3. **Run \`./setup.sh\`** from the production WordPress root to apply site options, install plugins/themes, and flush rewrite rules.
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
    wp_cli_commands: wpCliCommands,
    files_written: filesWritten.sort(),
  };
}
