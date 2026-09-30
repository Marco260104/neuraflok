import { CHAT_ACTIVE_MS, type SessionSummary } from "../../../contracts/session.js";
import type { TokenPressure } from "../../../contracts/session.js";
import type { LocalProject } from "../../../contracts/workspace/projects.js";
import { recentChatActivity, sessionWorkingAt } from "../../../contracts/sessions/activity-state.js";
import type { ChatSearch } from "./chat-search.js";
import type { ChatWorkspaceContentPanels } from "./chat-workspace-panels.js";
import { createChatSessionListRenderer } from "./chat-session-list-renderer.js";
import type { RowMenuItem } from "./row-menu.js";

export interface ChatSessionListRuntime {
  state: {
    agentPanel: ReturnType<typeof import('../agents/agent-panel.js').createAgentPanel> | null;
    activeId: string | null;
    badgeKey: string;
    blockedChats: Set<string>;
    trustedChats: Set<string>;
    changedTranscripts: { all: boolean; ids: Set<string> };
    chatSearch: ChatSearch | null;
    detailCursor: number | null;
    detailFor: string | null;
    detailStamp: { updatedAt: number; events: number } | null;
    diagnosticsExpanded: boolean;
    expandedProjects: Set<string>;
    expandedWorkers: Set<string>;
    filePanel: ChatWorkspaceContentPanels['filePanel'] | null;
    loadedOlderSessions: boolean;
    pressure: Map<string, TokenPressure>;
    projectVisibleCounts: Map<string, number>;
    projects: LocalProject[];
    renaming: { id: string; original: string; value: string; start: number; end: number } | null;
    reviewPanel: ChatWorkspaceContentPanels['reviewPanel'] | null;
    rightWorkspaceTerminal: ChatWorkspaceContentPanels['rightWorkspaceTerminal'] | null;
    selectedId: string | null;
    sessionPageCursor: { updatedAt: number; id: string } | null;
    sessionPageLoading: boolean;
    sessions: SessionSummary[];
    sessionsLoadGeneration: number;
    sessionTotal: number;
    sidebarOrder: ReturnType<typeof import('./sidebar/order.js').createSidebarOrder> | undefined;
    visible: boolean;
    workspaceDocks: ReturnType<typeof import('../workspace/docks/controller.js').createWorkspaceDocks> | null;
    workspaceTerminal: ChatWorkspaceContentPanels['workspaceTerminal'] | null;
  };
  ui: {
    $: typeof import('../../shared/dom.js').$;
    disclosureChevron: typeof import('../../shared/dom.js').disclosureChevron;
    el: typeof import('../../shared/dom.js').el;
    icon: typeof import('../../shared/dom.js').icon;
    run: typeof import('../../shared/dom.js').run;
    t: typeof import('../../shared/i18n.js').t;
    ui: typeof import('../../shared/i18n.js').ui;
  };
  api: { api: typeof window.api };
  constants: {
    PROJECT_TASK_PAGE_INCREMENT: number;
    PROJECT_TASK_PAGE_SIZE: number;
    SESSION_PAGE_SIZE: number;
    SESSION_SCROLL_MARGIN: number;
    SIDEBAR_PROJECT_SCOPE: string;
  };
  actions: {
    badgeSignature: () => string;
    loadDetail: () => Promise<boolean>;
    refreshInputQueue: () => Promise<void>;
    refreshSessionControls: () => Promise<void>;
    selectNewChat: (projectId?: string | null) => void;
  };
  helpers: {
    openRowMenu: typeof import('./row-menu.js').openRowMenu;
    pinnedChat: (summary: SessionSummary) => boolean;
    pinnedSortScope: typeof import('./sidebar/pins.js').pinnedSortScope;
    placeSessionTooltip: (tip: HTMLElement, row: HTMLElement) => void;
    projectGroup: (id: string | null | undefined) => string | null;
    projectMenuItems: (id: string) => RowMenuItem[];
    rowMenuButton: (owner: string) => HTMLElement | null;
    rowMenuOpenFor: typeof import('./row-menu.js').rowMenuOpenFor;
    selectedLocalProject: () => LocalProject | null;
    sessionRow: (summary: SessionSummary) => HTMLElement;
    sessionWorking: (summary: SessionSummary) => boolean;
    toggleRowMenu: typeof import('./row-menu.js').toggleRowMenu;
  };
}

