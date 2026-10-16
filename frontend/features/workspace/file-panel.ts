import type { LocalProject } from '../../../contracts/workspace/projects.js';
import type { ProjectDirectoryListing, ProjectFilePreview } from '../../../contracts/workspace/project-files.js';
import type { ProjectGitChanged } from '../../../contracts/workspace/project-git.js';
import { t, ui } from '../../shared/i18n.js';
import { attachWorkPanelResize } from './work-panel-resize.js';
import { createFilePreviewController } from './file-preview-controller.js';
import { installFileBranchSelector } from './file-panel-branch-selector.js';
import { attachFilePreviewResize } from './file-preview-resize.js';
import { createFileTreeView } from './file-panel-tree.js';
import { createFilePanelWatch } from './file-panel-watch.js';
import { createFilePanelEditor } from './file-panel-editor.js';
import { createFilePanelActions, type FilePanelSelection } from './file-panel-actions.js';
import { createFilePanelLayout, type FilePanelOptions } from './file-panel-layout.js';
import { createFilePanelNavigation } from './file-panel-navigation.js';
import { createFilePanelDiffView } from './file-panel-diff-view.js';
import { createFilePanelReview } from './file-panel-review.js';
import { createFilePanelGitController } from './file-panel-git-controller.js';
import { renderFilePanelHeader } from './file-panel-header.js';
import { createFilePanelActionState } from './file-panel-action-state.js';

function parentPath(relative: string): string {
  const at = relative.lastIndexOf('/');
  return at < 0 ? '' : relative.slice(0, at);
}

function baseName(relative: string): string {
  const at = relative.lastIndexOf('/');
  return at < 0 ? relative : relative.slice(at + 1);
}

