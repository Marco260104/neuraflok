import type { ProjectGitSnapshot } from '../../../contracts/workspace/project-git.js';
import type { FilePanelMode } from './file-panel-review.js';
import { el } from '../../shared/dom.js';
import { currentLanguage, t, ui } from '../../shared/i18n.js';

export interface FilePanelHeaderElements {
  changesHeaderTitle: HTMLElement;
  branchArrow: HTMLElement;
  branchTrigger: HTMLButtonElement;
  branchStats: HTMLElement;
  backToFiles: HTMLButtonElement;
  backToFilesLabel: HTMLElement;
  refresh: HTMLButtonElement;
}

export interface FilePanelHeaderRuntime {
  elements: FilePanelHeaderElements;
  mode: FilePanelMode;
  reviewOnly: boolean;
  hasProject: boolean;
  showingDiff: boolean;
  backToChanges: boolean;
  snapshot: ProjectGitSnapshot | null;
  selectedBaseRef: string | null;
}

export function renderFilePanelHeader(runtime: FilePanelHeaderRuntime): void {
  const { elements, mode, reviewOnly, hasProject, showingDiff, backToChanges, snapshot, selectedBaseRef } = runtime;
  const showingChanges = mode === 'changes';
  const showingReview = mode === 'review';

  ui(elements.changesHeaderTitle, 'textContent', () => t(showingReview ? 'Review edit' : showingDiff ? 'Diff' :
    reviewOnly && snapshot?.state === 'ready' ? snapshot.currentBranch ?? 'HEAD' : 'Working tree'));
  elements.branchArrow.hidden = !reviewOnly || showingDiff || !hasProject ||
    (snapshot?.state !== 'ready' && !selectedBaseRef);
  elements.branchTrigger.hidden = elements.branchArrow.hidden;
  elements.branchTrigger.querySelector('.file-branch-trigger-label')!.textContent = selectedBaseRef
    ? snapshot?.comparison?.label ?? selectedBaseRef.replace(/^refs\/(heads|remotes)\//, '')
    : t('Working tree');
  elements.branchStats.hidden = elements.branchTrigger.hidden || !snapshot?.comparison || snapshot.truncated;
  elements.branchStats.replaceChildren();
  if (!elements.branchStats.hidden && snapshot?.state === 'ready') {
    const additions = snapshot.changes.reduce((sum, change) => sum + (change.additions ?? 0), 0);
    const deletions = snapshot.changes.reduce((sum, change) => sum + (change.deletions ?? 0), 0);
    elements.branchStats.append(el('span', 'is-added', `+${additions.toLocaleString(currentLanguage())}`),
      el('span', 'is-deleted', `−${deletions.toLocaleString(currentLanguage())}`));
    elements.branchStats.title = snapshot.truncated ? t('More changes exist than can be shown at once.') :
      t('Committed changes only; local work is excluded');
  }

  elements.backToFiles.hidden = reviewOnly && showingChanges && !showingDiff;
  ui(elements.backToFilesLabel, 'textContent', () => t(backToChanges ? 'Changes' : 'Files'));
  ui(elements.backToFiles, 'aria-label', () => t(backToChanges ? 'Back to changes' : 'Back to files'));
  const refreshLabel = (): string => t(showingChanges ? 'Refresh changes' : 'Refresh files');
  ui(elements.refresh, 'title', refreshLabel);
  ui(elements.refresh, 'aria-label', refreshLabel);
}
