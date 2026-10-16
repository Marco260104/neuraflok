import type { ChatInitializationBindings } from './chat.js';
import { createWorkspaceDocks } from '../workspace/docks/controller.js';
import { initSkills } from '../settings/skill-composer/composer.js';
import { initChatModels, observedComposerModel, chatModelName } from './chat-models.js';
import { imageDrafts } from './chat-composer-attachments.js';
import { bindChatMainActions } from './chat-main-actions.js';
import { createAgentPanel } from '../agents/agent-panel.js';
import { foldAgentCommunication } from '../agents/agent-communication.js';
import { paintContextMeter } from './context-meter.js';
import { installComposerDockMotion, installComposerHeightMotion } from './composer-motion.js';
import { attachChatWorkspacePanels } from './chat-workspace-panels.js';
import { $, el, run, toast } from '../../shared/dom.js';

export function initializeChatWorkspace(bindings: ChatInitializationBindings): void {  const stopComposerHeightMotion = installComposerHeightMotion($('composer'));
  const stopComposerDockMotion = installComposerDockMotion($('composerDock'));
  window.addEventListener('beforeunload', () => {
    stopComposerHeightMotion();
    stopComposerDockMotion();
  }, {
    once: true
  });
  const chatHost = document.querySelector<HTMLElement>('[data-panel="chat"]')!;
  const docks = createWorkspaceDocks(chatHost);
  bindings.workspaceDocks = docks;
  const agentToolGroups = new Map<string, HTMLElement>();
  bindings.agentPanel = createAgentPanel({
    host: chatHost,
    mount: docks.body,
    onShow: () => {
      bindings.filePanel?.hide();
      docks.adopt('agents');
    },
    onEscape: () => {
      docks.setOpen(false);
      docks.rightToggle.focus();
    },
    load: async id => {
      const detail = await run(bindings.api.getSession(id, {
        limit: 160
      }));
      if (!detail) return null;
      return { events: detail.events };
    },
    openMain: bindings.selectSession,
    working: bindings.sessionWorking,
    modelLabel: chatModelName,
    agent: worker => [...(bindings.swarm?.agents ?? []), ...(bindings.swarm?.retainedWorkers ?? [])].find(entry => entry.role === 'worker' && entry.id === worker.origin?.agentId && !!entry.conversationId && entry.conversationId === worker.conversationId) ?? null,
    render: (source, id, current) => {
      const rows = foldAgentCommunication(source).flatMap(event => {
        if (!['user_message', 'assistant_message', 'native_image', 'tool_call', 'page_tool', 'agent_message', 'chat_error'].includes(event.kind)) return [];
        const row = el('div', `ev ev-${event.kind}`);
        const body = el('div', 'ev-body');
        bindings.tagImageRow(row, event);
        row.dataset.timelineKey = `pane:${id}:event:${event.seq}`;
        bindings.rowEvents.set(row, event);
        body.append(bindings.eventBody(event, {
          id,
          current,
          history: source
        }));
        row.append(body);
        return [row];
      });
      const summary = bindings.sessions.find(entry => entry.id === id);
      const working = !!summary && bindings.sessionWorking(summary);
      return bindings.groupImageRows(bindings.renderRounds(rows, working, `pane:${id}`, agentToolGroups, false));
    }
  });
  initChatModels(() => {
    bindings.paintLoopDelivery();
    const config = bindings.deps.state()?.config;
    if (config) paintContextMeter(bindings.sessions.find(session => session.id === bindings.selectedId) ?? null, config, observedComposerModel());
  });
  bindChatMainActions({
    api: bindings.api,
    run,
    get selectedId() {
      return bindings.selectedId;
    },
    get selectionGeneration() {
      return bindings.selectionGeneration;
    },
    get controlledTurnId() {
      return bindings.controlledTurnId;
    },
    get controlledSessionId() {
      return bindings.controlledSessionId;
    },
    get controlledSelection() {
      return bindings.controlledSelection;
    },
    hasComposerImages: () => !!imageDrafts.get(bindings.draftKey())?.length,
    sendComposer: bindings.sendComposer,
    paintDeliveryControls: bindings.paintDeliveryControls,
    refreshSessionControls: bindings.refreshSessionControls,
    selectNewChat: bindings.selectNewChat,
    get projects() {
      return bindings.projects;
    },
    set projects(value) {
      bindings.projects = value;
    },
    expandedProjects: bindings.expandedProjects,
    get sessionsLoadGeneration() {
      return bindings.sessionsLoadGeneration;
    },
    set sessionsLoadGeneration(value) {
      bindings.sessionsLoadGeneration = value;
    },
    paintSessions: bindings.paintSessions,
    get handoff() {
      return bindings.handoff;
    },
    refreshAll: bindings.refreshAll,
    toast
  });
  bindings.chatAutomationControls.bindEvents();
  for (const [buttonId, cancel] of [['compactSession', false], ['cancelCompaction', true]] as const) {
    $(buttonId).addEventListener('click', async () => {
      const id = bindings.selectedId;
      if (!id) return;
      const button = $<HTMLButtonElement>(buttonId);
      button.disabled = true;
      try {
        await run(cancel ? bindings.api.cancelSessionCompaction(id) : bindings.api.compactSession(id));
      } finally {
        button.disabled = false;
        if (bindings.selectedId === id) void bindings.refreshSessionControls();
      }
    });
  }
  const composerAttachments = bindings.chatComposerAttachments;
  const workspaceContent = attachChatWorkspacePanels({
    host: chatHost,
    docks,
    agentPanel: bindings.agentPanel!,
    project: bindings.selectedLocalProject,
    sessionId: () => bindings.selectedId,
    captureAttachment: () => {
      const owner = bindings.composerDraftOwner();
      return attachment => composerAttachments?.append(owner, [attachment]) ?? false;
    }
  });
  bindings.filePanel = workspaceContent.filePanel;
  bindings.reviewPanel = workspaceContent.reviewPanel;
  bindings.workspaceTerminal = workspaceContent.workspaceTerminal;
  bindings.rightWorkspaceTerminal = workspaceContent.rightWorkspaceTerminal;
  composerAttachments?.bindFilePicker();
  bindings.skillPicker = initSkills({
    input: $<HTMLTextAreaElement>('chatInput'),
    host: $('skillPicker'),
    openButton: $('composerSkills'),
    addButton: $('composerAddSkill'),
    selectedHost: $('composerSelectedSkills'),
    owner: () => `${bindings.draftKey()}:${bindings.drafts().generation}`,
    scope: () => ({
      sessionId: bindings.selectedId,
      projectId: bindings.selectedLocalProject()?.id ?? bindings.selectedProjectId
    }),
    draft: () => bindings.drafts().inputDrafts.get(bindings.draftKey()),
    saveDraft: text => bindings.drafts().inputDrafts.set(bindings.draftKey(), text),
    list: scope => bindings.api.skillLibrary(scope),
    command: name => {
      if (name === 'plan') {
        $('createPlan').click();
        return;
      }
      if (name === 'compact') {
        $('compactSession').click();
        return;
      }
      const automation = $<HTMLSelectElement>('chatAutomation');
      automation.value = name;
      automation.dispatchEvent(new Event('change', {
        bubbles: true
      }));
    }
  });
  bindings.skillPicker.restore();
  composerAttachments?.bindDropTargets();
  bindings.api.onWriteSession?.(id => {
    bindings.selectSession(id);
    $<HTMLTextAreaElement>('chatInput').focus();
  });
  const composerMenus = [...document.querySelectorAll<HTMLDetailsElement>('.composer-menu, .session-controls')];
  document.addEventListener('click', event => {
    for (const menu of composerMenus) if (!menu.contains(event.target as Node) || (event.target as HTMLElement).closest('button') && !(event.target as HTMLElement).closest('[data-keep-menu]')) menu.open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') for (const menu of composerMenus) menu.open = false;
  });
}
