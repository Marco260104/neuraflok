import type { LocalProject } from '../../../contracts/workspace/projects.js';
import type { ProjectDirectoryListing, ProjectFileKind, ProjectFilePreview, ProjectFilesChanged } from '../../../contracts/workspace/project-files.js';
import type { ProjectGitSnapshot } from '../../../contracts/workspace/project-git.js';
import { run } from '../../shared/dom.js';

const MAX_WATCHED_DIRECTORIES = 128;

export interface FilePanelWatchRuntime {
  reviewOnly: boolean;
  project(): LocalProject | null;
  visible(): boolean;
  generation(): number;
  gitSnapshot(): ProjectGitSnapshot | null;
  listings(): ReadonlyMap<string, ProjectDirectoryListing>;
  expanded(): ReadonlySet<string>;
  selectedPath(): string;
  setSelection(path: string, kind: ProjectFileKind | 'root'): void;
  previewPath(): string | null;
  previewValue(): ProjectFilePreview | null;
  setPreviewPath(path: string | null): void;
  setPreviewValue(value: ProjectFilePreview | null): void;
  editingPath(): string | null;
  editorDirty(): boolean;
  parentPath(path: string): string;
  samePreview(left: ProjectFilePreview | null, right: ProjectFilePreview | null): boolean;
  editablePreview(value: ProjectFilePreview): value is ProjectFilePreview & { text: string; revision: string };
  scheduleGitReconcile(): void;
  markEditorExternalChange(): void;
  clearEditorState(): void;
  render(): void;
  renderPreview(): void;
  startEditing(value: ProjectFilePreview): Promise<void>;
  setListing(directory: string, listing: ProjectDirectoryListing): void;
}

// Owns project directory subscriptions and generation-checked disk refreshes.
export function createFilePanelWatch(runtime: FilePanelWatchRuntime) {
  let watchSignature = '';

  function watchedDirectories(): string[] {
    if (!runtime.project()) return [];
    const result = [''];
    const included = new Set(result);
    const snapshot = runtime.gitSnapshot();
    if (snapshot?.state === 'ready') {
      for (const change of snapshot.changes) {
        const directory = runtime.parentPath(change.path);
        if (included.has(directory) || result.length >= MAX_WATCHED_DIRECTORIES) continue;
        result.push(directory);
        included.add(directory);
      }
    }

    const visit = (directory: string): void => {
      const listing = runtime.listings().get(directory);
      if (!listing) return;
      for (const entry of listing.entries) {
        if (entry.kind !== 'directory' || !runtime.expanded().has(entry.path)) continue;
        if (!included.has(entry.path) && result.length < MAX_WATCHED_DIRECTORIES) {
          result.push(entry.path);
          included.add(entry.path);
        }
        visit(entry.path);
      }
    };
    visit('');
    return result;
  }

  function sync(): void {
    if (runtime.reviewOnly) return;
    const current = runtime.visible() ? runtime.project() : null;
    const directories = current ? watchedDirectories() : [];
    const signature = current ? `${current.id}\0${directories.join('\0')}` : '<none>';
    if (signature === watchSignature) return;
    watchSignature = signature;
    void window.api.watchProjectFiles(current?.id ?? null, directories).then(reply => {
      if (!reply.ok && watchSignature === signature) watchSignature = '';
    });
  }

  function reset(): void {
    watchSignature = '';
  }

  function firstChildWithin(directory: string, candidate: string): string | null {
    const prefix = directory ? `${directory}/` : '';
    if (!candidate.startsWith(prefix) || candidate === directory) return null;
    const first = candidate.slice(prefix.length).split('/')[0];
    return first ? `${prefix}${first}` : null;
  }

  async function reloadPreviewFromDisk(directory: string, expectedGeneration: number): Promise<void> {
    const current = runtime.project();
    const relative = runtime.previewPath();
    if (!current || !relative || runtime.parentPath(relative) !== directory) return;
    const fresh = await run(window.api.previewProjectFile(current.id, relative));
    if (!fresh || expectedGeneration !== runtime.generation() || runtime.project()?.id !== current.id || runtime.previewPath() !== relative) return;
    if (runtime.editingPath() === relative && runtime.editorDirty()) {
      if (fresh.revision !== runtime.previewValue()?.revision) runtime.markEditorExternalChange();
      return;
    }
    if (runtime.samePreview(runtime.previewValue(), fresh)) return;
    runtime.setPreviewValue(fresh);
    if (runtime.editingPath() === relative) {
      if (runtime.editablePreview(fresh)) await runtime.startEditing(fresh);
      else { runtime.clearEditorState(); runtime.renderPreview(); }
    } else {
      runtime.renderPreview();
    }
  }

  async function handleChange(change: ProjectFilesChanged): Promise<void> {
    const current = runtime.project();
    if (!current || change.projectId !== current.id) return;
    runtime.scheduleGitReconcile();
    const expectedGeneration = runtime.generation();
    const listing = await run(window.api.listProjectFiles(current.id, change.directory));
    if (!listing || expectedGeneration !== runtime.generation() || runtime.project()?.id !== current.id) return;
    runtime.setListing(change.directory, listing);

    const selectedChild = firstChildWithin(change.directory, runtime.selectedPath());
    if (selectedChild && !listing.entries.some(entry => entry.path === selectedChild)) {
      const editingPath = runtime.editingPath();
      if (editingPath && runtime.editorDirty() && firstChildWithin(change.directory, editingPath) === selectedChild) {
        runtime.markEditorExternalChange();
      } else {
        if (editingPath) runtime.clearEditorState();
        runtime.setSelection(change.directory, change.directory ? 'directory' : 'root');
        runtime.setPreviewPath(null);
        runtime.setPreviewValue(null);
      }
    }
    runtime.render();
    await reloadPreviewFromDisk(change.directory, expectedGeneration);
  }

  function bind(): void {
    if (!runtime.reviewOnly) window.api.onProjectFilesChanged?.(change => { void handleChange(change); });
  }

  return { bind, reset, sync };
}
