import { formulaSlotPattern, type MathFormula, type MathSlots } from './types.js';

const MAX_FORMULA_LENGTH = 8_000;

function formulaHolder(document: Document, formula: MathFormula): HTMLElement {
  const holder = document.createElement(formula.display ? 'div' : 'span');
  holder.className = `${formula.display ? 'math-display' : 'math-inline'} is-source`;
  holder.textContent = sourceText(formula);
  return holder;
}

function sourceText(formula: MathFormula): string {
  return formula.display ? `\\[${formula.tex}\\]` : `\\(${formula.tex}\\)`;
}

function replaceSlots(node: Text, slots: MathSlots, pending: Array<{ holder: HTMLElement; formula: MathFormula }>): void {
  const document = node.ownerDocument;
  const value = node.nodeValue ?? '';
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const match of value.matchAll(formulaSlotPattern)) {
    const start = match.index ?? 0;
    if (start > cursor) fragment.append(document.createTextNode(value.slice(cursor, start)));
    const formula = slots.formulas[Number(match[1])];
    if (!formula) {
      fragment.append(document.createTextNode(match[0]));
    } else {
      const holder = formulaHolder(document, formula);
      fragment.append(holder);
      if (formula.tex.length <= MAX_FORMULA_LENGTH) pending.push({ holder, formula });
    }
    cursor = start + match[0].length;
  }
  if (cursor < value.length) fragment.append(document.createTextNode(value.slice(cursor)));
  node.replaceWith(fragment);
}

function unwrapDisplayParagraphs(root: HTMLElement): void {
  for (const block of root.querySelectorAll<HTMLElement>('p > .math-display:only-child')) {
    const paragraph = block.parentElement;
    if (paragraph?.textContent === block.textContent) paragraph.replaceWith(block);
  }
}

export function renderMath(root: HTMLElement, slots: MathSlots): void {
  if (!slots.formulas.length) return;
  const document = root.ownerDocument;
  const walker = document.createTreeWalker(root, document.defaultView?.NodeFilter.SHOW_TEXT ?? 4);
  const textNodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if ((node.nodeValue ?? '').includes('')) textNodes.push(node as Text);
  }
  const pending: Array<{ holder: HTMLElement; formula: MathFormula }> = [];
  for (const node of textNodes) replaceSlots(node, slots, pending);
  unwrapDisplayParagraphs(root);
  if (!pending.length) return;
  void Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([module]) => {
    for (const { holder, formula } of pending) {
      if (!holder.parentNode) continue;
      try {
        module.default.render(formula.tex, holder, {
          displayMode: formula.display,
          throwOnError: true,
          trust: false,
          strict: 'ignore',
          output: 'htmlAndMathml'
        });
        holder.classList.remove('is-source');
      } catch {
        holder.textContent = sourceText(formula);
      }
    }
    unwrapDisplayParagraphs(root);
  }).catch(() => undefined);
}
