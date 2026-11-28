import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const assetsRoot = path.join(pkgRoot, 'assets');

const ASSETS_TO_COPY = [
  {
    src: path.join(repoRoot, 'registry'),
    dest: path.join(assetsRoot, 'registry'),
    requiredFile: 'wp-capabilities.json',
  },
  {
    src: path.join(repoRoot, 'skills', 'wp-platform-selection'),
    dest: path.join(assetsRoot, 'skills', 'wp-platform-selection'),
    requiredFile: 'SKILL.md',
  },
  {
    // Canonical `wpai init` presets; presets.ts reads these instead of inlining copies.
    src: path.join(repoRoot, 'blueprints'),
    dest: path.join(assetsRoot, 'blueprints'),
    requiredFile: path.join('small-business', 'blueprint.json'),
  },
];

for (const item of ASSETS_TO_COPY) {
  if (fs.existsSync(path.join(item.src, item.requiredFile))) {
    fs.rmSync(item.dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(item.dest), { recursive: true });
    fs.cpSync(item.src, item.dest, { recursive: true });
  } else if (!fs.existsSync(path.join(item.dest, item.requiredFile))) {
    throw new Error(
      `Missing required asset source (${item.src}) and no pre-bundled copy at ${item.dest}.`
    );
  }
}
