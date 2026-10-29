import type { LocalProject } from '../../../contracts/workspace/projects.js';
import type { SessionSummary } from '../../../contracts/session.js';
import { providerForConversationId } from '../../../contracts/web-providers.js';
import { $ } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';
import { ensureSelectedChatWarmup } from './chat-composer-ready.js';
import { recordChatSelection } from './chat-turn-state.js';

interface Runtime {
  get sessions(): SessionSummary[];
  get projects(): LocalProject[];
  get selectedId(): string | null;
  set selectedId(value: string | null);
  get selectedProjectId(): string | null;
  set selectedProjectId(value: string | null);
  get newChatSelected(): boolean;
  set newChatSelected(value: boolean);
  get selectionGeneration(): number;
  set selectionGeneration(value: number);
  get inputQueueGeneration(): number;
  set inputQueueGeneration(value: number);
  readonly readerAtEnd: boolean;
  readonly hasSendAnchor: boolean;
  readonly readingAfterSend: boolean;
  readonly expandedProjects: Set<string>;
  readonly expandedWorkers: Set<string>;
  rememberDraft(): void;
  replaceComposerDraft(): void;
  resetComposerQueue(): void;
  resetTimelineOwner(): void;
  resetNewChatTimeline(): void;
  clearPendingNewInput(): void;
  refreshBackgroundProcesses(): void;
  applySessionModel(id: string, summary: SessionSummary | undefined, generation: number): void;
  applyNewChatModel(): void;
  timelineShown(): boolean;
  projectGroup(id: string | null | undefined): string | null;
  restoreDraft(): void;
  paintJumpLatest(): void;
  paintSessions(): void;
  paintAutomationSwitch(): void;
  paintDetail(scrolling?: boolean): void;
  paintHandoff(): void;
  loadDetail(): void;
  refreshInputQueue(): void;
  stopProjectTurn(sessionId: string, previousProjectId: string | null): Promise<void>;
}

export function shouldStopDeepseekTurnOnProjectSwitch(
  previousProjectId: string | null,
  nextProjectId: string | null,
  session: SessionSummary | undefined
): boolean {
  return previousProjectId !== nextProjectId && (previousProjectId !== null || nextProjectId !== null) &&
    session?.origin?.kind !== 'worker' && session?.origin?.kind !== 'helper' &&
    !!session?.conversationId && providerForConversationId(session.conversationId) === 'deepseek';
}

export function createChatNavigation(runtime: Runtime) {
  let timelineScrollTop: number | null = null;

  function stopLeavingProjectTurn(sessionId: string | null, previousProjectId: string | null,
    nextProjectId: string | null): void {
    if (!sessionId || !shouldStopDeepseekTurnOnProjectSwitch(previousProjectId, nextProjectId,
      runtime.sessions.find(row => row.id === sessionId))) return;
    void runtime.stopProjectTurn(sessionId, previousProjectId).catch(() => undefined);
  }

  function showView(name: string): void {
    const pane = $('chatBody');
    const leavingTimeline = runtime.timelineShown() && name !== 'timeline';
    if (leavingTimeline) timelineScrollTop = pane.scrollTop;
    $('composer').hidden = name === 'settings';
    $('composerDock').hidden = name === 'settings';
    $('inputQueue').hidden = name !== 'timeline';
    for (const button of $('chatView').querySelectorAll<HTMLButtonElement>('[data-view]')) {
      button.classList.toggle('is-sel', button.dataset.view === name);
    }
    for (const view of document.querySelectorAll<HTMLElement>('#chatBody > .view')) {
      view.hidden = view.dataset.view !== name;
    }
    $('chatSettingsBtn').classList.toggle('is-on', name === 'settings');
    if (leavingTimeline) pane.scrollTop = 0;
    else if (name === 'timeline' && timelineScrollTop !== null) {
      pane.scrollTop = runtime.readerAtEnd && !runtime.hasSendAnchor && !runtime.readingAfterSend
        ? pane.scrollHeight
        : timelineScrollTop;
      timelineScrollTop = null;
    }
    runtime.paintJumpLatest();
  }

  function selectSession(id: string): void {
    const ownerChanged = id !== runtime.selectedId;
    const previousId = runtime.selectedId;
    const previousProjectId = runtime.selectedProjectId;
    const selected = runtime.sessions.find(row => row.id === id);
    const parent = selected?.origin?.kind === 'worker' ? selected.origin.fromSessionId : null;
    const nextProjectId = runtime.projectGroup(parent
      ? runtime.sessions.find(row => row.id === parent)?.projectId
      : selected?.projectId);
    stopLeavingProjectTurn(previousId, previousProjectId, nextProjectId);
    runtime.rememberDraft();
    runtime.selectionGeneration++;
    runtime.replaceComposerDraft();
    runtime.inputQueueGeneration++;
    runtime.resetComposerQueue();
    runtime.newChatSelected = false;
    runtime.selectedId = id;
    recordChatSelection(id, runtime.selectionGeneration);
    showView('timeline');
    runtime.refreshBackgroundProcesses();
    runtime.applySessionModel(id, selected, runtime.selectionGeneration);
    if (parent) runtime.expandedWorkers.add(parent);
    runtime.selectedProjectId = nextProjectId;
    if (runtime.selectedProjectId) runtime.expandedProjects.add(runtime.selectedProjectId);
    runtime.paintAutomationSwitch();
    ui($<HTMLTextAreaElement>('chatInput'), 'placeholder', () => t('Ask anything…'));
    runtime.restoreDraft();
    if (ownerChanged) {
      runtime.resetTimelineOwner();
      $('timeline').setAttribute('inert', '');
      $('timeline').setAttribute('aria-busy', 'true');
    }
    // Mark the history handshake before repainting the sidebar so stale
    // provider activity cannot flash as a live response while the chat opens.
    ensureSelectedChatWarmup();
    runtime.paintSessions();
    if (ownerChanged) {
      runtime.paintDetail(false);
      runtime.paintHandoff();
    }
    runtime.loadDetail();
    runtime.refreshInputQueue();
  }

  function selectNewChat(projectId: string | null = null): void {
    stopLeavingProjectTurn(runtime.selectedId, runtime.selectedProjectId, projectId);
    runtime.rememberDraft();
    runtime.selectionGeneration++;
    runtime.replaceComposerDraft();
    runtime.clearPendingNewInput();
    runtime.inputQueueGeneration++;
    runtime.resetComposerQueue();
    runtime.newChatSelected = true;
    runtime.selectedId = null;
    recordChatSelection(null, runtime.selectionGeneration);
    runtime.selectedProjectId = projectId;
    runtime.paintAutomationSwitch();
    runtime.resetNewChatTimeline();
    runtime.refreshBackgroundProcesses();
    if (projectId) runtime.expandedProjects.add(projectId);
    runtime.applyNewChatModel();
    $('inputQueue').replaceChildren();
    runtime.restoreDraft();
    showView('timeline');
    runtime.paintSessions();
    runtime.loadDetail();
    if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      $('composer').animate?.([{ opacity: 0.45 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' });
    }
    ui($<HTMLTextAreaElement>('chatInput'), 'placeholder', () => projectId
      ? t('Message in {0}…', [runtime.projects.find(project => project.id === projectId)?.name ?? 'project'])
      : t('Ask anything…'));
    ensureSelectedChatWarmup();
    $<HTMLTextAreaElement>('chatInput').focus();
  }

  return { showView, selectSession, selectNewChat };
}
