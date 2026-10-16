import type { ProjectFilePreview } from '../../../contracts/workspace/project-files.js';
import { t } from '../../shared/i18n.js';
import { el } from '../../shared/dom.js';
import { markdownPreview } from './file-panel-ui.js';

interface PreviewContent {
  content: HTMLElement;
  viewerHost: HTMLElement | null;
  languageLabel: HTMLElement | null;
  pdfHost: HTMLElement | null;
  surfaceClass: string | null;
}

export function createFilePreviewContent(value: ProjectFilePreview, meta: HTMLElement): PreviewContent {
  if (value.imageDataUrl && value.imageMimeType) {
    const wrap = el('div', 'file-preview-image-wrap');
    const image = document.createElement('img');
    image.className = 'file-preview-image';
    image.src = value.imageDataUrl;
    image.alt = value.name;
    image.decoding = 'async';
    wrap.append(image);
    return { content: wrap, viewerHost: null, languageLabel: null, pdfHost: null, surfaceClass: null };
  }
  if (value.pdfDataBase64) {
    const pdfHost = el('div', 'file-pdf-viewer-host');
    return { content: pdfHost, viewerHost: null, languageLabel: null, pdfHost, surfaceClass: 'has-pdf-viewer' };
  }
  if (value.binary) {
    return { content: el('p', 'file-preview-empty', value.note ?? (() => t('Binary file · preview unavailable'))),
      viewerHost: null, languageLabel: null, pdfHost: null, surfaceClass: null };
  }
  if (value.text === null) {
    return { content: el('p', 'file-preview-empty', value.note ?? t('Preview unavailable')),
      viewerHost: null, languageLabel: null, pdfHost: null, surfaceClass: null };
  }
  if (/\.(?:md|markdown)$/i.test(value.name)) {
    return { content: markdownPreview(value.text), viewerHost: null, languageLabel: null, pdfHost: null, surfaceClass: null };
  }
  meta.classList.add('file-editor-meta');
  const languageLabel = el('span', 'file-editor-language', () => t('Detecting language…'));
  meta.append(languageLabel);
  const viewerHost = el('div', 'file-code-editor-host file-code-viewer-host');
  return { content: viewerHost, viewerHost, languageLabel, pdfHost: null, surfaceClass: 'has-code-viewer' };
}
