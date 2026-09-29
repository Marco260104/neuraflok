import type { InputAttachment } from '../../../contracts/input.js';
import { disclosureChevron, el, icon } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';
import { actionButton } from './file-panel-ui.js';

export interface FilePanelOptions {
  host: HTMLElement;
  mount?: HTMLElement;
  toggle?: HTMLButtonElement;
  reviewOnly?: boolean;
  onOpenChanges?: () => void;
  onEscape?: () => void;
  onShow?: () => void;
  onAttach?: (attachment: InputAttachment) => void;
  captureAttachment?: () => (attachment: InputAttachment) => boolean;
}

export interface FilePanelLayoutActions {
  createFile(): void;
  createFolder(): void;
  rename(): void;
  remove(): void;
  reveal(): void;
  toggleChanges(): void;
  back(): void;
}

export interface FilePanelLayout {
  pane: HTMLElement;
  refresh: HTMLButtonElement;
  newFile: HTMLButtonElement;
  newFolder: HTMLButtonElement;
  rename: HTMLButtonElement;
  remove: HTMLButtonElement;
  reveal: HTMLButtonElement;
  changes: HTMLButtonElement;
  changesBadge: HTMLElement;
  body: HTMLElement;
  tree: HTMLElement;
  changesView: HTMLElement;
  backToFiles: HTMLButtonElement;
  backToFilesLabel: HTMLElement;
  changesHeaderTitle: HTMLElement;
  branchArrow: HTMLElement;
  branchTrigger: HTMLButtonElement;
  branchStats: HTMLElement;
  changesList: HTMLElement;
  preview: HTMLElement;
  previewResize: HTMLElement;
}

export function createFilePanelLayout(options: FilePanelOptions, actions: FilePanelLayoutActions): FilePanelLayout {
  const pane = el('aside', `file-panel${options.reviewOnly ? ' review-panel' : ''}`);
  pane.hidden = true;
  ui(pane, 'aria-label', () => t(options.reviewOnly ? 'Review' : 'Files'));

  const refresh = el('button', 'btn btn-icon file-panel-refresh') as HTMLButtonElement;
  refresh.type = 'button';
  refresh.append(icon('i-retry'));
  ui(refresh, 'title', () => t('Refresh files'));
  ui(refresh, 'aria-label', () => t('Refresh files'));

  const toolbar = el('div', 'file-panel-toolbar');
  const toolbarActions = el('div', 'file-panel-toolbar-actions');
  const newFile = actionButton(() => t('New file'), 'i-plus', actions.createFile);
  const newFolder = actionButton(() => t('New folder'), 'i-folder', actions.createFolder);
  const rename = actionButton(() => t('Rename'), 'i-pencil', actions.rename);
  const remove = actionButton(() => t('Delete'), 'i-trash', actions.remove);
  const reveal = actionButton(() => t('Reveal'), 'i-out', actions.reveal);
  const changes = actionButton(() => t('Changes'), 'i-git-diff', actions.toggleChanges);
  changes.classList.add('file-panel-changes-toggle');
  changes.setAttribute('aria-pressed', 'false');

  const changesBadge = el('span', 'file-panel-changes-badge');
  changesBadge.hidden = true;
  changes.append(changesBadge);
  if (!options.reviewOnly) {
    toolbarActions.append(newFile, newFolder, rename, remove, reveal, changes);
    toolbar.append(toolbarActions, refresh);
  }

  const body = el('div', 'file-panel-body');
  const tree = el('div', 'file-tree');
  tree.setAttribute('role', 'tree');
  const changesView = el('div', 'file-changes-view');
  changesView.hidden = true;
  const changesHeader = el('div', 'file-changes-header');
  const backToFiles = el('button', 'file-changes-back') as HTMLButtonElement;
  backToFiles.type = 'button';
  const backToFilesLabel = el('span', '', () => t('Files'));
  backToFiles.append(icon('i-back'), backToFilesLabel);
  backToFiles.setAttribute('aria-label', t('Back to files'));
  backToFiles.addEventListener('click', actions.back);

  const changesHeaderTitle = el('strong', 'file-changes-header-title', () => t('Working tree'));
  const changesHeaderContent = el('div', 'file-changes-header-content');
  changesHeaderContent.append(backToFiles, changesHeaderTitle);
  const branchArrow = el('span', 'file-branch-arrow');
  branchArrow.append(icon('i-arrow-right'));
  const branchTrigger = el('button', 'file-branch-trigger') as HTMLButtonElement;
  branchTrigger.type = 'button';
  branchTrigger.setAttribute('aria-haspopup', 'dialog');
  branchTrigger.setAttribute('aria-expanded', 'false');
  branchTrigger.append(el('span', 'file-branch-trigger-label', () => t('Working tree')), disclosureChevron('ico'));
  const branchStats = el('span', 'file-branch-stats');
  if (options.reviewOnly) changesHeaderContent.append(branchArrow, branchTrigger, branchStats);
  changesHeader.append(changesHeaderContent);
  if (options.reviewOnly) changesHeader.append(refresh);

  const changesList = el('div', 'file-changes-list');
  changesList.setAttribute('role', 'region');
  ui(changesList, 'aria-label', () => t('Git changes'));
  changesView.append(changesHeader, changesList);
  const preview = el('section', 'file-preview');
  preview.hidden = true;
  const previewResize = el('div', 'file-preview-resize');
  previewResize.tabIndex = 0;
  previewResize.setAttribute('role', 'separator');
  previewResize.setAttribute('aria-orientation', 'horizontal');
  ui(previewResize, 'aria-label', () => t('Resize file preview'));
  body.append(tree, changesView, preview);
  if (!options.reviewOnly) pane.append(toolbar);
  pane.append(body);
  (options.mount ?? options.host).append(pane);

  return {
    pane,
    refresh,
    newFile,
    newFolder,
    rename,
    remove,
    reveal,
    changes,
    changesBadge,
    body,
    tree,
    changesView,
    backToFiles,
    backToFilesLabel,
    changesHeaderTitle,
    branchArrow,
    branchTrigger,
    branchStats,
    changesList,
    preview,
    previewResize
  };
}
