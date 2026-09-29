import type { LocalProject } from '../../../contracts/workspace/projects.js';
import type { ProjectFileKind } from '../../../contracts/workspace/project-files.js';
import { run } from '../../shared/dom.js';
import { t } from '../../shared/i18n.js';
import { requestEntryName, requestFileConfirmation } from './file-panel-ui.js';

export interface FilePanelSelection {
  path: string;
  kind: ProjectFileKind | 'root';
}

export interface FilePanelActionsRuntime {
  project(): LocalProject | null;
  generation(): number;
  actionSelection(): FilePanelSelection;
  actionTargetStillCurrent(target: FilePanelSelection): boolean;
  selectedDirectory(): string;
  setSelection(selection: FilePanelSelection): void;
  expanded(): Set<string>;
  clearListing(path: string): void;
  forgetDirectory(path: string): void;
  editingPath(): string | null;
  leaveEditorIfNeeded(): Promise<boolean>;
  render(): void;
  renderPreview(): void;
  clearPreview(): void;
  reloadDirectory(path: string): Promise<void>;
  loadDirectory(path: string, expectedGeneration: number): Promise<void>;
  reconcileGitChanges(forceDiff?: boolean): Promise<void>;
  parentPath(path: string): string;
  baseName(path: string): string;
}

// Owns project-file mutations and rejects results after selection or project changes.
export function createFilePanelActions(runtime: FilePanelActionsRuntime) {
  async function createEntry(kind: 'file' | 'directory'): Promise<void> {
    const project = runtime.project();
    if (!project) return;
    const target = runtime.actionSelection();
    const directory = runtime.selectedDirectory();
    const expected = runtime.generation();
    // Creation changes selection, so preserve any editor draft before opening the name dialog.
    if (runtime.editingPath()) {
      if (!(await runtime.leaveEditorIfNeeded())) return;
      runtime.renderPreview();
    }
    if (expected !== runtime.generation() || runtime.project()?.id !== project.id) return;
    const name = await requestEntryName({
      title: kind === 'file' ? t('New file') : t('New folder'),
      confirm: t('Create')
    });
    if (!name || expected !== runtime.generation() || runtime.project()?.id !== project.id ||
        !runtime.actionTargetStillCurrent(target)) return;
    const created = await run(window.api.createProjectFileEntry(project.id, directory, name, kind));
    if (!created || expected !== runtime.generation() || runtime.project()?.id !== project.id) return;
    runtime.expanded().add(directory);
    runtime.setSelection({ path: created.path, kind: created.kind });
    await runtime.reloadDirectory(directory);
    if (expected !== runtime.generation() || runtime.project()?.id !== project.id) return;
    if (created.kind === 'directory' && runtime.expanded().size < 128) {
      runtime.expanded().add(created.path);
      runtime.clearListing(created.path);
      runtime.render();
      await runtime.loadDirectory(created.path, expected);
    }
    await runtime.reconcileGitChanges(true);
  }

  async function renameSelection(): Promise<void> {
    const project = runtime.project();
    const target = runtime.actionSelection();
    if (!project || !target.path || (target.kind !== 'file' && target.kind !== 'directory')) return;
    const oldPath = target.path;
    const parent = runtime.parentPath(oldPath);
    const expected = runtime.generation();
    if (runtime.editingPath() && !(await runtime.leaveEditorIfNeeded())) return;
    const nextName = await requestEntryName({
      title: t('Rename item'),
      initial: runtime.baseName(oldPath),
      confirm: t('Rename')
    });
    if (!nextName || nextName === runtime.baseName(oldPath) || expected !== runtime.generation() ||
        runtime.project()?.id !== project.id || !runtime.actionTargetStillCurrent(target)) return;
    const renamed = await run(window.api.renameProjectFileEntry(project.id, oldPath, nextName));
    if (!renamed || expected !== runtime.generation() || runtime.project()?.id !== project.id) return;
    const wasExpanded = runtime.expanded().has(oldPath);
    runtime.forgetDirectory(oldPath);
    if (wasExpanded && renamed.kind === 'directory') runtime.expanded().add(renamed.path);
    runtime.setSelection({ path: renamed.path, kind: renamed.kind });
    runtime.clearPreview();
    await runtime.reloadDirectory(parent);
    if (expected !== runtime.generation() || runtime.project()?.id !== project.id) return;
    if (wasExpanded && renamed.kind === 'directory') await runtime.loadDirectory(renamed.path, expected);
    await runtime.reconcileGitChanges(true);
  }

  async function deleteSelection(): Promise<void> {
    const project = runtime.project();
    const target = runtime.actionSelection();
    if (!project || !target.path || (target.kind !== 'file' && target.kind !== 'directory')) return;
    if (runtime.editingPath() && !(await runtime.leaveEditorIfNeeded())) return;
    const oldPath = target.path;
    const parent = runtime.parentPath(oldPath);
    const expected = runtime.generation();
    const confirmed = await requestFileConfirmation({
      title: t('Delete item?'),
      message: t('Move “{0}” to the Trash?', [oldPath]),
      detail: t('You can restore it from the operating system Trash.'),
      confirm: t('Move to Trash')
    });
    if (!confirmed || expected !== runtime.generation() || runtime.project()?.id !== project.id ||
        !runtime.actionTargetStillCurrent(target)) return;
    const deleted = await run(window.api.deleteProjectFileEntry(project.id, oldPath));
    if (!deleted || expected !== runtime.generation() || runtime.project()?.id !== project.id) return;
    runtime.forgetDirectory(oldPath);
    runtime.setSelection({ path: parent, kind: parent ? 'directory' : 'root' });
    runtime.clearPreview();
    await runtime.reloadDirectory(parent);
    await runtime.reconcileGitChanges(true);
  }

  async function revealSelection(): Promise<void> {
    const project = runtime.project();
    if (!project) return;
    await run(window.api.revealProjectFileEntry(project.id, runtime.actionSelection().path));
  }

  return { createEntry, renameSelection, deleteSelection, revealSelection };
}
