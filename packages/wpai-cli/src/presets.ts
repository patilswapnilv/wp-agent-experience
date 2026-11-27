import fs from 'node:fs';
import path from 'node:path';
import { resolveBlueprintPresetDir } from './paths.js';
import type { Blueprint, PresetName, VerifySpec } from './types.js';
import { PRESET_NAMES } from './types.js';

export interface PresetTemplate {
  preset: PresetName;
  defaultName: string;
  blueprint: Blueprint;
  verify: VerifySpec;
  readme: string;
  /** Directory the preset was loaded from (bundled `assets/blueprints/<preset>` or repo `blueprints/<preset>`). */
  dir: string;
  source: 'bundled-assets' | 'repo-blueprints';
}

export interface InitOptions {
  preset: PresetName;
  dir: string;
  name?: string;
  wp?: string;
  php?: string;
}

export interface InitResult {
  preset: PresetName;
  dir: string;
  source: 'bundled-assets' | 'repo-blueprints';
  name: string;
  files_written: string[];
}

export function isValidPreset(value: string): value is PresetName {
  return (PRESET_NAMES as readonly string[]).includes(value);
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

/**
 * Load a preset from its canonical `blueprints/<preset>/` directory. The npm package ships
 * these files under `assets/blueprints/` (see scripts/copy-assets.mjs), so there is a single
 * source of truth for both the repo and installed CLI.
 */
export function loadPreset(preset: PresetName): PresetTemplate {
  const location = resolveBlueprintPresetDir(preset);
  if (!location) {
    throw new Error(
      `Could not locate the "${preset}" preset (blueprints/${preset}/blueprint.json). Reinstall wpai-cli or run "npm run build".`
    );
  }
  const { dir, source } = location;
  const blueprint = readJson<Blueprint>(path.join(dir, 'blueprint.json'));
  const verifyPath = path.join(dir, 'verify.json');
  const verifyFromFile = fs.existsSync(verifyPath) ? readJson<VerifySpec>(verifyPath) : null;
  const metaTitle = blueprint.meta && typeof blueprint.meta.title === 'string' ? blueprint.meta.title : undefined;
  const defaultName = verifyFromFile?.expected_blogname ?? metaTitle ?? preset;
  const verify: VerifySpec = verifyFromFile ?? { expected_blogname: defaultName };
  const readmePath = path.join(dir, 'README.md');
  const readme = fs.existsSync(readmePath)
    ? fs.readFileSync(readmePath, 'utf8')
    : `# ${defaultName}\n\nScaffolded by \`wpai init ${preset}\`.\n\n## Quick Start\n\n\`\`\`bash\nnpm start\nwpai verify .\nwpai export . --out ./dist-wp\n\`\`\`\n`;
  return { preset, defaultName, blueprint, verify, readme, dir, source };
}

/**
 * @deprecated Presets are no longer inlined; use {@link loadPreset}. Kept for API compatibility.
 */
export function getBuiltInPreset(preset: PresetName): PresetTemplate {
  return loadPreset(preset);
}

function copyDirRecursive(srcDir: string, destDir: string, written: string[]): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, written);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
      written.push(destPath);
    }
  }
}

function applyBlueprintCustomizations(
  blueprint: Blueprint,
  options: { name?: string; wp?: string; php?: string }
): void {
  if (options.wp || options.php) {
    blueprint.preferredVersions = {
      ...(blueprint.preferredVersions ?? {}),
      ...(options.php ? { php: options.php } : {}),
      ...(options.wp ? { wp: options.wp } : {}),
    };
  }

  if (options.name) {
    if (blueprint.meta && typeof blueprint.meta === 'object') {
      blueprint.meta.title = options.name;
    }

    let updatedStep = false;
    if (Array.isArray(blueprint.steps)) {
      for (const step of blueprint.steps) {
        if (
          step &&
          step.step === 'setSiteOptions' &&
          step.options &&
          typeof step.options === 'object' &&
          !Array.isArray(step.options)
        ) {
          (step.options as Record<string, unknown>).blogname = options.name;
          updatedStep = true;
          break;
        }
      }
    }

    if (blueprint.siteOptions && typeof blueprint.siteOptions === 'object') {
      blueprint.siteOptions.blogname = options.name;
      updatedStep = true;
    }

    if (!updatedStep) {
      blueprint.steps = [
        { step: 'setSiteOptions', options: { blogname: options.name } },
        ...(blueprint.steps ?? []),
      ];
    }
  }
}

function slugifyPackageName(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'wpai-site';
}

export function initProject(options: InitOptions): InitResult {
  const template = loadPreset(options.preset);
  const targetDir = path.resolve(options.dir);
  fs.mkdirSync(targetDir, { recursive: true });

  const written: string[] = [];
  copyDirRecursive(template.dir, targetDir, written);

  const bpPath = path.join(targetDir, 'blueprint.json');
  const blueprint = structuredClone(template.blueprint);
  applyBlueprintCustomizations(blueprint, {
    name: options.name,
    wp: options.wp,
    php: options.php,
  });
  fs.writeFileSync(bpPath, `${JSON.stringify(blueprint, null, 2)}\n`, 'utf8');

  const verifyPath = path.join(targetDir, 'verify.json');
  const verifySpec: VerifySpec = {
    ...structuredClone(template.verify),
    ...(options.name ? { expected_blogname: options.name } : {}),
  };
  fs.writeFileSync(verifyPath, `${JSON.stringify(verifySpec, null, 2)}\n`, 'utf8');
  if (!written.includes(verifyPath)) written.push(verifyPath);

  const siteName = options.name ?? template.defaultName;

  // Write package.json with @wp-playground/cli scripts
  const pkgPath = path.join(targetDir, 'package.json');
  const pkgJson = {
    name: slugifyPackageName(siteName),
    version: '0.1.0',
    private: true,
    description: `${siteName} — WordPress Playground project scaffolded by wpai (${options.preset}).`,
    scripts: {
      start: 'npx -y @wp-playground/cli@3.1.66 server --blueprint=./blueprint.json --blueprint-may-read-adjacent-files --port=9400',
      'run-blueprint': 'npx -y @wp-playground/cli@3.1.66 run-blueprint --blueprint=./blueprint.json --blueprint-may-read-adjacent-files',
      verify: 'wpai verify .',
    },
  };
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkgJson, null, 2)}\n`, 'utf8');
  if (!written.includes(pkgPath)) written.push(pkgPath);

  // Write README.md if the preset directory did not provide one
  const readmePath = path.join(targetDir, 'README.md');
  if (!fs.existsSync(readmePath)) {
    const readmeText = options.name ? template.readme.replace(template.defaultName, options.name) : template.readme;
    fs.writeFileSync(readmePath, readmeText, 'utf8');
    written.push(readmePath);
  }

  return {
    preset: options.preset,
    dir: targetDir,
    source: template.source,
    name: siteName,
    files_written: written.map((f) => path.relative(targetDir, f) || path.basename(f)),
  };
}
