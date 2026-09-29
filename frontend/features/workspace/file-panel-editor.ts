import type { LocalProject } from '../../../contracts/workspace/projects.js';
import type { ProjectFilePreview } from '../../../contracts/workspace/project-files.js';
import { el, run, toast } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';
import { actionButton, requestFileConfirmation } from './file-panel-ui.js';
import { humanBytes } from './file-panel-format.js';
import type { ProjectCodeEditor } from './editors/types.js';

type EditablePreview = ProjectFilePreview & { text: string; revision: string };

interface RetainedDraft {
  preview: EditablePreview;
  text: string;
}

export interface FilePanelEditorRuntime {
  preview: HTMLElement;
  project(): LocalProject | null;
  selectionPath(): string;
  previewPath(): string | null;
  previewValue(): ProjectFilePreview | null;
  setPreviewValue(value: ProjectFilePreview): void;
  replacePreview(...nodes: Node[]): void;
  destroyCodeViewer(): void;
  renderPreview(): void;
  reloadDirectory(relative: string): Promise<void>;
  reconcileGitChanges(forceDiff?: boolean): Promise<void>;
  parentPath(relative: string): string;
  treeButton(): HTMLButtonElement;
  closeButton(): HTMLButtonElement;
}

// Owns edit drafts, optimistic saves, and the editor mount lifecycle.
export function createFilePanelEditor(runtime: FilePanelEditorRuntime) {
  const retainedDrafts = new Map<string, RetainedDraft>();
  let codeEditor: ProjectCodeEditor | null = null;
  let editingPath: string | null = null;
  let originalText = '';
  let draftText = '';
  let dirty = false;
  let externalChange = false;
  let mountToken = 0;
  let saveButton: HTMLButtonElement | null = null;
  let dirtyBadge: HTMLElement | null = null;
  let saving = false;

  function editablePreview(value: ProjectFilePreview): value is EditablePreview {
    return !value.binary && value.text !== null && !value.truncated && typeof value.revision === 'string';
  }

  function destroy(): void {
    mountToken++;
    codeEditor?.destroy();
    codeEditor = null;
    saveButton = null;
    dirtyBadge = null;
    runtime.preview.classList.remove('is-editing');
  }

  function clear(): void {
    destroy();
    editingPath = null;
    originalText = '';
    draftText = '';
    dirty = false;
    externalChange = false;
  }

  function updateDirtyState(): void {
    if (saveButton) saveButton.disabled = !dirty || saving;
    if (!dirtyBadge) return;
    dirtyBadge.hidden = !dirty;
    dirtyBadge.classList.toggle('is-conflict', externalChange);
    ui(dirtyBadge, 'title', () => dirty
      ? externalChange ? t('Unsaved changes · file changed on disk') : t('Unsaved changes')
      : '');
  }

  function markExternalChange(): void {
    if (externalChange) return;
    externalChange = true;
    updateDirtyState();
    toast(t('This file changed on disk while you were editing it. Your unsaved edits were kept.'));
  }

  function fileName(path: string): string {
    const index = path.lastIndexOf('/');
    return index < 0 ? path : path.slice(index + 1);
  }

  async function leaveIfNeeded(): Promise<boolean> {
    if (!editingPath) return true;
    const token = mountToken;
    const owner = runtime.project()?.id;
    if (dirty) {
      const discard = await requestFileConfirmation({
        title: t('Discard changes?'),
        message: t('Your edits to “{0}” have not been saved.', [fileName(editingPath)]),
        detail: t('Discard these edits and continue?'),
        confirm: t('Discard')
      });
      if (!discard || token !== mountToken || owner !== runtime.project()?.id) return false;
    }
    if (owner) retainedDrafts.delete(owner);
    clear();
    return true;
  }

  function retainCurrentProjectDraft(): void {
    const current = runtime.project();
    const value = runtime.previewValue();
    if (!current || !editingPath || !dirty || !value || !editablePreview(value)) return;
    retainedDrafts.set(current.id, { preview: value, text: codeEditor?.getValue() ?? draftText });
  }

  function retainedDraft(projectId: string): RetainedDraft | null {
    return retainedDrafts.get(projectId) ?? null;
  }

  async function stop(): Promise<void> {
    if (!(await leaveIfNeeded())) return;
    runtime.renderPreview();
  }

  async function save(): Promise<void> {
    const current = runtime.project();
    const value = runtime.previewValue();
    if (saving || !current || !value || editingPath !== value.path || !editablePreview(value) || !dirty) return;
    const text = codeEditor?.getValue() ?? draftText;
    const token = mountToken;
    saving = true;
    updateDirtyState();
    try {
      const result = await run(window.api.saveProjectFile(current.id, value.path, text, value.modifiedAt, value.bytes, value.revision));
      if (!result) return;
      const retained = retainedDrafts.get(current.id);
      if (retained?.preview.revision === value.revision && editablePreview(result.preview)) {
        if (retained.text === text) retainedDrafts.delete(current.id);
        else retained.preview = result.preview;
      }
      if (token !== mountToken || runtime.project()?.id !== current.id || runtime.previewPath() !== value.path) return;
      retainedDrafts.delete(current.id);
      runtime.setPreviewValue(result.preview);
      originalText = result.preview.text ?? text;
      draftText = codeEditor?.getValue() ?? draftText;
      dirty = draftText !== originalText;
      externalChange = false;
      if (!dirty) clear();
      toast(t('Saved {0}', [result.preview.name]));
      runtime.renderPreview();
      await runtime.reloadDirectory(runtime.parentPath(result.preview.path));
      await runtime.reconcileGitChanges(true);
    } finally {
      saving = false;
      updateDirtyState();
    }
  }

  async function start(value: ProjectFilePreview, initialText = value.text ?? ''): Promise<void> {
    const current = runtime.project();
    if (!editablePreview(value) || runtime.previewPath() !== value.path || runtime.selectionPath() !== value.path) return;
    if (!current || (!retainedDrafts.has(current.id) && retainedDrafts.size >= 8)) {
      toast(t('Save or discard an existing project draft before editing another project.'));
      return;
    }
    runtime.destroyCodeViewer();
    clear();
    editingPath = value.path;
    originalText = value.text;
    draftText = initialText;
    dirty = initialText !== value.text;
    externalChange = false;
    runtime.preview.classList.add('is-editing');
    runtime.preview.hidden = false;

    const head = el('div', 'file-preview-head');
    const titleWrap = el('div', 'file-preview-title');
    const name = el('strong', '', value.name);
    name.title = value.path;
    const badge = el('span', 'file-editor-dirty', '●');
    badge.hidden = true;
    ui(badge, 'aria-label', () => t('Unsaved changes'));
    dirtyBadge = badge;
    titleWrap.append(name, badge);

    const actions = el('div', 'file-preview-actions');
    const saveAction = actionButton(() => t('Save'), 'i-check', save);
    saveAction.classList.add('file-editor-save');
    saveAction.disabled = true;
    saveButton = saveAction;
    const viewAction = actionButton(() => t('View'), 'i-eye', stop);
    actions.append(saveAction, viewAction, runtime.treeButton(), runtime.closeButton());
    head.append(titleWrap, actions);

    const language = el('span', 'file-editor-language', () => t('Detecting language…'));
    const meta = el('div', 'file-preview-meta file-editor-meta');
    meta.append(el('span', '', `${value.path} · ${humanBytes(value.bytes)}`), language);
    const host = el('div', 'file-code-editor-host');
    runtime.replacePreview(head, meta, host);

    const token = ++mountToken;
    const module = await import('./editors/code-editor.js');
    if (token !== mountToken || editingPath !== value.path || runtime.previewPath() !== value.path) return;
    const created = await module.createProjectCodeEditor({
      parent: host,
      filename: value.name,
      text: initialText,
      onChange: next => {
        if (editingPath !== value.path) return;
        draftText = next;
        dirty = next !== originalText;
        updateDirtyState();
      }
    });
    if (token !== mountToken || editingPath !== value.path || runtime.previewPath() !== value.path) {
      created.destroy();
      return;
    }
    codeEditor = created;
    language.textContent = created.language;
    updateDirtyState();
    created.focus();
  }

  return {
    clear,
    destroy,
    editablePreview,
    editingPath: () => editingPath,
    isDirty: () => dirty,
    leaveIfNeeded,
    markExternalChange,
    retainedDraft,
    retainCurrentProjectDraft,
    save,
    start,
    stop
  };
}