// File operations use project-relative paths; the main process re-resolves filesystem authority.
export function createFilePanel(options: FilePanelOptions) {
  const {
    pane, refresh, newFile, newFolder, rename, remove, reveal, changes, changesBadge, body, tree, changesView, backToFiles, backToFilesLabel,
    changesHeaderTitle, branchArrow, branchTrigger, branchStats, changesList, preview, previewResize
    } = createFilePanelLayout(options, {
    createFile: () => { void fileActions.createEntry('file'); },
    createFolder: () => { void fileActions.createEntry('directory'); },
    rename: () => { void fileActions.renameSelection(); },
    remove: () => { void fileActions.deleteSelection(); },
    reveal: () => { void fileActions.revealSelection(); },
    toggleChanges: () => options.onOpenChanges ? options.onOpenChanges() : toggleChanges(),
    back: () => {
      if (mode === 'review') {
        const returnsToFiles = fileReview.returnMode() === 'files';
        fileReview.leaveReview();
        if (returnsToFiles) tree.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')?.focus();
      } else if (git.diffPath()) git.closeDiff();
      else {
        git.showFiles();
        tree.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')?.focus();
      }
    }
  });
  if (!options.mount) attachWorkPanelResize(options.host, pane);

  let project: LocalProject | null = null;
  let generation = 0;
  let selection: FilePanelSelection = { path: '', kind: 'root' };
  let previewPath: string | null = null;
  let previewValue: ProjectFilePreview | null = null;
  let mode: 'files' | 'changes' | 'review' = options.reviewOnly ? 'changes' : 'files';
  let expanded = new Set<string>(['']);
  const listings = new Map<string, ProjectDirectoryListing>();
  let fileEditor!: ReturnType<typeof createFilePanelEditor>;
  let fileReview!: ReturnType<typeof createFilePanelReview>;
  let git!: ReturnType<typeof createFilePanelGitController>;
  const navigation = createFilePanelNavigation({
    project: () => project,
    generation: () => generation,
    setGeneration(value) { generation = value; },
    selection: () => selection,
    setSelection(value) { selection = value; },
    setPreviewPath(value) { previewPath = value; },
    setPreviewValue(value) { previewValue = value; },
    listings: () => listings,
    expanded: () => expanded,
    editingPath: () => fileEditor.editingPath(),
    leaveEditorIfNeeded: () => fileEditor.leaveIfNeeded(),
    render,
    renderPreview: () => renderPreview()
  });
  const filePreview = createFilePreviewController({
    body,
    preview,
    previewResize,
    project: () => project,
    selectionPath: () => selection.path,
    previewPath: () => previewPath,
    previewValue: () => previewValue,
    generation: () => generation,
    editingPath: () => fileEditor.editingPath(),
    editablePreview: value => fileEditor.editablePreview(value),
    startEditing: value => { void fileEditor.start(value); },
    captureAttachment: options.captureAttachment,
    onAttach: options.onAttach,
    closePreview: navigation.closePreview
  });
  const diffView = createFilePanelDiffView({
    preview,
    mode: () => mode,
    gitDiffPath: () => git.diffPath(),
    gitDiffValue: () => git.diffValue(),
    gitSnapshot: () => git.snapshot(),
    reviewSource: () => fileReview.source(),
    reviewValue: () => fileReview.value(),
    replacePreview: filePreview.replacePreview,
    destroyCodeViewer: filePreview.destroyCodeViewer,
    destroyPdfViewer: filePreview.destroyPdfViewer,
    baseName,
    selectReview: cursor => { void fileReview.selectReview(cursor); },
    leaveReview: () => fileReview.leaveReview(),
    closeGitDiff: () => git.closeDiff()
  });
  const replacePreview = filePreview.replacePreview;
  const destroyCodeViewer = filePreview.destroyCodeViewer;
  const destroyPdfViewer = filePreview.destroyPdfViewer;
  const renderPreview = filePreview.render;
  const fileEditorRuntime: Parameters<typeof createFilePanelEditor>[0] = {
    preview,
    project: () => project,
    selectionPath: () => selection.path,
    previewPath: () => previewPath,
    previewValue: () => previewValue,
    setPreviewValue(value) { previewValue = value; },
    replacePreview,
    destroyCodeViewer,
    renderPreview,
    reloadDirectory: navigation.reloadDirectory,
    reconcileGitChanges: forceDiff => git.reconcile(forceDiff),
    parentPath,
    treeButton: filePreview.previewTreeButton,
    closeButton: filePreview.previewCloseButton
  };
  fileEditor = createFilePanelEditor(fileEditorRuntime);
  fileReview = createFilePanelReview({
    project: () => project,
    generation: () => generation,
    mode: () => mode,
    setMode(value) { mode = value; },
    editingPath: fileEditor.editingPath,
    leaveEditorIfNeeded: fileEditor.leaveIfNeeded,
    destroyCodeViewer: filePreview.destroyCodeViewer,
    destroyPdfViewer: filePreview.destroyPdfViewer,
    destroyDiffViewer: diffView.destroy,
    restoreChangesDiff: () => git.restoreDiffAfterReview(),
    show,
    render,
    pane,
    body,
    backToFiles
  });
  const fileWatch = createFilePanelWatch({
    reviewOnly: options.reviewOnly === true,
    project: () => project,
    visible: () => !pane.hidden,
    generation: () => generation,
    gitSnapshot: () => git.snapshot(),
    listings: () => listings,
    expanded: () => expanded,
    selectedPath: () => selection.path,
    setSelection(path, kind) { selection = { path, kind }; },
    previewPath: () => previewPath,
    previewValue: () => previewValue,
    setPreviewPath(path) { previewPath = path; },
    setPreviewValue(value) { previewValue = value; },
    editingPath: fileEditor.editingPath,
    editorDirty: fileEditor.isDirty,
    parentPath,
    samePreview: filePreview.samePreview,
    editablePreview: fileEditor.editablePreview,
    scheduleGitReconcile: () => git.scheduleReconcile(),
    markEditorExternalChange: fileEditor.markExternalChange,
    clearEditorState: fileEditor.clear,
    render,
    renderPreview,
    startEditing: fileEditor.start,
    setListing(directory, listing) { listings.set(directory, listing); }
  });
  const branchSelector = installFileBranchSelector(branchTrigger, {
    project: () => project,
    snapshot: () => git.snapshot(),
    selectedBaseRef: () => git.selectedBaseRef(),
    selectBaseRef(ref) {
      git.selectBaseRef(ref);
    }
  });
  attachFilePreviewResize(body, pane, preview, previewResize);

  function destroyDiffViewer(): void {
    diffView.destroy();
  }

  function hide(): void {
    branchSelector.close();
    generation++;
    git.cancelScheduledReconcile();
    destroyPdfViewer();
    destroyDiffViewer();
    pane.hidden = true;
    if (!options.mount) options.host.classList.remove('has-file-panel');
    options.toggle?.setAttribute('aria-expanded', 'false');
    fileWatch.sync();
  }

  async function show(reconcile = true): Promise<void> {
    if (!project) return;
    options.onShow?.();
    pane.hidden = false;
    if (!options.mount) options.host.classList.add('has-file-panel');
    options.toggle?.setAttribute('aria-expanded', 'true');
    if (mode === 'files' && !listings.has('')) await navigation.loadDirectory('');
    else render();
    if (reconcile) void git.reconcile();
    const draft = project && fileEditor.retainedDraft(project.id);
    if (mode === 'files' && draft && !fileEditor.editingPath()) {
      selection = { path: draft.preview.path, kind: 'file' };
      previewPath = draft.preview.path; previewValue = draft.preview;
      await fileEditor.start(draft.preview, draft.text);
    }
  }

  const actionState = createFilePanelActionState({
    mode: () => mode,
    project: () => project,
    selection: () => selection,
    parentPath,
    controls: { rename, remove, reveal, newFile, newFolder }
  });

  const fileActions = createFilePanelActions({
    project: () => project,
    generation: () => generation,
    actionSelection: actionState.actionSelection,
    actionTargetStillCurrent: actionState.actionTargetStillCurrent,
    selectedDirectory: actionState.selectedDirectory,
    setSelection(next) { selection = next; },
    expanded: () => expanded,
    clearListing(path) { listings.delete(path); },
    forgetDirectory: navigation.forgetDirectory,
    editingPath: fileEditor.editingPath,
    leaveEditorIfNeeded: fileEditor.leaveIfNeeded,
    render,
    renderPreview,
    clearPreview() { previewPath = null; previewValue = null; },
    reloadDirectory: navigation.reloadDirectory,
    loadDirectory: navigation.loadDirectory,
    reconcileGitChanges: forceDiff => git.reconcile(forceDiff),
    parentPath,
    baseName
  });

  const fileTree = createFileTreeView({
    host: tree,
    project: () => project,
    selection: () => selection,
    expanded: () => expanded,
    listing: relative => listings.get(relative),
    gitSnapshot: () => git.snapshot(),
    parentPath,
    onSelectRoot: async () => {
      if (fileEditor.editingPath() && !(await fileEditor.leaveIfNeeded())) return;
      selection = { path: '', kind: 'root' }; previewPath = null; previewValue = null; render();
    },
    onToggleDirectory: navigation.toggleDirectory,
    onSelectFile: navigation.selectFile
  });

  git = createFilePanelGitController({
    project: () => project,
    mode: () => mode,
    setMode(value) { mode = value; },
    render,
    renderTree: () => fileTree.render(),
    destroyDiffViewer,
    reviewOnly: options.reviewOnly === true,
    pane,
    backToFiles,
    changes,
    changesBadge,
    changesList
  });

  function renderGitDiff(): void {
    diffView.render();
  }
  async function toggleChanges(): Promise<void> {
    if (!project) return;
    if (mode === 'changes') { git.showFiles(); return; }
    if (fileEditor.editingPath() && !(await fileEditor.leaveIfNeeded())) return;
    if (mode === 'review') fileReview.leaveReview();
    mode = 'changes';
    body.classList.remove('is-reading');
    destroyCodeViewer(); destroyPdfViewer();
    render();
    await git.reconcile();
  }

  function render(): void {
    const showingChanges = mode === 'changes';
    const showingReview = mode === 'review';
    const showingDiff = showingReview || (showingChanges && git.diffPath() !== null);
    tree.hidden = showingChanges || showingReview;
    changesView.hidden = !showingChanges && !showingReview;
    changesList.hidden = showingDiff;
    const backToChanges = showingReview ? fileReview.returnMode() === 'changes' : showingChanges && git.diffPath() !== null;
    renderFilePanelHeader({
      elements: { changesHeaderTitle, branchArrow, branchTrigger, branchStats, backToFiles, backToFilesLabel, refresh },
      mode,
      reviewOnly: options.reviewOnly === true,
      hasProject: project !== null,
      showingDiff,
      backToChanges,
      snapshot: git.snapshot(),
      selectedBaseRef: git.selectedBaseRef()
    });
    body.classList.toggle('is-changes', showingChanges);
    body.classList.toggle('is-review', showingReview);
    body.classList.toggle('is-diff-open', showingDiff);
    fileTree.render();
    if (showingChanges || showingReview) {
      if (!showingDiff) git.renderChangesList();
      if (!pane.hidden) renderGitDiff();
    } else if (!pane.hidden) {
      destroyDiffViewer();
      preview.classList.remove('has-diff-viewer');
      renderPreview();
    }
    git.updateChangesButton();
    actionState.update();
    fileWatch.sync();
  }

  async function refreshAll(): Promise<void> {
    if (!project) return;
    if (fileEditor.editingPath() && !(await fileEditor.leaveIfNeeded())) return;
    generation++;
    fileWatch.reset();
    listings.clear(); expanded = new Set(['']);
    selection = { path: '', kind: 'root' }; previewPath = null; previewValue = null;
    render();
    await navigation.loadDirectory('', generation);
    await git.reconcile(true);
  }

  refresh.onclick = () => void (mode === 'changes' ? git.reconcile(true) : refreshAll());
  pane.addEventListener('keydown', event => {
    if (fileEditor.editingPath() && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void fileEditor.save();
      return;
    }
    if (fileEditor.editingPath() && event.key === 'Escape') return;
    if (event.key !== 'Escape') return;
    event.preventDefault(); hide();
    if (options.onEscape) options.onEscape(); else options.toggle?.focus();
  });
  if (options.toggle) options.toggle.onclick = () => { if (pane.hidden) void show(); else hide(); };
  fileWatch.bind();
  window.api.onProjectGitChanged?.((change: ProjectGitChanged) => {
    if (change.projectId === project?.id) git.scheduleReconcile();
  });

  actionState.update();
  return {
    hide,
    show,
    mountAt(parent: HTMLElement): void { if (pane.parentElement !== parent) parent.append(pane); },
    openReview: fileReview.openReview,
    visible: () => !pane.hidden,
    update(next: LocalProject | null): void {
      const changed = project?.id !== next?.id;
      const labelChanged = project?.name !== next?.name || project?.path !== next?.path;
      if (changed) fileEditor.retainCurrentProjectDraft();
      project = next;
      if (changed) fileWatch.reset();
      if (changed) { branchSelector.close(); git.resetForProjectChange(); }
      if (options.toggle) {
        options.toggle.hidden = next === null;
        ui(options.toggle, 'title', () => next ? t('Files · {0}', [next.name]) : t('Files'));
      }
      if (!changed) {
        if (labelChanged) fileTree.render();
        return;
      }
      if (fileEditor.editingPath()) fileEditor.clear();
      destroyCodeViewer(); destroyPdfViewer(); destroyDiffViewer();
      fileReview.reset(); mode = options.reviewOnly ? 'changes' : 'files';
      generation++;
      listings.clear(); expanded = new Set(['']); selection = { path: '', kind: 'root' };
      previewPath = null; previewValue = null;
      if (!next) { hide(); render(); return; }
      render();
      if (!pane.hidden) void show();
    }
  };
}
