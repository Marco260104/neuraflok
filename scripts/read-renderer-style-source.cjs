const fs = require('node:fs');
const path = require('node:path');

function readRendererStyleSource(root = path.resolve(__dirname, '..'), entry = 'styles.css') {
  const frontendPath = path.join(root, 'frontend');
  const entryPath = path.resolve(frontendPath, entry);
  let imports = 0;
  const expand = (filePath, ancestry = new Set()) => {
    const resolvedPath = path.resolve(filePath);
    const relative = path.relative(path.resolve(frontendPath), resolvedPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Renderer style import escapes frontend: ${filePath}`);
    }
    if (ancestry.has(resolvedPath)) throw new Error(`Renderer style import cycle: ${resolvedPath}`);
    const nextAncestry = new Set(ancestry).add(resolvedPath);
    const source = fs.readFileSync(resolvedPath, 'utf8');
    return source.replace(/^@import[ \t]+["']([^"']+)["'];[ \t]*(?:\r?\n|$)/gm, (_match, request) => {
      imports += 1;
      return expand(path.resolve(path.dirname(resolvedPath), request), nextAncestry);
    });
  };
  const resolved = expand(entryPath);
  if (imports === 0 || /^\s*@import\b/m.test(resolved)) {
    throw new Error('Renderer style imports could not be fully resolved.');
  }
  return resolved;
}

module.exports = { readRendererStyleSource };
