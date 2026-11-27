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
  /** Where the operation came from, e.g. `steps[3]`, `plugins[0]`, `constants`, `login`. */
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
  const wpContentOut = path.join(outDir, 'wp-content');
  const wpCliCommands: string[] = [];
  const skippedSteps: SkippedStep[] = [];
  const pendingWrites: Array<{ rel: string; content: string }> = [];
  const pendingDirs: string[] = [];
  const wpContentPrefix = '/wordpress/wp-content/';

  const skip = (location: string, step: string, reason: string, blocking = true): void => {
    skippedSteps.push({ location, step, reason, blocking });
  };

  // 1. Top-level siteOptions -> wp option update
  if (bp.siteOptions && typeof bp.siteOptions === 'object') {
    for (const [k, v] of Object.entries(bp.siteOptions)) {
      wpCliCommands.push(`wp option update ${shellEscapeSingle(k)} ${shellEscapeSingle(String(v))}`);
    }
  }

  // 2. Top-level plugins -> wp plugin install --activate
  if (Array.isArray(bp.plugins)) {
    bp.plugins.forEach((p, i) => {
      if (typeof p === 'string' && p.trim()) {
        wpCliCommands.push(`wp plugin install ${shellEscapeSingle(p.trim())} --activate`);
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
        if (!destPath.startsWith(wpContentPrefix)) {
          skip(location, name, `Writes outside wp-content/ (${destPath || 'no path'}); only wp-content/ files are exported.`);
          break;
        }
        const relInside = destPath.slice(wpContentPrefix.length).replace(/^\/+/, '');
        if (!relInside || relInside.includes('..')) {
          skip(location, name, `Unsafe or empty wp-content path (${destPath}); file not exported.`);
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
        if (dirPath === '/wordpress/wp-content' || dirPath.startsWith(wpContentPrefix)) {
          const relInside = dirPath.slice(wpContentPrefix.length).replace(/^\/+|\/+$/g, '');
          if (relInside.includes('..')) {
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
            wpCliCommands.push(`wp option update ${shellEscapeSingle(k)} ${shellEscapeSingle(String(v))}`);
          }
        } else {
          skip(location, name, 'No options object; nothing exported.');
        }
        break;
      }

      case 'installPlugin': {
        const pluginData = step.pluginData as Record<string, unknown> | undefined;
        if (pluginData && pluginData.resource === 'wordpress.org/plugins' && typeof pluginData.slug === 'string' && pluginData.slug.trim()) {
          const activate =
            !step.options || (step.options as Record<string, unknown>).activate !== false;
          wpCliCommands.push(
            `wp plugin install ${shellEscapeSingle(pluginData.slug.trim())}${activate ? ' --activate' : ''}`
          );
        } else {
          const source = pluginData && typeof pluginData.resource === 'string' ? pluginData.resource : 'unknown';
          skip(location, name, `Plugin source "${source}" has no usable WordPress.org slug; install this plugin manually.`);
        }
        break;
      }

      case 'installTheme': {
        const themeData = step.themeData as Record<string, unknown> | undefined;
        if (themeData && themeData.resource === 'wordpress.org/themes' && typeof themeData.slug === 'string' && themeData.slug.trim()) {
          const activate =
            !step.options || (step.options as Record<string, unknown>).activate !== false;
          wpCliCommands.push(
            `wp theme install ${shellEscapeSingle(themeData.slug.trim())}${activate ? ' --activate' : ''}`
          );
        } else {
          const source = themeData && typeof themeData.resource === 'string' ? themeData.resource : 'unknown';
          skip(location, name, `Theme source "${source}" has no usable WordPress.org slug; install this theme manually.`);
        }
        break;
      }

      case 'activateTheme': {
        if (typeof step.themeFolderName === 'string' && step.themeFolderName.trim()) {
          wpCliCommands.push(`wp theme activate ${shellEscapeSingle(step.themeFolderName.trim())}`);
        } else {
          skip(location, name, 'No themeFolderName; nothing exported.');
        }
        break;
      }

      case 'wp-cli': {
        if (typeof step.command === 'string' && step.command.trim()) {
          wpCliCommands.push(step.command.trim());
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

  fs.mkdirSync(outDir, { recursive: true });
  const wpContentFiles: string[] = [];
  const filesWritten: string[] = [];

  // 5. Copy any local sibling wp-content/ directory, then inline writeFile contents
  const localWpContent = path.join(baseDir, 'wp-content');
  if (fs.existsSync(localWpContent) && fs.statSync(localWpContent).isDirectory()) {
    copyDirCollect(localWpContent, wpContentOut, outDir, wpContentFiles);
  }
  for (const relInside of pendingDirs) {
    fs.mkdirSync(path.join(wpContentOut, relInside), { recursive: true });
  }
  for (const { rel: relInside, content } of pendingWrites) {
    const targetFile = path.join(wpContentOut, relInside);
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, content, 'utf8');
    const rel = path.relative(outDir, targetFile);
    if (!wpContentFiles.includes(rel)) {
      wpContentFiles.push(rel);
    }
  }

  // 6. Copy blueprint.json for reference
  const bpOut = path.join(outDir, 'blueprint.json');
  fs.copyFileSync(blueprintPath, bpOut);
  filesWritten.push('blueprint.json');

  // 7. Write executable setup.sh WP-CLI handoff script
  const setupShPath = path.join(outDir, 'setup.sh');
  const setupLines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    '# Generated by `wpai export` from blueprint.json',
    '# Run from your production WordPress root (MySQL/MariaDB + WP-CLI required).',
    ...(complete
      ? []
      : [
          `# INCOMPLETE EXPORT: ${blocking.length} Blueprint operation(s) were not exported.`,
          '# See "Manual Steps Required" in DEPLOY.md before relying on this site.',
        ]),
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
    ...(complete
      ? ['echo "Production WordPress provisioning complete."']
      : [
          `echo "WARNING: incomplete export. ${blocking.length} Blueprint operation(s) were not applied; see Manual Steps Required in DEPLOY.md." >&2`,
        ]),
    '',
  ];
  fs.writeFileSync(setupShPath, setupLines.join('\n'), 'utf8');
  fs.chmodSync(setupShPath, 0o755);
  filesWritten.push('setup.sh');

  // 8. Write DEPLOY.md production handoff checklist
  const deployMdPath = path.join(outDir, 'DEPLOY.md');
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
## Not Exported (Playground-Only, No Action Needed)

${nonBlocking.map(describeSkipped).join('\n')}
`;
  const deployMd = `# Production Deployment Handoff — ${siteTitle}

Exported by \`wpai export\` from \`${path.basename(blueprintPath)}\`.
${manualSection}
## Included Artifacts

- \`wp-content/\` — ${wpContentFiles.length} extracted theme/plugin/mu-plugin file(s) ready to copy into your production WordPress \`wp-content/\` directory.
- \`setup.sh\` — ${wpCliCommands.length} WP-CLI provisioning command(s) for options, plugins, and theme activation.
- \`blueprint.json\` — Original declarative WordPress Playground Blueprint for local preview and CI verification.
${playgroundOnlySection}
## Production Checklist (MySQL / Managed Hosting)

1. **Provision WordPress on MySQL 8.0+ or MariaDB 10.11+** (managed host, VPS, or WordPress Studio sync) rather than Playground SQLite.
2. **Copy \`wp-content/\`** from this export bundle into your production WordPress \`wp-content/\` directory.
3. **Run \`./setup.sh\`** from the production WordPress root to apply site options, install plugins/themes, and flush rewrite rules.${complete ? '' : '\n4. **Complete every item under Manual Steps Required** above.'}
${complete ? 4 : 5}. **Configure production secrets & payments:** Set real SMTP credentials, HTTPS/TLS certificates, payment gateway keys (Stripe/WooCommerce), and automated off-site backups.
${complete ? 5 : 6}. **Verify admin access:** Change any default/demo passwords and confirm \`wp_get_abilities()\` / REST routes return HTTP 200.
`;
  fs.writeFileSync(deployMdPath, deployMd, 'utf8');
  filesWritten.push('DEPLOY.md');

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
