const fs = require('node:fs');
const path = require('node:path');

function expandRendererMarkup(source, frontendRoot) {
  const root = path.resolve(frontendRoot);
  const includePattern = /^[\t ]*<!--[\t ]*@include:[\t ]*([^\s]+)[\t ]*-->[\t ]*(?:\r?\n|$)/gm;
  const expand = (markup, activeFiles = []) => markup.replace(includePattern, (_match, request) => {
    const filePath = path.resolve(root, request);
    if (!filePath.startsWith(`${root}${path.sep}`) || path.extname(filePath) !== '.html') {
      throw new Error(`Renderer markup include escapes the shell: ${request}`);
    }
    if (activeFiles.includes(filePath)) {
      throw new Error(`Renderer markup include cycle: ${request}`);
    }
    return expand(fs.readFileSync(filePath, 'utf8'), [...activeFiles, filePath]);
  });
  const resolved = expand(source);
  if (/^[\t ]*<!--[\t ]*@include:/m.test(resolved)) {
    throw new Error('Renderer markup includes could not be fully resolved.');
  }
  return resolved;
}

function readRendererMarkup(repositoryRoot = path.resolve(__dirname, '..')) {
  const frontendRoot = path.join(repositoryRoot, 'frontend');
  const entryPath = path.join(frontendRoot, 'index.html');
  return expandRendererMarkup(fs.readFileSync(entryPath, 'utf8'), frontendRoot);
}

exports.expandRendererMarkup = expandRendererMarkup;
exports.readRendererMarkup = readRendererMarkup;
