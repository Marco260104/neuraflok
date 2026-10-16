import type { LocalProject } from '../../../contracts/workspace/projects.js';
import type { ProjectDirectoryListing, ProjectFileEntry, ProjectFilePreview } from '../../../contracts/workspace/project-files.js';
import { run, toast } from '../../shared/dom.js';
import { t } from '../../shared/i18n.js';
import type { FilePanelSelection } from './file-panel-actions.js';

export interface FilePanelNavigationRuntime {
  project(): LocalProject | null;
  generation(): number;
  setGeneration(value: number): void;
  selection(): FilePanelSelection;
  setSelection(value: FilePanelSelection): void;
  setPreviewPath(value: string | null): void;
  setPreviewValue(value: ProjectFilePreview | null): void;
  listings(): Map<string, ProjectDirectoryListing>;
  expanded(): Set<string>;
  editingPath(): string | null;
  leaveEditorIfNeeded(): Promise<boolean>;
  render(): void;
  renderPreview(): void;
}

// Owns file-tree navigation and generation-checked directory and preview requests.
export function createFilePanelNavigation(runtime: FilePanelNavigationRuntime) {
  async function loadDirectory(relative: string, expectedGeneration = runtime.generation()): Promise<void> {
    const current = runtime.project();
    if (!current) return;
    const listing = await run(window.api.listProjectFiles(current.id, relative));
    if (!listing || expectedGeneration !== runtime.generation() || runtime.project()?.id !== current.id) return;
    runtime.listings().set(relative, listing);
    runtime.render();
  }

  async function reloadDirectory(relative: string): Promise<void> {
    const current = runtime.project();
    if (!current) return;
    const request = runtime.generation();
    const listing = await run(window.api.listProjectFiles(current.id, relative));
    if (!listing || request !== runtime.generation() || runtime.project()?.id !== current.id) return;
    runtime.listings().set(relative, listing);
    runtime.render();
  }

  function forgetDirectory(relative: string): void {
    for (const key of runtime.listings().keys()) {
      if (key === relative || key.startsWith(`${relative}/`)) runtime.listings().delete(key);
    }
    for (const key of runtime.expanded()) {
      if (key === relative || key.startsWith(`${relative}/`)) runtime.expanded().delete(key);
    }
  }

  async function toggleDirectory(entry: ProjectFileEntry): Promise<void> {
    if (runtime.editingPath() && !(await runtime.leaveEditorIfNeeded())) return;
    runtime.setSelection({ path: entry.path, kind: 'directory' });
    runtime.setPreviewPath(null);
    runtime.setPreviewValue(null);
    if (runtime.expanded().has(entry.path)) {
      forgetDirectory(entry.path);
      runtime.render();
      return;
    }
    if (runtime.expanded().size >= 128) {
      toast(t('Collapse a folder before expanding more folders.'));
      return;
    }
    runtime.expanded().add(entry.path);
    runtime.render();
    if (!runtime.listings().has(entry.path)) await loadDirectory(entry.path);
  }

  async function selectFile(entry: ProjectFileEntry): Promise<void> {
    if (entry.path === runtime.editingPath()) return;
    if (runtime.editingPath()) {
      if (!(await runtime.leaveEditorIfNeeded())) return;
      runtime.renderPreview();
    }
    const current = runtime.project();
    if (entry.kind !== 'file' || !current) {
      runtime.setSelection({ path: entry.path, kind: entry.kind });
      runtime.setPreviewPath(null);
      runtime.setPreviewValue(null);
      runtime.render();
      return;
    }
    const request = runtime.generation() + 1;
    runtime.setGeneration(request);
    const previousSelection = runtime.selection();
    // Keep the accepted preview visible while replacing it and reject stale navigation responses.
    const value = await run(window.api.previewProjectFile(current.id, entry.path));
    if (!value || request !== runtime.generation() || runtime.project()?.id !== current.id ||
        runtime.selection() !== previousSelection || runtime.editingPath()) return;
    runtime.setSelection({ path: entry.path, kind: entry.kind });
    runtime.setPreviewValue(value);
    runtime.setPreviewPath(entry.path);
    runtime.render();
  }

  async function closePreview(): Promise<void> {
    if (runtime.editingPath() && !(await runtime.leaveEditorIfNeeded())) return;
    runtime.setGeneration(runtime.generation() + 1);
    runtime.setPreviewPath(null);
    runtime.setPreviewValue(null);
    runtime.renderPreview();
  }

  return { loadDirectory, reloadDirectory, forgetDirectory, toggleDirectory, selectFile, closePreview };
}
