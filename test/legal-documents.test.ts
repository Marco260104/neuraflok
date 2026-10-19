import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { beforeAll, expect, it } from 'vitest';
import { readRendererMarkup } from '../scripts/read-renderer-markup.cjs';
import { LEGAL_DOCUMENTS } from '../frontend/features/settings/legal-documents.js';
import { initLegalSettings, openLegalDocument, renderLegalMarkdown } from '../frontend/features/settings/legal-view.js';

const root = process.cwd();
const normalize = (text: string): string => text.replace(/\r\n/g, '\n').trim();

it('keeps the in-app legal copy identical to PRIVACY.md, TERMS.md, and LICENSE', () => {
  expect(normalize(LEGAL_DOCUMENTS.privacy.markdown)).toBe(normalize(readFileSync(path.join(root, 'PRIVACY.md'), 'utf8')));
  expect(normalize(LEGAL_DOCUMENTS.terms.markdown)).toBe(normalize(readFileSync(path.join(root, 'TERMS.md'), 'utf8')));
  expect(LEGAL_DOCUMENTS.privacy.markdown).toContain('NEURAFLOK does not collect, sell, share, or receive your personal data');
  expect(LEGAL_DOCUMENTS.terms.markdown).toContain('NEURAFLOK does not collect your personal data');
  const license = readFileSync(path.join(root, 'LICENSE'), 'utf8');
  expect(license).toContain('MIT License');
  expect(normalize(LEGAL_DOCUMENTS.license.markdown)).toBe(normalize(license.replace(/^[\s\S]*?MIT License/, 'MIT License')));
});

it('turns legal markdown into headings and lists without HTML injection', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const fragment = renderLegalMarkdown('# Title\n\n## Section\n\nA **bold** line.\n\n- One\n- Two', dom.window.document);
  const wrap = dom.window.document.createElement('div');
  wrap.append(fragment);
  expect(wrap.querySelector('h1')?.textContent).toBe('Title');
  expect(wrap.querySelector('h2')?.textContent).toBe('Section');
  expect(wrap.querySelector('strong')?.textContent).toBe('bold');
  expect([...wrap.querySelectorAll('li')].map(item => item.textContent)).toEqual(['One', 'Two']);
  expect(renderLegalMarkdown('<img src=x onerror=alert(1)>', dom.window.document).textContent).toContain('<img src=x');
});

let document: Document;

beforeAll(() => {
  document = new JSDOM(readRendererMarkup(root)).window.document;
  globalThis.document = document;
  globalThis.HTMLDialogElement = document.defaultView!.HTMLDialogElement;
});

it('opens Privacy policy from General settings and shows that NEURAFLOK collects no user data', () => {
  const proto = document.defaultView!.HTMLDialogElement.prototype as HTMLDialogElement & {
    showModal?: () => void;
    close?: () => void;
  };
  if (!proto.showModal) proto.showModal = function showModal() { this.setAttribute('open', ''); };
  if (!proto.close) proto.close = function close() { this.removeAttribute('open'); };

  initLegalSettings();
  const general = document.querySelector('[data-panel="general"]')!;
  expect(general.querySelector('#legalSection h2')?.textContent).toBe('Legal');
  const privacy = document.getElementById('openPrivacyPolicy') as HTMLButtonElement;
  expect(general.contains(privacy)).toBe(true);
  expect(privacy.dataset.legal).toBe('privacy');
  privacy.click();
  const dialog = document.getElementById('legalDialog') as HTMLDialogElement;
  expect(dialog.open || dialog.hasAttribute('open')).toBe(true);
  expect(document.getElementById('legalDialogTitle')?.textContent).toBe('Privacy policy');
  expect(document.getElementById('legalDialogBody')?.textContent).toContain('does not collect, sell, share, or receive your personal data');
  openLegalDocument('terms');
  expect(document.getElementById('legalDialogTitle')?.textContent).toBe('Terms of use');
});
