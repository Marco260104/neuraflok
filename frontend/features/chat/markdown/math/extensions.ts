import type { TokenizerAndRendererExtension } from 'marked';
import { reserveFormula, type MathSlots } from './types.js';

const BLOCK_DELIMITERS = [String.raw`\[`, '$$'] as const;
const INLINE_DELIMITERS = [
  { open: String.raw`\(`, close: String.raw`\)`, display: false, multiline: true },
  { open: String.raw`\[`, close: String.raw`\]`, display: true, multiline: true },
  { open: '$$', close: '$$', display: true, multiline: false }
] as const;

function firstOpening(value: string, delimiters: readonly string[]): number | undefined {
  let first = -1;
  for (const delimiter of delimiters) {
    const index = value.indexOf(delimiter);
    if (index >= 0 && (first < 0 || index < first)) first = index;
  }
  return first < 0 ? undefined : first;
}

function tokenizeDelimited(value: string, open: string, close: string, display: boolean, multiline: boolean) {
  if (!value.startsWith(open)) return undefined;
  const closeAt = value.indexOf(close, open.length);
  if (closeAt < 0) return undefined;
  const tex = value.slice(open.length, closeAt);
  if (!tex || (!multiline && /[\r\n]/.test(tex))) return undefined;
  const end = closeAt + close.length;
  return { raw: value.slice(0, end), tex, display };
}

function blockExtension(slots: MathSlots): TokenizerAndRendererExtension {
  return {
    name: 'mathBlock',
    level: 'block',
    start(value) {
      const match = /^(?:\\\[|\$\$)/m.exec(value);
      return match?.index;
    },
    tokenizer(value) {
      for (const delimiter of BLOCK_DELIMITERS) {
        const close = delimiter === '$$' ? '$$' : String.raw`\]`;
        const token = tokenizeDelimited(value, delimiter, close, true, true);
        if (!token) continue;
        const trailing = value.slice(token.raw.length).match(/^[ \t]*(?:\r?\n|$)/);
        if (!trailing) return undefined;
        const raw = token.raw + trailing[0];
        return { type: 'mathBlock', raw, tex: token.tex };
      }
      return undefined;
    },
    renderer(token) {
      return `<p>${reserveFormula(slots, String(token['tex']), true)}</p>`;
    }
  };
}

function inlineExtension(slots: MathSlots): TokenizerAndRendererExtension {
  return {
    name: 'mathInline',
    level: 'inline',
    start(value) {
      return firstOpening(value, INLINE_DELIMITERS.map(({ open }) => open));
    },
    tokenizer(value) {
      for (const delimiter of INLINE_DELIMITERS) {
        const token = tokenizeDelimited(value, delimiter.open, delimiter.close, delimiter.display, delimiter.multiline);
        if (token) return { type: 'mathInline', raw: token.raw, tex: token.tex, display: token.display };
      }
      return undefined;
    },
    renderer(token) {
      return reserveFormula(slots, String(token['tex']), token['display'] === true);
    }
  };
}

export function createMathExtensions(slots: MathSlots): TokenizerAndRendererExtension[] {
  return [blockExtension(slots), inlineExtension(slots)];
}
