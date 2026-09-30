import type { InputAttachment } from '../../../contracts/input.js';
import type { LocalProject } from '../../../contracts/workspace/projects.js';
import type { ProjectFilePreview } from '../../../contracts/workspace/project-files.js';
import { currentLanguage, t } from '../../shared/i18n.js';
import { el, run, toast } from '../../shared/dom.js';
import { actionButton } from './file-panel-ui.js';
import { createFilePreviewContent } from './file-preview-content.js';
import { humanBytes } from './file-panel-format.js';
import type { ProjectCodeEditor } from './editors/types.js';
import type { ProjectPdfViewer } from './file-pdf-viewer.js';

interface FilePreviewControllerOptions {
  body: HTMLElement;
  preview: HTMLElement;
  previewResize: HTMLElement;
  project: () => LocalProject | null;
  selectionPath: () => string;
  previewPath: () => string | null;
  previewValue: () => ProjectFilePreview | null;
  generation: () => number;
  editingPath: () => string | null;
  editablePreview: (value: ProjectFilePreview) => boolean;
  startEditing: (value: ProjectFilePreview) => void;
  captureAttachment?: () => (attachment: InputAttachment) => boolean;
  onAttach?: (attachment: InputAttachment) => void;
  closePreview: () => Promise<void>;
}

