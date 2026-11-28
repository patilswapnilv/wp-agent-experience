import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const assetsRoot = path.join(pkgRoot, 'assets');

const PRESET_NAMES = [
  'small-business',
  'commerce',
  'publishing',
  'nonprofit',
  'course',
  'migration',
];

const blueprintRequiredFile = path.join('small-business', 'blueprint.json');
const blueprintMarkerName = path.basename(blueprintRequiredFile);

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
    requiredFile: blueprintRequiredFile,
    requiredFiles: PRESET_NAMES.map((preset) => path.join(preset, blueprintMarkerName)),
  },
];

function isAssetComplete(baseDir, item) {
  const required = item.requiredFiles ?? [item.requiredFile];
  return required.every((rel) => fs.existsSync(path.join(baseDir, rel)));
}

for (const item of ASSETS_TO_COPY) {
  if (isAssetComplete(item.src, item)) {
    fs.mkdirSync(path.dirname(item.dest), { recursive: true });
    const stageDest = `${item.dest}.tmp-${process.pid}`;
    fs.rmSync(stageDest, { recursive: true, force: true });
    try {
      fs.cpSync(item.src, stageDest, { recursive: true });
      fs.rmSync(item.dest, { recursive: true, force: true });
      fs.renameSync(stageDest, item.dest);
    } finally {
      fs.rmSync(stageDest, { recursive: true, force: true });
    }
  } else if (!isAssetComplete(item.dest, item)) {
    throw new Error(
      `Missing or incomplete required asset source (${item.src}) and no complete pre-bundled copy at ${item.dest}.`
    );
  }
}

const phpSrcDir = path.join(pkgRoot, 'src', 'php');
const phpDestDir = path.join(assetsRoot, 'php');
if (fs.existsSync(path.join(phpSrcDir, 'verify-probe.php'))) {
  fs.mkdirSync(path.dirname(phpDestDir), { recursive: true });
  const stagePhp = `${phpDestDir}.tmp-${process.pid}`;
  fs.rmSync(stagePhp, { recursive: true, force: true });
  try {
    fs.cpSync(phpSrcDir, stagePhp, { recursive: true });
    fs.rmSync(phpDestDir, { recursive: true, force: true });
    fs.renameSync(stagePhp, phpDestDir);
  } finally {
    fs.rmSync(stagePhp, { recursive: true, force: true });
  }
}

