import type { AppApi } from '../../backend/preload/index.js';
import type { AppState } from '../../contracts/types.js';
import { $, run } from '../shared/dom.js';

interface FolderDropActionsDependencies {
  api: AppApi;
  apply: (state: AppState) => void;
}

export function initFolderDropActions({ api, apply }: FolderDropActionsDependencies): void {
  function dragHasFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes('Files');
  }

  async function dropFolders(event: DragEvent): Promise<void> {
    const files = Array.from(event.dataTransfer?.files ?? []);
    for (const file of files) {
      const next = await run(api.addRootPath(file));
      if (next) apply(next);
    }
  }

  // Prevent Electron from navigating the window to a dropped file.
  window.addEventListener('dragover', event => event.preventDefault());
  window.addEventListener('drop', event => event.preventDefault());

  const card = $('foldersCard');
  card.addEventListener('dragover', event => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'link';
    card.classList.add('drop-target');
  });
  card.addEventListener('dragleave', event => {
    if (!card.contains(event.relatedTarget as Node | null)) card.classList.remove('drop-target');
  });
  card.addEventListener('drop', event => {
    event.preventDefault();
    card.classList.remove('drop-target');
    if (dragHasFiles(event)) void dropFolders(event);
  });
}
