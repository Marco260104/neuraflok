import { cleanProviderReply } from '../../../contracts/messaging/provider-reply.js';
import { safeExternalLink } from '../../../contracts/navigation/external-url.js';
import { withoutMessageReaction } from '../../../contracts/chat/reaction-content.js';
import { Marked, type TokenizerAndRendererExtension } from 'marked';
import { createMathExtensions } from './markdown/math/extensions.js';
import type { MathSlots } from './markdown/math/types.js';
import { renderMath } from './markdown/math/render.js';
import { ui, t } from '../../shared/i18n.js';
import { compactNumber, el, icon, run, toast } from '../../shared/dom.js';
import { sanitizeHtmlTree } from '../../shared/sanitize-html.js';

const api = window.api;
const MAX_RENDERED_MARKUP_CHARS = 256 * 1024;
// Format recorded text with automatic direction and visible truncation.
export function textBlock(className: string, value: string, truncated: boolean, chars: number): HTMLElement {
  const node = el('p', className, value);
  node.setAttribute('dir', 'auto');
  if (truncated) {
    node.append(el('span', 'cut', () => t(" … cut, {0} characters in the original", [compactNumber(chars)])));
  }
  return node;
}

const RENDERED_TAGS = new Set([
  'A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DIV', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HR', 'KBD', 'LI', 'MARK', 'OL', 'P', 'PRE', 'S', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TABLE',
  'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
]);
const DROP_RENDERED_TAGS = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON',
  'TEXTAREA', 'SELECT', 'OPTION', 'META', 'LINK'
]);

function safeRenderedHref(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith('#')) return trimmed;
  return safeExternalLink(trimmed) ? trimmed : null;
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** Recover visible Markdown structure from roadmap-like answers whose provider left the title and phase details as plain paragraphs. */
function normalizeStructuredAnswerMarkdown(value: string): string {
  const blocks = value.split(/\n\s*\n/).map(block => block.trim()).filter(Boolean);
  const markdownBlock = (block: string): boolean => /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\||-{3,}|_{3,}|\*{3,})/.test(block);
  if (blocks.length >= 4) {
    const title = blocks[0]!;
    const plainTitle = title.length <= 100 &&
      !/[.!?:;]$/.test(title) &&
      !markdownBlock(title) &&
      !/[`*_~]/.test(title);
    if (plainTitle) {
      const phases: Array<{ index: number; number: number; title: string }> = [];
      for (let index = 1; index < blocks.length; index++) {
        const match = blocks[index]!.match(/^(\d+)[.)]\s+([^\n]+)$/);
        if (match) phases.push({ index, number: Number(match[1]), title: match[2]! });
      }
      if (phases.length >= 3 && !phases.some((phase, index) => phase.number !== index + 1)) {
        const normalized = [`## ${title}`];
        let inPhase = false;
        for (let index = 1; index < blocks.length; index++) {
          const block = blocks[index]!;
          const phase = phases.find(item => item.index === index);
          if (phase) {
            normalized.push(`### ${phase.number}. ${phase.title}`);
            inPhase = true;
          } else {
            normalized.push(inPhase && !markdownBlock(block)
              ? `- ${block.replace(/\n/g, '\n  ')}`
              : block);
          }
        }
        return normalized.join('\n\n');
      }
    }
  }

  // Provider overviews often announce a feature list with a colon, then emit every feature as a separate paragraph.
  const normalized: string[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!;
    const heading = block.match(/^([^\n:]{3,140}):$/);
    if (!heading || markdownBlock(block)) {
      normalized.push(block);
      continue;
    }
    const items: string[] = [];
    let next = index + 1;
    for (; next < blocks.length; next++) {
      const candidate = blocks[next]!;
      if (/^(?:adem[aá]s|tambi[eé]n|adicionalmente|asimismo|also|additionally|in addition|moreover)\b/i.test(candidate) ||
          markdownBlock(candidate) || /^[^\n]{3,140}:$/.test(candidate)) break;
      items.push(candidate);
    }
    if (items.length < 3) {
      normalized.push(block);
      continue;
    }
    normalized.push(`${index === 0 ? '##' : '###'} ${heading[1]!.trim()}`);
    normalized.push(...items.map(item => `- ${item.replace(/\n/g, '\n  ')}`));
    index = next - 1;
  }
  const colonFormatted = normalized.join('\n\n');
  const sectionBlocks = colonFormatted.split(/\n\s*\n/).map(block => block.trim()).filter(Boolean);
  const sections: string[] = [];
  let changedSections = false;
  for (let index = 0; index < sectionBlocks.length; index++) {
    const block = sectionBlocks[index]!;
    const summary = block.match(/^(en resumen|en s[ií]ntesis|resumen|in summary|to summarize|summary):\s*(.+)$/i);
    if (summary) {
      sections.push(`**${summary[1]}:** ${summary[2]}`);
      changedSections = true;
      continue;
    }
    const plainLabel = block.length <= 100 && !/[.!?:;]$/.test(block) &&
      !markdownBlock(block) && !/[`*_~]/.test(block);
    if (!plainLabel) {
      sections.push(block);
      continue;
    }
    const items: string[] = [];
    let next = index + 1;
    for (; next < sectionBlocks.length; next++) {
      const candidate = sectionBlocks[next]!;
      const isSectionLabel = candidate.length <= 100 && !/[.!?:;]$/.test(candidate) &&
        !markdownBlock(candidate) && !/[`*_~]/.test(candidate);
      if (isSectionLabel || /^(?:en resumen|en s[ií]ntesis|resumen|in summary|to summarize|summary):/i.test(candidate) || markdownBlock(candidate)) break;
      items.push(candidate);
    }
    if (items.length < 2) {
      sections.push(block);
      continue;
    }
    sections.push(`## ${block}`);
    sections.push(...items.map(item => `- ${item.replace(/\n/g, '\n  ')}`));
    changedSections = true;
    index = next - 1;
  }
  return changedSections ? sections.join('\n\n') : colonFormatted;
}

