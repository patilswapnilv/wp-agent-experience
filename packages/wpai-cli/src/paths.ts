import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PresetName } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Walk upward from a starting directory looking for a target relative path.
 */
function walkUpFor(startDir: string, relativeTarget: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, relativeTarget);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * Locate the wpai-cli package root directory (works from both dist/ and dist-test/src/).
 */
export function findPackageRoot(): string | null {
  let current = path.resolve(__dirname);
  while (true) {
    const pkgJsonPath = path.join(current, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { name?: string };
        if (parsed.name === 'wpai-cli') {
          return current;
        }
      } catch {
        // continue walking up
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * Read the package version from package.json so CLI and MCP stay in sync.
 */
export function getPackageVersion(): string {
  const pkgRoot = findPackageRoot();
  if (pkgRoot) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')
      ) as { version?: string };
      if (typeof parsed.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    } catch {
      // fall through
    }
  }
  return '0.2.2';
}

/**
 * Locate an asset bundled inside the published npm package (packages/wpai-cli/assets/).
 */
export function findBundledAsset(relativeTarget: string): string | null {
  const pkgRoot = findPackageRoot();
  if (!pkgRoot) return null;
  const candidate = path.join(pkgRoot, 'assets', relativeTarget);
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Locate the WPAI repository root containing registry/wp-capabilities.json.
 */
export function findRepoRoot(): string | null {
  const fromPkg = walkUpFor(__dirname, 'registry/wp-capabilities.json');
  if (fromPkg) {
    return path.dirname(path.dirname(fromPkg));
  }
  return null;
}

export function findRegistryPath(explicitPath?: string): string {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Registry file not found: ${resolved}`);
    }
    return resolved;
  }

  const fromBundled = findBundledAsset('registry/wp-capabilities.json');
  if (fromBundled) return fromBundled;

  const fromPkg = walkUpFor(__dirname, 'registry/wp-capabilities.json');
  if (fromPkg) return fromPkg;

  throw new Error(
    'Could not locate registry/wp-capabilities.json. Pass an explicit path or reinstall wpai-cli.'
  );
}

export function findRegistrySchemaPath(explicitPath?: string): string {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Registry schema file not found: ${resolved}`);
    }
    return resolved;
  }

  const fromBundled = findBundledAsset('registry/schema/wp-capabilities.schema.json');
  if (fromBundled) return fromBundled;

  const fromPkg = walkUpFor(__dirname, 'registry/schema/wp-capabilities.schema.json');
  if (fromPkg) return fromPkg;

  throw new Error(
    'Could not locate registry/schema/wp-capabilities.schema.json.'
  );
}

export function findPlatformSelectionSkillPath(explicitPath?: string): string {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Platform selection skill file not found: ${resolved}`);
    }
    return resolved;
  }

  const fromBundled = findBundledAsset('skills/wp-platform-selection/SKILL.md');
  if (fromBundled) return fromBundled;

  const fromPkg = walkUpFor(__dirname, 'skills/wp-platform-selection/SKILL.md');
  if (fromPkg) return fromPkg;

  throw new Error(
    'Could not locate skills/wp-platform-selection/SKILL.md.'
  );
}

export interface BlueprintPresetLocation {
  dir: string;
  source: 'bundled-assets' | 'repo-blueprints';
}

/**
 * Locate a preset directory: bundled package assets first, then the dev repo relative to
 * __dirname (never process.cwd(), see T6).
 */
export function resolveBlueprintPresetDir(preset: PresetName): BlueprintPresetLocation | null {
  const rel = path.join('blueprints', preset, 'blueprint.json');
  const fromBundled = findBundledAsset(rel);
  if (fromBundled) return { dir: path.dirname(fromBundled), source: 'bundled-assets' };

  const fromPkg = walkUpFor(__dirname, rel);
  if (fromPkg) return { dir: path.dirname(fromPkg), source: 'repo-blueprints' };

  return null;
}

export function findBlueprintPresetDir(preset: PresetName): string | null {
  return resolveBlueprintPresetDir(preset)?.dir ?? null;
}

/**
 * Locate a bundled PHP probe/extractor script (`assets/php/<file>` first, then `src/php/<file>`;
 * never `process.cwd()`, per T6).
 */
export function findPhpAssetPath(
  fileName: 'verify-probe.php' | 'materialize-presnapshot.php' | 'materialize-extract.php',
  explicitPath?: string
): string {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`PHP helper script not found: ${resolved}`);
    }
    return resolved;
  }

  const fromBundled = findBundledAsset(path.join('php', fileName));
  if (fromBundled) return fromBundled;

  const pkgRoot = findPackageRoot();
  if (pkgRoot) {
    const fromSrc = path.join(pkgRoot, 'src', 'php', fileName);
    if (fs.existsSync(fromSrc)) return fromSrc;
  }

  const fromWalk = walkUpFor(__dirname, path.join('packages', 'wpai-cli', 'src', 'php', fileName));
  if (fromWalk) return fromWalk;

  throw new Error(`Could not locate PHP asset "${fileName}". Run "npm run build" or reinstall wpai-cli.`);
}

export function findVerifyProbePhpPath(explicitPath?: string): string {
  return findPhpAssetPath('verify-probe.php', explicitPath);
}

export interface PlaygroundInvocation {
  command: string;
  baseArgs: string[];
  source: 'local-bin' | 'npx-fallback';
}

/**
 * Resolve the official @wp-playground/cli binary (pinned to 3.1.66).
 */
export function findPlaygroundCli(): PlaygroundInvocation {
  const binNames = ['wp-playground-cli', 'wp-playground'];
  const searchRoots = [__dirname];

  for (const root of searchRoots) {
    for (const binName of binNames) {
      const binPath = walkUpFor(root, path.join('node_modules', '.bin', binName));
      if (binPath) {
        return {
          command: binPath,
          baseArgs: [],
          source: 'local-bin',
        };
      }
    }
  }

  return {
    command: 'npx',
    baseArgs: ['-y', '@wp-playground/cli@3.1.66'],
    source: 'npx-fallback',
  };
}

export interface ResolvedBlueprintTarget {
  blueprintPath: string;
  baseDir: string;
  verifySpecPath: string | null;
}

/**
 * Resolve either a project directory (containing blueprint.json) or a direct .json file path.
 */
export function resolveBlueprintTarget(
  dirOrFile: string,
  explicitChecksPath?: string
): ResolvedBlueprintTarget {
  const abs = path.resolve(dirOrFile);
  if (!fs.existsSync(abs)) {
    throw new Error(`Target does not exist: ${abs}`);
  }

  const stat = fs.statSync(abs);
  let blueprintPath: string;
  let baseDir: string;

  if (stat.isDirectory()) {
    baseDir = abs;
    blueprintPath = path.join(abs, 'blueprint.json');
    if (!fs.existsSync(blueprintPath)) {
      throw new Error(`No blueprint.json found in directory: ${abs}`);
    }
  } else {
    blueprintPath = abs;
    baseDir = path.dirname(abs);
  }

  let verifySpecPath: string | null = null;
  if (explicitChecksPath) {
    const resolvedChecks = path.resolve(explicitChecksPath);
    if (!fs.existsSync(resolvedChecks)) {
      throw new Error(`Verification checks file not found: ${resolvedChecks}`);
    }
    verifySpecPath = resolvedChecks;
  } else {
    const adjacent = path.join(baseDir, 'verify.json');
    if (fs.existsSync(adjacent)) {
      verifySpecPath = adjacent;
    }
  }

  return {
    blueprintPath,
    baseDir,
    verifySpecPath,
  };
}
