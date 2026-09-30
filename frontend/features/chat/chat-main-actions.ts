import type { Handoff } from '../../../contracts/session.js';
import type { LocalProject } from '../../../contracts/workspace/projects.js';
import { $, run } from '../../shared/dom.js';
import { t } from '../../shared/i18n.js';

export interface ChatMainActionsRuntime {
  api: Pick<typeof window.api, 'cancelSessionCompaction' | 'compactSession' | 'generateFinishGoal' | 'addProject' | 'writeClipboard' | 'unpairExtension'>;
  run: typeof run;
  selectedId: string | null;
  selectionGeneration: number;
  controlledTurnId: string | null;
  controlledSessionId: string | null;
  controlledSelection: number;
  hasComposerImages: () => boolean;
  sendComposer: (delivery?: 'finish') => Promise<boolean | void>;
  paintDeliveryControls: () => void;
  refreshSessionControls: () => Promise<void>;
  selectNewChat: (projectId?: string | null) => void;
  projects: LocalProject[];
  expandedProjects: Set<string>;
  sessionsLoadGeneration: number;
  paintSessions: () => void;
  handoff: Handoff | null;
  refreshAll: () => Promise<void>;
  toast: (message: string) => void;
}

export function bindChatMainActions(runtime: ChatMainActionsRuntime): void {
  $('queueAtFinish').addEventListener('click', () => {
    if ($('queueAtFinish').hidden) return;
    $<HTMLSelectElement>('sendMode').value = 'after-turn';
    const input = $<HTMLTextAreaElement>('chatInput');
    if (input.value.trim() || runtime.hasComposerImages()) void runtime.sendComposer('finish');
    else { input.focus(); runtime.paintDeliveryControls(); }
  });
  $('sendOptions').addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-delivery]');
    if (!button || $('sendOptions').hidden) return;
    $<HTMLSelectElement>('sendMode').value = button.dataset.delivery!;
    runtime.paintDeliveryControls();
  });
  for (const [buttonId, cancel] of [['compactSession', false], ['cancelCompaction', true]] as const) {
    $(buttonId).addEventListener('click', async () => {
      const id = runtime.selectedId; if (!id) return;
      const button = $<HTMLButtonElement>(buttonId); button.disabled = true;
      try { await runtime.run(cancel ? runtime.api.cancelSessionCompaction(id) : runtime.api.compactSession(id)); }
      finally { button.disabled = false; if (runtime.selectedId === id) void runtime.refreshSessionControls(); }
    });
  }
  $('composerGoalBtn').addEventListener('click', () => {
    const select = $<HTMLSelectElement>('chatAutomation');
    select.value = select.value === 'goal' ? 'off' : 'goal';
    select.dispatchEvent(new Event('change'));
  });
  $('composerProjectPill').addEventListener('click', () => $('addProject').click());
  $('generateFinishGoal').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('generateFinishGoal');
    const id = runtime.selectedId;
    const turnId = runtime.controlledTurnId;
    if (!id || !turnId || button.hidden || button.disabled || runtime.controlledSessionId !== id || runtime.controlledSelection !== runtime.selectionGeneration) return;
    const owner = `${id}:${turnId}`;
    button.dataset.busy = owner; runtime.paintDeliveryControls();
    try { await runtime.run(runtime.api.generateFinishGoal(id, turnId)); }
    finally {
      if (button.dataset.busy === owner) delete button.dataset.busy;
      if (runtime.selectedId === id) void runtime.refreshSessionControls();
      else runtime.paintDeliveryControls();
    }
  });
  $('newChat').addEventListener('click', () => runtime.selectNewChat());
  $('newChatInChats')?.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    runtime.selectNewChat();
  });
  $('addProject').addEventListener('click', async event => {
    event.preventDefault();
    const button = $<HTMLButtonElement>('addProject'); button.disabled = true;
    const generation = runtime.selectionGeneration;
    try {
      const project = await runtime.run(runtime.api.addProject());
      if (!project) return;
      ++runtime.sessionsLoadGeneration;
      runtime.projects = [...runtime.projects.filter(row => row.id !== project.id), project];
      runtime.expandedProjects.add(project.id);
      if (generation === runtime.selectionGeneration) runtime.selectNewChat(project.id); else runtime.paintSessions();
    } finally { button.disabled = false; }
  });
  $('chatRefresh').addEventListener('click', event => { event.preventDefault(); void runtime.refreshAll(); });
  $('copyHandoff').addEventListener('click', async () => {
    if (!runtime.handoff) return;
    const copied = await runtime.run(runtime.api.writeClipboard(runtime.handoff.text));
    if (copied) runtime.toast(t('Handoff copied'));
  });
  $('bridgeUnpair').addEventListener('click', async () => {
    const state = await runtime.run(runtime.api.unpairExtension());
    if (state) runtime.toast(t('Browser disconnected'));
  });
}
