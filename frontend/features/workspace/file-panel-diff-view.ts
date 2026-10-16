import type { ToolEditReview } from '../../../contracts/session.js';
import type { ProjectGitDiff, ProjectGitSnapshot } from '../../../contracts/workspace/project-git.js';
import { t } from '../../shared/i18n.js';
import { el } from '../../shared/dom.js';
import { actionButton } from './file-panel-ui.js';
import { gitStatusLabel } from './file-panel-format.js';
import type { ProjectDiffViewer } from './editors/types.js';

type FilePanelDiffMode = 'files' | 'changes' | 'review';

interface ReviewSource {
  sessionId: string;
  callId: string;
  indices: number[];
  cursor: number;
}

export interface FilePanelDiffViewRuntime {
  preview: HTMLElement;
  mode(): FilePanelDiffMode;
  gitDiffPath(): string | null;
  gitDiffValue(): ProjectGitDiff | null;
  gitSnapshot(): ProjectGitSnapshot | null;
  reviewSource(): ReviewSource | null;
  reviewValue(): ToolEditReview | null;
  replacePreview(...nodes: Node[]): void;
  destroyCodeViewer(): void;
  destroyPdfViewer(): void;
  baseName(path: string): string;
  selectReview(cursor: number): void;
  leaveReview(): void;
  closeGitDiff(): void;
}

// Owns diff preview rendering and the asynchronously mounted diff editor.
export function createFilePanelDiffView(runtime: FilePanelDiffViewRuntime) {
  let viewer: ProjectDiffViewer | null = null;
  let mountToken = 0;
  let renderedRevision: string | null = null;

  function destroy(): void {
    renderedRevision = null;
    mountToken++;
    viewer?.destroy();
    viewer = null;
  }

  function isCurrent(value: ProjectGitDiff | ToolEditReview, revision: string, token: number): boolean {
    const mode = runtime.mode();
    const active = mode === 'changes'
      ? runtime.gitDiffPath() === value.path
      : mode === 'review' && runtime.reviewValue() === value;
    return token === mountToken && active && revision === renderedRevision;
  }

  async function mount(value: ProjectGitDiff | ToolEditReview, host: HTMLElement, language: HTMLElement, revision: string): Promise<void> {
    const token = ++mountToken;
    const module = await import('./editors/diff-viewer.js');
    if (!isCurrent(value, revision, token)) return;
    const created = await module.createProjectDiffViewer({
      parent: host,
      filename: value.path,
      baseText: value.baseText ?? '',
      currentText: value.currentText ?? ''
    });
    if (!isCurrent(value, revision, token)) {
      created.destroy();
      return;
    }
    viewer = created;
    language.textContent = created.language;
  }

  function render(): void {
    const historical = runtime.mode() === 'review';
    const reviewValue = runtime.reviewValue();
    const reviewSource = runtime.reviewSource();
    const gitDiffPath = runtime.gitDiffPath();
    const path = historical ? reviewValue?.path ?? t('Review edit') : gitDiffPath;
    const preview = runtime.preview;
    if (!path) {
      destroy();
      preview.hidden = true;
      runtime.replacePreview();
      return;
    }
    const value = historical ? reviewValue : runtime.gitDiffValue();
    const revision = historical
      ? `review\0${reviewSource?.callId ?? ''}\0${reviewSource?.cursor ?? 0}`
      : `${runtime.gitSnapshot()?.revision ?? ''}\0${gitDiffPath}`;
    if (renderedRevision === revision && (viewer || (value && 'binary' in value && (value.binary || value.tooLarge)))) {
      preview.hidden = false;
      return;
    }
    runtime.destroyCodeViewer();
    runtime.destroyPdfViewer();
    destroy();
    renderedRevision = revision;
    const head = el('div', 'file-preview-head');
    const title = el('div', 'file-preview-title');
    const resolvedPath = value?.path ?? path;
    const name = el('strong', '', runtime.baseName(resolvedPath));
    name.title = resolvedPath;
    title.append(name);
    const actions = el('div', 'file-preview-actions');
    if (historical && reviewSource && reviewSource.indices.length > 1) {
      const previous = actionButton(() => t('Previous edited file'), 'i-back', () => runtime.selectReview(reviewSource.cursor - 1));
      previous.disabled = reviewSource.cursor === 0;
      const next = actionButton(() => t('Next edited file'), 'i-arrow-right', () => runtime.selectReview(reviewSource.cursor + 1));
      next.disabled = reviewSource.cursor === reviewSource.indices.length - 1;
      actions.append(previous, el('span', 'file-review-counter', `${reviewSource.cursor + 1}/${reviewSource.indices.length}`), next);
    }
    actions.append(actionButton(() => t('Close preview'), 'i-x', historical ? runtime.leaveReview : runtime.closeGitDiff));
    head.append(title, actions);
    if (!value) {
      runtime.replacePreview(head, el('p', 'file-preview-empty', () => t('Loading diff…')));
      preview.hidden = false;
      return;
    }
    const language = el('span', 'file-editor-language', () => t('Detecting language…'));
    const meta = el('div', 'file-preview-meta file-editor-meta');
    const status = historical
      ? `${t('This edit')} · ${value.path} · +${(value as ToolEditReview).added} −${(value as ToolEditReview).removed}`
      : 'previousPath' in value && value.previousPath
        ? `${gitStatusLabel(value.status)} · ${value.previousPath} → ${value.path}`
        : `${gitStatusLabel((value as ProjectGitDiff).status)} · ${value.path}`;
    meta.append(el('span', '', status), language);
    if (('binary' in value && (value.binary || value.tooLarge)) || value.baseText === null || value.currentText === null) {
      language.remove();
      runtime.replacePreview(head, meta, el('p', 'file-preview-empty', 'note' in value ? value.note ?? (() => t('Diff preview unavailable')) : () => t('Diff preview unavailable')));
      preview.hidden = false;
      return;
    }
    const host = el('div', 'file-code-editor-host file-diff-viewer-host');
    preview.classList.remove('is-editing', 'has-pdf-viewer');
    preview.classList.add('has-code-viewer', 'has-diff-viewer');
    runtime.replacePreview(head, meta, host);
    preview.hidden = false;
    void mount(value, host, language, revision);
  }

  return { destroy, render };
}
