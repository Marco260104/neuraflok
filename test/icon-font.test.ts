import { readRendererMarkup } from '../scripts/read-renderer-markup.cjs';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = readRendererMarkup(process.cwd());
const iconsCss = read('../frontend/icons.css');
const dom = read('../frontend/shared/dom.ts');
const vocabulary = new Map([...dom.matchAll(/'(i-[a-z0-9-]+)': '([^']+)'/g)].map(match => [match[1]!, match[2]!]));
const rendererRoot = fileURLToPath(new URL('../frontend/', import.meta.url));
function rendererFiles(directory = rendererRoot): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? rendererFiles(file) : entry.isFile() ? [file] : [];
  });
}
const rendererRelative = (file: string) => path.relative(rendererRoot, file).split(path.sep).join('/');
const packageCss = (family: 'regular' | 'fill') =>
  readFileSync(createRequire(import.meta.url).resolve(`@phosphor-icons/web/${family}`), 'utf8');
const codepoints = (css: string, family: string) => new Map([...css.matchAll(
  new RegExp(String.raw`\.${family}\.ph-([a-z0-9-]+):{1,2}before\s*\{\s*content:\s*["']\\([0-9a-f]+)["']`, 'g')
)].map(match => [match[1]!, match[2]!]));

/** Every glyph the renderer can draw, as `family:name`. */
function drawnGlyphs(): Set<string> {
  const glyphs = new Set<string>();
  for (const value of vocabulary.values()) {
    glyphs.add(value.startsWith('fill:') ? `ph-fill:${value.slice(5)}` : `ph:${value.split(' ')[0]}`);
  }
  // Include every renderer page so the browser toolbar and sign-in card retain their glyphs.
  const pages = rendererFiles().filter(file => file.endsWith('.html')).map(file => readFileSync(file, 'utf8'));
  for (const page of [html, ...pages]) {
    for (const [, family, name] of page.matchAll(/class="[^"]*\b(ph|ph-fill) ph-([a-z0-9-]+)/g)) glyphs.add(`${family}:${name}`);
  }
  // Include icon classes emitted by page scripts.
  for (const file of rendererFiles().filter(file => file.endsWith('.ts'))) {
    for (const [, family, name] of readFileSync(file, 'utf8').matchAll(/['"`](?:[a-z-]+ )*(ph|ph-fill) ph-([a-z0-9-]+)/g)) glyphs.add(`${family}:${name}`);
  }
  return glyphs;
}

it('resolves every icon name the renderer uses through the one vocabulary in dom.ts', () => {
  const used = new Set<string>();
  for (const file of rendererFiles().filter(file => file.endsWith('.ts'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(/['"`](i-[a-z0-9-]+)['"`]/g)) used.add(match[1]!);
  }
  expect(used.size).toBeGreaterThan(30);
  expect([...used].filter(name => !vocabulary.has(name))).toEqual([]);
});

it('maps exactly the glyphs the renderer draws, at the codepoints the bundled Phosphor font defines', () => {
  const mapped = new Map([
    ...[...codepoints(iconsCss, 'ph')].map(([name, point]) => [`ph:${name}`, point] as const),
    ...[...codepoints(iconsCss, 'ph-fill')].map(([name, point]) => [`ph-fill:${name}`, point] as const)
  ]);
  expect([...drawnGlyphs()].sort()).toEqual([...mapped.keys()].sort());
  // A package update may renumber glyphs; the copy here must follow the package, not memory.
  const official = { ph: codepoints(packageCss('regular'), 'ph'), 'ph-fill': codepoints(packageCss('fill'), 'ph-fill') };
  expect(official.ph.size).toBeGreaterThan(1000);
  for (const [key, point] of mapped) {
    const [family, name] = key.split(':') as ['ph' | 'ph-fill', string];
    expect(point, key).toBe(official[family].get(name));
  }
});

it('uses the icon font except for explicitly authored interface drawings', () => {
  // Allowed SVG is limited to the product mark, flags, context ring, and authored disclosure chevron.
  for (const [, tag, rest] of html.matchAll(/(<svg\b[^>]*>)([\s\S]{0,80})/g)) {
    const allowed = /class="(sprite|language-flag|setup-folder-icon|setup-connect-icon|nf-loader-svg|disclosure-chevron\b[^"]*)"/.test(tag!) || /^<use href="#i-mark"/.test(rest!) ||
      /^<circle class="context-track"/.test(rest!.trim());
    expect(allowed, tag).toBe(true);
  }
  const drawing = rendererFiles().filter(file => file.endsWith('.ts') &&
    readFileSync(file, 'utf8').includes("createElementNS('http://www.w3.org/2000/svg', 'svg')")).map(rendererRelative);
  // Only the shared DOM module draws an inline SVG disclosure chevron.
  expect(drawing).toEqual(['shared/dom.ts']);
});

it('keeps only the bespoke product mark in the inline sprite', () => {
  const sprite = html.slice(html.indexOf('<svg class="sprite"'), html.indexOf('</defs>'));
  expect([...sprite.matchAll(/<g id="(i-[a-z0-9-]+)"/g)].map(match => match[1])).toEqual(['i-mark']);
  expect([...new Set([...html.matchAll(/href="#(i-[a-z0-9-]+)"/g)].map(match => match[1]))]).toEqual(['i-mark']);
  expect(html).toContain('href="./icons.css"');
});
