import type { LocalProject } from '../../../contracts/workspace/projects.js';
import type { FilePanelSelection } from './file-panel-actions.js';
import type { FilePanelMode } from './file-panel-review.js';

export interface FilePanelActionStateRuntime {
  mode(): FilePanelMode;
  project(): LocalProject | null;
  selection(): FilePanelSelection;
  parentPath(path: string): string;
  controls: {
    rename: HTMLButtonElement;
    remove: HTMLButtonElement;
    reveal: HTMLButtonElement;
    newFile: HTMLButtonElement;
    newFolder: HTMLButtonElement;
  };
}

// Owns selection validation and enabled state for file-panel actions.
export function createFilePanelActionState(runtime: FilePanelActionStateRuntime) {
  function actionSelection(): FilePanelSelection {
    return runtime.mode() === 'files' ? runtime.selection() : { path: '', kind: 'root' };
  }

  function actionTargetStillCurrent(target: FilePanelSelection): boolean {
    if (runtime.mode() !== 'files') return false;
    const current = actionSelection();
    return current.path === target.path && current.kind === target.kind;
  }

  function selectedDirectory(): string {
    const target = actionSelection();
    return target.kind === 'directory' || target.kind === 'root' ? target.path : runtime.parentPath(target.path);
  }

  function update(): void {
    const target = actionSelection();
    const inFiles = runtime.mode() === 'files';
    const mutable = inFiles && Boolean(runtime.project()) && target.path !== '' &&
      (target.kind === 'file' || target.kind === 'directory');
    runtime.controls.rename.disabled = !mutable;
    runtime.controls.remove.disabled = !mutable;
    runtime.controls.reveal.disabled = !inFiles || !runtime.project();
    runtime.controls.newFile.disabled = !inFiles || !runtime.project() ||
      (target.kind !== 'root' && target.kind !== 'directory' && target.kind !== 'file');
    runtime.controls.newFolder.disabled = runtime.controls.newFile.disabled;
  }

  return { actionSelection, actionTargetStillCurrent, selectedDirectory, update };
}
