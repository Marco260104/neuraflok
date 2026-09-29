import type { SessionSummary } from '../../../contracts/session.js';
import { run } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';

export interface ChatSessionRenameState {
  id: string;
  original: string;
  value: string;
  start: number;
  end: number;
}

export interface ChatSessionRenameRuntime {
  renaming: ChatSessionRenameState | null;
  paintSessions: () => void;
  loadSessions: (detail?: 'reread' | 'changed') => Promise<void>;
}

export function createChatSessionRename(runtime: ChatSessionRenameRuntime) {
  function startRename(summary: SessionSummary): void {
    const current = summary.title || '';
    runtime.renaming = {
      id: summary.id,
      original: current,
      value: current,
      start: 0,
      end: current.length,
    };
    document.getElementById('sessionTooltip')?.remove();
    runtime.paintSessions();
  }

  function renameField(summary: SessionSummary): HTMLInputElement {
    const field = document.createElement('input');
    field.className = 'sess-rename';
    field.type = 'text';
    field.maxLength = 120;
    field.dir = 'auto';
    field.value = runtime.renaming!.value;
    ui(field, 'aria-label', () => t('Name for this chat'));
    ui(field, 'placeholder', () =>
      t("Leave empty to keep the provider's title"),
    );
    const own = (): boolean => runtime.renaming?.id === summary.id;
    // The row selects on click and starts a drag on pointer down; typing in its name does neither.
    for (const type of ['click', 'dblclick', 'pointerdown', 'mousedown'])
      field.addEventListener(type, (event) => event.stopPropagation());
    field.addEventListener('input', () => {
      if (own())
        Object.assign(runtime.renaming!, {
          value: field.value,
          start: field.selectionStart ?? field.value.length,
          end: field.selectionEnd ?? field.value.length,
        });
    });
    field.addEventListener('select', () => {
      if (own())
        Object.assign(runtime.renaming!, {
          start: field.selectionStart ?? 0,
          end: field.selectionEnd ?? 0,
        });
    });
    field.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        void finishRename(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        void finishRename(false);
      }
    });
    field.addEventListener('blur', () => {
      // A repaint replaces the field; only leaving it for something else ends the edit.
      setTimeout(() => {
        if (
          !own() ||
          (document.activeElement as HTMLElement | null)?.classList.contains(
            'sess-rename',
          )
        )
          return;
        void finishRename(true);
      }, 0);
    });
    queueMicrotask(() => {
      if (!own() || !field.isConnected) return;
      field.focus({ preventScroll: true });
      field.setSelectionRange(runtime.renaming!.start, runtime.renaming!.end);
    });
    return field;
  }

  async function finishRename(save: boolean): Promise<void> {
    const edit = runtime.renaming;
    if (!edit) return;
    runtime.renaming = null;
    const value = edit.value.trim();
    runtime.paintSessions();
    if (!save || value === edit.original.trim()) return;
    // Empty restores the title supplied by the provider.
    await run(window.api.renameSession(edit.id, value || null));
    await runtime.loadSessions('changed');
  }

  return { startRename, renameField };
}
