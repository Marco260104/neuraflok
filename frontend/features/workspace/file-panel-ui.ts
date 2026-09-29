import { safeExternalLink } from '../../../contracts/navigation/external-url.js';
import { marked } from 'marked';
import { t, ui } from '../../shared/i18n.js';
import { el, icon, run } from '../../shared/dom.js';
import { sanitizeHtmlTree } from '../../shared/sanitize-html.js';

const MARKDOWN_TAGS = new Set([
  'A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HR', 'KBD', 'LI', 'OL', 'P', 'PRE', 'S', 'STRONG', 'TABLE', 'TBODY', 'TD', 'TFOOT',
  'TH', 'THEAD', 'TR', 'UL'
]);
const DROP_MARKDOWN_TAGS = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON',
  'TEXTAREA', 'SELECT', 'OPTION', 'META', 'LINK', 'IMG', 'VIDEO', 'AUDIO', 'SOURCE'
]);

export function markdownPreview(source: string): HTMLElement {
  const root = el('div', 'file-preview-markdown');
  const template = document.createElement('template');
  template.innerHTML = marked.parse(source, { async: false, gfm: true });

  sanitizeHtmlTree(template.content, {
    allowedTags: MARKDOWN_TAGS,
    dropTags: DROP_MARKDOWN_TAGS,
    safeHref: value => {
      const href = value.trim();
      return safeExternalLink(href) ? href : null;
    }
  });
  root.append(template.content);
  for (const table of root.querySelectorAll('table')) {
    const viewport = el('div', 'file-preview-markdown-table');
    viewport.tabIndex = 0;
    table.replaceWith(viewport);
    viewport.append(table);
  }
  root.addEventListener('click', event => {
    const anchor = (event.target as Element | null)?.closest?.('a[href]');
    if (!anchor || !root.contains(anchor)) return;
    const href = anchor.getAttribute('href') ?? '';
    event.preventDefault();
    if (safeExternalLink(href)) void run(window.api.openLink(href));
  });
  return root;
}

export function actionButton(label: () => string, glyph: string, action: () => void | Promise<void>): HTMLButtonElement {
  const button = el('button', 'btn file-panel-action') as HTMLButtonElement;
  button.type = 'button';
  button.append(icon(glyph), el('span', '', label));
  ui(button, 'title', label);
  button.addEventListener('click', () => void action());
  return button;
}

export function requestEntryName(options: { title: string; initial?: string; confirm: string }): Promise<string | null> {
  document.querySelector('.file-entry-dialog')?.remove();
  return new Promise(resolve => {
    const box = document.createElement('dialog');
    box.className = 'file-entry-dialog';
    const form = document.createElement('form');
    form.className = 'file-entry-dialog-form';
    form.noValidate = true;
    const heading = el('h2', '', options.title);
    const label = el('label', 'file-entry-dialog-field');
    const input = document.createElement('input');
    input.className = 'file-entry-dialog-input';
    input.type = 'text';
    input.maxLength = 255;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = options.initial ?? '';
    label.append(el('span', '', () => t('Name')), input);
    const actions = el('div', 'file-entry-dialog-actions');
    const cancel = el('button', 'btn', () => t('Cancel')) as HTMLButtonElement;
    cancel.type = 'button';
    const confirm = el('button', 'btn btn-solid', options.confirm) as HTMLButtonElement;
    confirm.type = 'submit';
    actions.append(cancel, confirm);
    form.append(heading, label, actions);
    box.append(form);
    document.body.append(box);

    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      box.remove();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(null));
    box.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    input.addEventListener('input', () => input.setCustomValidity(''));
    form.addEventListener('submit', event => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value || value === '.' || value === '..' || /[\\/\0]/.test(value)) {
        input.setCustomValidity(t('Use one file or folder name.'));
        input.reportValidity();
        return;
      }
      finish(value);
    });

    if (typeof box.showModal === 'function') box.showModal();
    else box.setAttribute('open', '');
    input.focus();
    input.select();
  });
}

export function requestFileConfirmation(options: { title: string; message: string; detail?: string; confirm: string }): Promise<boolean> {
  document.querySelector('.file-confirm-dialog')?.remove();
  return new Promise(resolve => {
    const box = document.createElement('dialog');
    box.className = 'file-confirm-dialog';
    const body = el('div', 'file-confirm-dialog-body');
    body.append(el('h2', '', options.title), el('p', 'file-confirm-dialog-message', options.message));
    if (options.detail) body.append(el('p', 'file-confirm-dialog-detail', options.detail));
    const actions = el('div', 'file-entry-dialog-actions');
    const cancel = el('button', 'btn', () => t('Cancel')) as HTMLButtonElement;
    cancel.type = 'button';
    const confirm = el('button', 'btn btn-solid file-dialog-danger', options.confirm) as HTMLButtonElement;
    confirm.type = 'button';
    actions.append(cancel, confirm);
    body.append(actions);
    box.append(body);
    document.body.append(box);

    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      box.remove();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));
    box.addEventListener('cancel', event => { event.preventDefault(); finish(false); });

    if (typeof box.showModal === 'function') box.showModal();
    else box.setAttribute('open', '');
    confirm.focus();
  });
}
