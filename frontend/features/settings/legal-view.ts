import { $, el } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';
import { LEGAL_DOCUMENTS, type LegalDocumentId } from './legal-documents.js';

function appendInline(parent: HTMLElement, text: string): void {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    const bold = /^\*\*([^*]+)\*\*$/.exec(part);
    if (bold) parent.append(el('strong', '', bold[1]));
    else if (part) parent.append(document.createTextNode(part));
  }
}

/** Turns the checked-in legal markdown into DOM nodes. No innerHTML. */
export function renderLegalMarkdown(markdown: string, documentRef: Document = document): DocumentFragment {
  const fragment = documentRef.createDocumentFragment();
  const blocks = markdown.replace(/\r\n/g, '\n').trim().split(/\n{2,}/);
  for (const block of blocks) {
    const heading = /^(#{1,3})\s+(.+)$/.exec(block);
    if (heading?.[1] && heading[2]) {
      const node = documentRef.createElement(`h${heading[1].length}`);
      node.textContent = heading[2].trim();
      fragment.append(node);
      continue;
    }
    const lines = block.split('\n');
    if (lines.every(line => line.startsWith('- '))) {
      const list = documentRef.createElement('ul');
      for (const line of lines) {
        const item = documentRef.createElement('li');
        appendInline(item, line.slice(2).trim());
        list.append(item);
      }
      fragment.append(list);
      continue;
    }
    const paragraph = documentRef.createElement('p');
    appendInline(paragraph, lines.join(' '));
    fragment.append(paragraph);
  }
  return fragment;
}

export function openLegalDocument(id: LegalDocumentId): void {
  const documentCopy = LEGAL_DOCUMENTS[id];
  const dialog = $<HTMLDialogElement>('legalDialog');
  ui($('legalDialogTitle'), 'textContent', () => t(documentCopy.title));
  const body = documentCopy.markdown.replace(/^# .+\n+/, '');
  $('legalDialogBody').replaceChildren(renderLegalMarkdown(body));
  if (!dialog.open) dialog.showModal();
}

export function initLegalSettings(): void {
  const dialog = $<HTMLDialogElement>('legalDialog');
  const close = (): void => { if (dialog.open) dialog.close(); };
  $('legalDialogClose').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-legal]')) {
    button.addEventListener('click', () => {
      const id = button.dataset.legal as LegalDocumentId | undefined;
      if (id && LEGAL_DOCUMENTS[id]) openLegalDocument(id);
    });
  }
}
