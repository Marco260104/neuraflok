import type { AppApi } from '../../../backend/preload/index.js';
import type { AppState } from '../../../contracts/types.js';
import { $, el, icon, run } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';

interface RootRenameState {
  targetName: string;
  targetPath: string;
  draft: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  selectionDirection: 'forward' | 'backward' | 'none' | null;
  focused: boolean;
  committing: boolean;
}

interface ApprovedRootsDependencies {
  api: AppApi;
  getState: () => AppState | null;
  apply: (state: AppState) => void;
}

export function initApprovedRoots(dependencies: ApprovedRootsDependencies) {
  const { api,getState,apply } = dependencies;
  let renameState: RootRenameState | null = null;
  let repainting = false;

  function captureRenameInput(input: HTMLInputElement, rename: RootRenameState): void {
    if (renameState !== rename) return;
    rename.draft = input.value;
    rename.focused = document.activeElement === input;
    if (rename.focused) {
      rename.selectionStart = input.selectionStart;
      rename.selectionEnd = input.selectionEnd;
      rename.selectionDirection = input.selectionDirection;
    }
  }

  function cancelRename(): void {
    renameState = null;
    const state = getState();
    if (state) paintRoots(state.config.roots);
  }

  async function commitRename(input: HTMLInputElement, rename: RootRenameState): Promise<void> {
    if (renameState !== rename || rename.committing) return;
    captureRenameInput(input, rename);
    const nextName = rename.draft.trim().toLowerCase();
    if (!nextName || nextName === rename.targetName) {
      cancelRename();
      return;
    }
    rename.committing = true;
    input.disabled = true;
    const result = await run(api.renameRoot(rename.targetName, nextName));
    if (renameState !== rename) return;
    if (result) {
      renameState = null;
      apply(result);
      return;
    }
    rename.committing = false;
    paintRoots(getState()?.config.roots ?? []);
  }

  function rootRow(root: AppState['config']['roots'][number]): HTMLElement {
    const row = el('div', 'root');
    const activeRename = renameState?.targetName === root.name && renameState.targetPath === root.path ? renameState : null;
    const name = el('b', '', `/${root.name}`);
    let label: HTMLElement = name;
    if (activeRename) {
      const input = document.createElement('input');
      input.className = 'root-rename';
      input.value = activeRename.draft;
      input.maxLength = 32;
      input.disabled = activeRename.committing;
      ui(input, 'aria-label', () => t('Rename /{0}', [root.name]));
      input.addEventListener('input', () => captureRenameInput(input, activeRename));
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void commitRename(input, activeRename);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancelRename();
        }
      });
      input.addEventListener('blur', () => {
        if (repainting) return;
        captureRenameInput(input, activeRename);
        void commitRename(input, activeRename);
      });
      label = input;
    }

    const rename = document.createElement('button');
    rename.className = 'btn';
    rename.type = 'button';
    ui(rename, 'title', () => t('Rename /{0}', [root.name]));
    rename.append(icon('i-pencil'));
    rename.addEventListener('click', () => {
      renameState = {
        targetName: root.name,
        targetPath: root.path,
        draft: root.name,
        selectionStart: 0,
        selectionEnd: root.name.length,
        selectionDirection: 'none',
        focused: true,
        committing: false
      };
      paintRoots(getState()?.config.roots ?? []);
    });

    const remove = document.createElement('button');
    remove.className = 'btn';
    remove.type = 'button';
    ui(remove, 'title', () => t('Stop sharing /{0}', [root.name]));
    remove.append(icon('i-trash'));
    remove.addEventListener('click', async () => {
      const result = await run(api.removeRoot(root.name));
      if (result) apply(result);
    });
    const path = el('span', '', root.path);
    path.title = root.path;
    row.append(icon('i-folder'), label, path, rename, remove);
    return row;
  }

  function paintRoots(roots: AppState['config']['roots']): void {
    const active = document.querySelector<HTMLInputElement>('.root-rename');
    if (active && renameState) captureRenameInput(active, renameState);
    if (renameState && !roots.some(root => root.name === renameState!.targetName && root.path === renameState!.targetPath)) {
      renameState = null;
    }
    repainting = true;
    try {
      $('rootList').replaceChildren(...roots.map(rootRow));
    } finally {
      repainting = false;
    }
    if (!renameState?.focused) return;
    const input = document.querySelector<HTMLInputElement>('.root-rename');
    if (!input) return;
    input.focus();
    if (renameState.selectionStart !== null && renameState.selectionEnd !== null) {
      input.setSelectionRange(renameState.selectionStart, renameState.selectionEnd, renameState.selectionDirection ?? undefined);
    }
  }

  return { paintRoots };
}