type Runtime = ChatSessionListRuntime;

// Owns session catalog paging, sidebar ordering, and list rendering.
export function createChatSessionList(runtime: Runtime) {
  let toolActivityTimer: number | undefined;
  let paintSessions: () => void;

  function scheduleToolActivityExpiry(): void {
    window.clearTimeout(toolActivityTimer);
    toolActivityTimer = undefined;
    if (!runtime.state.visible) return;
    const now = Date.now();
    let nearest = Number.POSITIVE_INFINITY;
    for (const summary of runtime.state.sessions) {
      const lastActivityAt = Math.max(summary.startedAt, summary.lastToolCallAt ?? 0);
      if (!recentChatActivity(summary, now)) continue;
      const expiry = summary.activityExpiresAt ?? lastActivityAt + CHAT_ACTIVE_MS;
      if (expiry > now) nearest = Math.min(nearest, expiry);
    }
    if (Number.isFinite(nearest))
      toolActivityTimer = window.setTimeout(() => paintSessions(), Math.max(1, nearest - now + 1));
  }

  function stopToolActivityExpiry(): void {
    window.clearTimeout(toolActivityTimer);
    toolActivityTimer = undefined;
  }

  function sessionWorking(summary: SessionSummary): boolean {
    return sessionWorkingAt(summary, Date.now());
  }

  function sortSessionRows(rows: SessionSummary[]): SessionSummary[] {
    return rows.sort((left, right) => {
      if (right.updatedAt !== left.updatedAt)
        return right.updatedAt - left.updatedAt;
      if (left.id === right.id) return 0;
      return left.id < right.id ? 1 : -1;
    });
  }

  function mergeSessionRows(rows: SessionSummary[]): void {
    const merged = new Map(
      runtime.state.sessions.map((entry) => [entry.id, entry]),
    );
    for (const entry of rows) merged.set(entry.id, entry);
    runtime.state.sessions = sortSessionRows([...merged.values()]);
  }

  // Refreshes the catalog and controls. `detail: 'changed'` rereads the selected transcript only when a consumed push named it (or all transcripts) or its refreshed summary proves it stale; explicit refreshes keep `'reread'`. Pushes are consumed after the list arrives, so the detail read that follows always starts after every write they announced.
  async function loadSessions(
    detail: "reread" | "changed" = "reread",
  ): Promise<void> {
    const generation = ++runtime.state.sessionsLoadGeneration;
    const [list, catalog] = await Promise.all([
      runtime.ui.run(
        runtime.api.api.listSessions({
          limit: runtime.constants.SESSION_PAGE_SIZE,
        }),
      ),
      runtime.ui.run(runtime.api.api.listProjects()),
    ]);
    if (!list || generation !== runtime.state.sessionsLoadGeneration) return;
    const changed = runtime.state.changedTranscripts;
    runtime.state.changedTranscripts = { all: false, ids: new Set() };
    if (catalog) runtime.state.projects = catalog;
    // Once older pages have been requested, a hot refresh only replaces/updates the newest page. Throwing the older rows away here would make scrolling history vanish every 400 ms while a live chat is recording. Before pagination begins, replacing the first page is cheaper and also removes a session that was deleted elsewhere.
    if (runtime.state.loadedOlderSessions) {
      // This page is authoritative for its covered range, including withdrawn openings. Keep older pages, but do not merge a deleted newest row back into the sidebar.
      const oldest = list.sessions.at(-1);
      const present = new Set(list.sessions.map((row) => row.id));
      runtime.state.sessions = runtime.state.sessions.filter(
        (row) =>
          present.has(row.id) ||
          (!!list.nextCursor &&
            !!oldest &&
            (row.updatedAt < oldest.updatedAt ||
              (row.updatedAt === oldest.updatedAt && row.id < oldest.id))),
      );
      mergeSessionRows(list.sessions);
    } else {
      runtime.state.sessions = list.sessions;
      runtime.state.sessionPageCursor = list.nextCursor ?? null;
    }
    runtime.state.sessionTotal =
      typeof list.total === "number" ? list.total : list.sessions.length;
    runtime.state.activeId = list.activeId;
    // Whole-set replacement on every page, older pages included: a block belongs to a conversation, not to whichever page happened to carry its row.
    runtime.state.blockedChats = new Set(list.blocked);
    runtime.state.trustedChats = new Set(list.trusted ?? []);
    if (runtime.state.loadedOlderSessions) {
      for (const entry of list.pressure)
        runtime.state.pressure.set(entry.id, entry);
    } else {
      runtime.state.pressure = new Map(
        list.pressure.map((entry) => [entry.id, entry]),
      );
    }
    if (
      runtime.state.selectedId !== null &&
      !runtime.state.sessions.some((s) => s.id === runtime.state.selectedId)
    ) {
      runtime.state.selectedId = null;
      runtime.state.detailFor = null;
      runtime.state.detailCursor = null;
    }
    paintSessions();
    runtime.state.chatSearch?.refresh();
    const row =
      runtime.state.selectedId === null
        ? undefined
        : runtime.state.sessions.find(
            (entry) => entry.id === runtime.state.selectedId,
          );
    if (
      detail === "reread" ||
      runtime.state.selectedId === null ||
      runtime.state.detailFor !== runtime.state.selectedId ||
      changed.all ||
      changed.ids.has(runtime.state.selectedId) ||
      row?.updatedAt !== runtime.state.detailStamp?.updatedAt ||
      row?.events !== runtime.state.detailStamp?.events
    )
      await runtime.actions.loadDetail();
    else void runtime.actions.refreshSessionControls();
    void runtime.actions.refreshInputQueue();
  }

  async function loadMoreSessions(): Promise<void> {
    if (
      runtime.state.sessionPageLoading ||
      !runtime.state.sessionPageCursor ||
      runtime.state.sessions.length >= runtime.state.sessionTotal
    )
      return;
    runtime.state.sessionPageLoading = true;
    const cursor = runtime.state.sessionPageCursor;
    try {
      const page = await runtime.ui.run(
        runtime.api.api.listSessions({
          cursor,
          limit: runtime.constants.SESSION_PAGE_SIZE,
        }),
      );
      if (!page) return;
      mergeSessionRows(page.sessions);
      runtime.state.loadedOlderSessions = true;
      runtime.state.sessionTotal = page.total;
      runtime.state.sessionPageCursor = page.nextCursor;
      runtime.state.blockedChats = new Set(page.blocked);
      runtime.state.trustedChats = new Set(page.trusted ?? []);
      for (const entry of page.pressure)
        runtime.state.pressure.set(entry.id, entry);
      paintSessions();
    } finally {
      runtime.state.sessionPageLoading = false;
    }
  }

  function maybePageSessions(): void {
    if (
      !runtime.state.visible ||
      !runtime.state.sessionPageCursor ||
      runtime.state.sessions.length >= runtime.state.sessionTotal
    )
      return;
    const pane = runtime.ui.$("sessionList").closest<HTMLElement>(".scroll");
    if (!pane) return;
    if (
      pane.scrollHeight - pane.scrollTop - pane.clientHeight <=
      runtime.constants.SESSION_SCROLL_MARGIN
    ) {
      void loadMoreSessions();
    }
  }

  const renderer = createChatSessionListRenderer(runtime, scheduleToolActivityExpiry);
  const { projectSortEntries } = renderer;
  paintSessions = renderer.paintSessions;

  return {
    sortSessionRows,
    mergeSessionRows,
    loadSessions,
    loadMoreSessions,
    maybePageSessions,
    projectSortEntries,
    paintSessions,
    scheduleToolActivityExpiry,
    stopToolActivityExpiry,
    sessionWorking,
  };
}
