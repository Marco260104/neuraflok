import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { beforeAll, afterAll, expect, it } from 'vitest';

let dom: JSDOM;
let renderedMarkdown: typeof import('../frontend/features/chat/chat.js').renderedMarkdown;

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://local.test/' });
  Object.defineProperty(dom.window, 'api', { value: {}, configurable: true });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node
  });
  ({ renderedMarkdown } = await import('../frontend/features/chat/chat.js'));
});
afterAll(() => dom.window.close());

it('produces actual renderer output for the offscreen real-Electron visual check', () => {
  const screenshotExample = renderedMarkdown(
    '## Examples from sample data\n\n' +
    '✅ **Strong matching candidate**\n\nCSV: `Sample product 20mg 30 tablets`\n\n' +
    'Existing: `SAMPLE PRODUCT 20MG 30 TABLETS`\n\n98% name similarity.\n\n---\n\n' +
    '⚠️ **Must not merge automatically**\n\nCSV: `Example product 70mg 60 tablets`\n\n' +
    'Existing: `EXAMPLE PRODUCT 50MG 60 TABLETS`\n\nStrength differs.'
  );
  const summary = renderedMarkdown('### Summary\n\n**Readable Markdown** keeps provider output structured.\n\n- Safe links remain clickable.\n- Code stays in a dedicated block.');
  const sections = [screenshotExample, summary];
  expect(screenshotExample.querySelectorAll('code')).toHaveLength(4);
  expect(summary.querySelectorAll('li')).toHaveLength(2);
  expect(sections.every(section => !section.querySelector('form, input, button, textarea, select, [onclick]'))).toBe(true);

  // This is an opt-in local visual artifact, not a fixture containing real chat/account data.
  const dir = process.env.NEURAFLOK_PROMPT_VISUAL_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'neuraflok-renderer-fragments.html'),
      sections.map((section, i) => `<section class="qa-section" data-test="${i + 1}">${section.outerHTML}</section>`).join('\n'), 'utf8');
  }
});
