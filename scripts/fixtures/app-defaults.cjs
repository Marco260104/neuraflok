// The app's real default config, for renderer fixtures. Fixtures start from `defaultConfig()` so new settings fields cannot leave the renderer without required state.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

function defaultConfig() {
  const { buildSync } = require('esbuild');
  const outdir = path.join(root, '.tmp/fixture-defaults');
  fs.mkdirSync(outdir, { recursive: true });
  const outfile = path.join(outdir, `config-${process.pid}.cjs`);
  buildSync({
    stdin: { contents: "export { defaultConfig } from './backend/infrastructure/settings/config.ts';", resolveDir: root },
    outfile, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'error'
  });
  try {
    const config = require(outfile).defaultConfig();
    config.ui.lastSeenVersion = require(path.join(root, 'package.json')).version;
    return config;
  } finally {
    fs.rmSync(outfile, { force: true });
  }
}

/** Plain objects merge key by key; arrays and scalars in `patch` replace the default. */
function merge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = base?.[key];
    out[key] = current && typeof current === 'object' && !Array.isArray(current) ? merge(current, value) : value;
  }
  return out;
}

/** JavaScript source for a fixture page: `fixtureConfig(patch)` returns defaults merged with patch. */
function fixtureConfigSource() {
  return `const fixtureDefaults = ${JSON.stringify(defaultConfig())};
const fixtureMerge = ${merge.toString()};
const fixtureConfig = patch => fixtureMerge(fixtureDefaults, patch);`.replace('function merge(', 'function (').replace(/\bmerge\(current, value\)/, 'fixtureMerge(current, value)');
}

// Renderer fixtures ignore the same benign browser message as backend/application/startup.ts.
const BENIGN_RENDERER_ERRORS = ['ResizeObserver loop completed with undelivered notifications.'];

module.exports = { defaultConfig, merge, fixtureConfigSource, BENIGN_RENDERER_ERRORS };
