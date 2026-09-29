import type { InputAttachment } from '../../../contracts/input.js';
import type { LocalProject } from '../../../contracts/workspace/projects.js';
import type { createAgentPanel } from '../agents/agent-panel.js';
import { createFilePanel } from '../workspace/file-panel.js';
import type { createWorkspaceDocks } from '../workspace/docks/controller.js';
import { createWorkspaceTerminal } from '../workspace/terminal/composition.js';
import { $ } from '../../shared/dom.js';

type WorkspaceDocks = ReturnType<typeof createWorkspaceDocks>;
type AgentPanel = ReturnType<typeof createAgentPanel>;

export type ChatWorkspaceContentPanels = {
  filePanel: ReturnType<typeof createFilePanel>;
  reviewPanel: ReturnType<typeof createFilePanel>;
  workspaceTerminal: ReturnType<typeof createWorkspaceTerminal>;
  rightWorkspaceTerminal: ReturnType<typeof createWorkspaceTerminal>;
};

export function attachChatWorkspacePanels(options: {
  host: HTMLElement;
  docks: WorkspaceDocks;
  agentPanel: AgentPanel;
  project: () => LocalProject | null;
  sessionId: () => string | null;
  captureAttachment: () => (attachment: InputAttachment) => boolean;
}): ChatWorkspaceContentPanels {
  const filePanel = createFilePanel({
    host: options.host,
    mount: options.docks.body,
    onShow: () => { options.agentPanel.hide(); options.docks.adopt('files'); },
    onOpenChanges: () => options.docks.activate('review'),
    onEscape: () => { options.docks.setOpen(false); options.docks.rightToggle.focus(); },
    captureAttachment: options.captureAttachment
  });
  filePanel.update(options.project());
  const reviewPanel = createFilePanel({
    host: options.host,
    mount: options.docks.body,
    reviewOnly: true,
    onShow: () => options.docks.adopt('review'),
    onEscape: () => { options.docks.setOpen(false); options.docks.rightToggle.focus(); }
  });
  reviewPanel.update(options.project());
  const workspaceTerminal = createWorkspaceTerminal(() => options.docks.toggleBottomTerminal(), options.docks.bottomBody, {
    onEmpty: () => options.docks.setBottomOpen(false),
    onClosePanel: () => options.docks.setBottomOpen(false)
  });
  workspaceTerminal.update(options.project());
  const rightWorkspaceTerminal = createWorkspaceTerminal(() => options.docks.toggleBottomTerminal(), options.docks.body, {
    id: 'workspaceTerminalRight',
    dockedTabs: true,
    onTabsChanged: () => options.docks.sync()
  });
  rightWorkspaceTerminal.update(options.project());
  options.docks.register('review', 'Review', 'i-git-diff', mount => {
    reviewPanel.mountAt(mount);
    void reviewPanel.show();
  }, () => reviewPanel.hide(), () => options.project() !== null);
  options.docks.registerTerminal({
    show: (mount, createIfEmpty) => rightWorkspaceTerminal.show(mount, createIfEmpty),
    hide: () => rightWorkspaceTerminal.hide(),
    canCreate: () => true,
    newTab: () => rightWorkspaceTerminal.newTab(),
    tabs: () => rightWorkspaceTerminal.tabs(),
    selectTab: id => rightWorkspaceTerminal.selectTab(id),
    closeTab: id => rightWorkspaceTerminal.closeTab(id)
  }, {
    show: (mount, createIfEmpty) => workspaceTerminal.show(mount, createIfEmpty),
    hide: () => workspaceTerminal.hide()
  });
  options.docks.register('files', 'Files', 'i-folder', mount => {
    filePanel.mountAt(mount);
    void filePanel.show();
  }, () => filePanel.hide(), () => options.project() !== null);
  options.docks.register('agents', 'Sub-agents', 'i-agents', () => options.agentPanel.show(), () => options.agentPanel.hide(), () => options.sessionId() !== null);
  $('composerFiles').addEventListener('click', () => options.docks.activate('files'));
  $('toggleTerminal').addEventListener('click', () => options.docks.toggleBottomTerminal());
  return { filePanel, reviewPanel, workspaceTerminal, rightWorkspaceTerminal };
}