export function createFilePreviewController(options: FilePreviewControllerOptions) {
  let renderedPreview: ProjectFilePreview | null = null;
  let pendingCodePreview: ProjectFilePreview | null = null;
  let codeViewer: ProjectCodeEditor | null = null;
  let pdfViewer: ProjectPdfViewer | null = null;
  let pdfAbort: AbortController | null = null;
  let pdfSurfaceRevision: string | null = null;
  let viewerMountToken = 0;
  let pdfMountToken = 0;

  function samePreview(a: ProjectFilePreview | null, b: ProjectFilePreview | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    const keys = Object.keys(a) as (keyof ProjectFilePreview)[];
    return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
  }

  function replacePreview(...nodes: Node[]): void {
    renderedPreview = null;
    options.preview.replaceChildren(options.previewResize, ...nodes);
  }

  function destroyCodeViewer(): void {
    pendingCodePreview = null;
    renderedPreview = null;
    viewerMountToken++;
    codeViewer?.destroy();
    codeViewer = null;
  }

  function destroyPdfViewer(): void {
    renderedPreview = null;
    pdfMountToken++;
    pdfAbort?.abort();
    pdfAbort = null;
    pdfViewer?.destroy();
    pdfViewer = null;
    pdfSurfaceRevision = null;
  }

  function pdfPreviewRevision(value: ProjectFilePreview): string | null {
    return value.pdfDataBase64
      ? `${value.path}\0${value.modifiedAt}\0${value.bytes}\0${value.pdfDataBase64.length}`
      : null;
  }

  function previewTreeButton(): HTMLButtonElement {
    const button = actionButton(() => t('Files'), 'i-folder', () => {
      options.body.classList.toggle('is-reading');
      button.setAttribute('aria-pressed', String(!options.body.classList.contains('is-reading')));
    });
    button.classList.add('file-preview-toggle-tree');
    button.setAttribute('aria-pressed', String(!options.body.classList.contains('is-reading')));
    return button;
  }

  function previewCloseButton(): HTMLButtonElement {
    const button = actionButton(() => t('Close preview'), 'i-x', options.closePreview);
    button.classList.add('file-preview-close');
    return button;
  }

  function viewerHeader(value: ProjectFilePreview): HTMLElement {
    const head = el('div', 'file-preview-head');
    const nameWrap = el('div', 'file-preview-title');
    const name = el('strong', '', value.name);
    name.title = value.path;
    nameWrap.append(name);
    const actions = el('div', 'file-preview-actions');
    actions.append(previewTreeButton());
    if (options.editablePreview(value)) actions.append(actionButton(() => t('Edit'), 'i-pencil', () => options.startEditing(value)));
    const attach = actionButton(() => t('Attach'), 'i-plus', async () => {
      const expected = options.generation();
      const current = options.project();
      if (!current) return;
      const deliver: ((attachment: InputAttachment) => unknown) | undefined = options.captureAttachment?.() ?? options.onAttach;
      const attachment = await run(window.api.attachProjectFile(current.id, value.path));
      if (!attachment || expected !== options.generation() || options.project()?.id !== current.id) return;
      if (deliver?.(attachment) !== false) toast(t('{0} attached', [attachment.name]));
    });
    const copy = actionButton(() => t('Copy path'), 'i-copy', async () => {
      if (await run(window.api.writeClipboard(value.path))) toast(t('Path copied'));
    });
    actions.append(attach, copy, previewCloseButton());
    head.append(nameWrap, actions);
    return head;
  }

  async function mountCodeViewer(
    value: ProjectFilePreview & { text: string },
    host: HTMLElement,
    languageLabel: HTMLElement,
    publish: () => void
  ): Promise<void> {
    const token = ++viewerMountToken;
    pendingCodePreview = value;
    const module = await import('./editors/code-editor.js');
    if (token !== viewerMountToken || options.editingPath() || options.previewPath() !== value.path || options.selectionPath() !== value.path) return;
    const created = await module.createProjectCodeEditor({
      parent: host,
      filename: value.name,
      text: value.text,
      readOnly: true
    });
    if (token !== viewerMountToken || options.editingPath() || options.previewPath() !== value.path || options.selectionPath() !== value.path) {
      created.destroy();
      return;
    }
    languageLabel.textContent = created.language;
    publish();
    codeViewer = created;
  }

  async function mountPdfViewer(value: ProjectFilePreview & { pdfDataBase64: string }, host: HTMLElement, revision: string): Promise<void> {
    const token = ++pdfMountToken;
    const controller = new AbortController();
    pdfAbort = controller;
    const module = await import('./file-pdf-viewer.js');
    if (token !== pdfMountToken || pdfSurfaceRevision !== revision || options.editingPath() || options.previewPath() !== value.path || options.selectionPath() !== value.path) return;
    const created = await module.createProjectPdfViewer({
      parent: host,
      filename: value.name,
      dataBase64: value.pdfDataBase64,
      signal: controller.signal
    });
    if (token !== pdfMountToken || pdfSurfaceRevision !== revision || options.editingPath() || options.previewPath() !== value.path || options.selectionPath() !== value.path) {
      created.destroy();
      return;
    }
    pdfViewer = created;
  }

  function render(): void {
    const editingPath = options.editingPath();
    const previewPath = options.previewPath();
    const previewValue = options.previewValue();
    const selectionPath = options.selectionPath();
    if (editingPath && editingPath === previewPath && selectionPath === previewPath) return;
    if (renderedPreview && previewPath === selectionPath && samePreview(renderedPreview, previewValue)) {
      options.preview.hidden = false;
      return;
    }
    if (!previewPath || !previewValue || selectionPath !== previewPath) {
      destroyCodeViewer();
      destroyPdfViewer();
      options.body.classList.remove('is-reading');
      options.preview.classList.remove('is-editing');
      options.preview.hidden = true;
      replacePreview();
      return;
    }
    if (pendingCodePreview && samePreview(pendingCodePreview, previewValue)) return;
    const value = previewValue;
    const head = viewerHeader(value);
    const meta = el('div', 'file-preview-meta');
    meta.append(el('span', '', `${value.path} · ${humanBytes(value.bytes)} · ${new Date(value.modifiedAt).toLocaleString(currentLanguage())}`));
    const { content, viewerHost, languageLabel, pdfHost, surfaceClass } = createFilePreviewContent(value, meta);
    const publish = (): void => {
      destroyCodeViewer();
      destroyPdfViewer();
      options.preview.classList.remove('is-editing', 'has-code-viewer', 'has-pdf-viewer');
      if (surfaceClass) options.preview.classList.add(surfaceClass);
      replacePreview(head, meta, content);
      renderedPreview = value;
      if (value.truncated) options.preview.append(el('div', 'file-preview-truncated', () => t('Preview truncated.')));
      options.preview.hidden = false;
    };
    if (viewerHost && languageLabel && value.text !== null) {
      void mountCodeViewer(value as ProjectFilePreview & { text: string }, viewerHost, languageLabel, publish);
      return;
    }
    publish();
    if (pdfHost && value.pdfDataBase64) {
      const revision = pdfPreviewRevision(value)!;
      pdfSurfaceRevision = revision;
      void mountPdfViewer(value as ProjectFilePreview & { pdfDataBase64: string }, pdfHost, revision);
    }
  }

  return {
    destroyCodeViewer,
    destroyPdfViewer,
    previewTreeButton,
    previewCloseButton,
    replacePreview,
    samePreview,
    render
  };
}