const WRITING_BLOCK: TokenizerAndRendererExtension = {
  name: 'writingBlock', level: 'block',
  start: value => value.match(/^:::writing\b/m)?.index,
  tokenizer(value) {
    const match = value.match(/^:::writing(\{[^}\n]*\})?[ \t]*\n([\s\S]*?)(?:\n:::[ \t]*(?:\n|$)|$)/);
    if (!match) return undefined;
    const title = match[1]?.match(/\btitle="([^"\n]*)"/)?.[1] ?? '';
    return { type: 'writingBlock', raw: match[0], title, tokens: this.lexer.blockTokens(match[2] ?? '', []) };
  },
  renderer(token) {
    const heading = token['title'] ? `<p><strong>${escapeHtml(String(token['title']))}</strong></p>` : '';
    return `<blockquote>${heading}${this.parser.parse(token.tokens ?? [])}</blockquote>`;
  }
};

// Convert canonical Markdown into safe transcript DOM.
export function renderedMarkdown(source: string): HTMLElement {
  const text = normalizeStructuredAnswerMarkdown(cleanProviderReply(withoutMessageReaction(source)).slice(0, MAX_RENDERED_MARKUP_CHARS));
  const math: MathSlots = { formulas: [] };
  const parser = new Marked({ gfm: true, extensions: [WRITING_BLOCK, ...createMathExtensions(math)] });
  const html = parser.parse(text, { async: false });
  const box = renderedMessage(html, text);
  renderMath(box, math);
  return box;
}

// Bound and sanitize generated markup before adding app-owned controls.
export function renderedMessage(html: string | null | undefined, fallback: string): HTMLElement {
  const box = el('div', 'msg');
  box.setAttribute('dir', 'auto');
  const safeFallback = fallback.slice(0, MAX_RENDERED_MARKUP_CHARS);
  if (!html) {
    box.textContent = safeFallback;
    return box;
  }
  box.classList.add('rich');
  const template = document.createElement('template');
  template.innerHTML = html.slice(0, MAX_RENDERED_MARKUP_CHARS);
  sanitizeHtmlTree(template.content, {
    allowedTags: RENDERED_TAGS,
    dropTags: DROP_RENDERED_TAGS,
    safeHref: safeRenderedHref,
    preserveDirection: true
  });
  box.append(template.content);
  const openLink = (event: MouseEvent): void => {
    if (event.type === 'auxclick' && event.button !== 1) return;
    const anchor = (event.target as Element | null)?.closest?.('a[href]');
    if (!anchor || !box.contains(anchor)) return;
    const href = safeRenderedHref(anchor.getAttribute('href') ?? '');
    event.preventDefault();
    if (!href) return;
    if (href.startsWith('#')) { document.getElementById(href.slice(1))?.scrollIntoView(); return; }
    void run(api.openLink(href));
  };
  box.addEventListener('click', openLink);
  box.addEventListener('auxclick', openLink);
  for (const table of box.querySelectorAll('table')) {
    const viewport = el('div', 'markdown-table');
    viewport.tabIndex = 0;
    viewport.setAttribute('role', 'region');
    ui(viewport, 'aria-label', () => t("Table"));
    table.replaceWith(viewport);
    viewport.append(table);
  }
  if (!box.textContent?.trim() && safeFallback) {
    box.classList.remove('rich');
    box.textContent = safeFallback;
  } else {
    for (const pre of box.querySelectorAll('pre')) {
      const value = pre.textContent ?? '';
      const panel = el('div', 'markdown-code');
      const header = el('div', 'tool-output-header');
      header.append(icon('i-terminal', 'ico'), el('strong', '', () => t('Code')));
      const copy = el('button', 'tool-copy', () => t('Copy')) as HTMLButtonElement;
      copy.type = 'button';
      copy.addEventListener('click', () => void (async () => {
        if (await run(api.writeClipboard(value))) ui(copy, 'textContent', () => t('Copied'));
        else toast(t('Could not copy text.'));
      })());
      header.append(copy);
      pre.replaceWith(panel);
      panel.append(header, pre);
    }
  }
  return box;
}
