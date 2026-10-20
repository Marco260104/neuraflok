import type { ChatSearch } from './chat-search.js';
import { createChatSearchNavigation } from './chat-search-navigation.js';
import type { ChatWorkspaceContentPanels } from './chat-workspace-panels.js';
import { createWorkspaceDocks } from '../workspace/docks/controller.js';
import { initSkills } from '../settings/skill-composer/composer.js';
import { applyComposerSessionModel, observedComposerModel } from './chat-models.js';
import { createChatEventRenderer } from './chat-event-renderer.js';
import { createTimelinePresentation } from './timeline-presentation.js';
import { createChatSessionActions } from './chat-session-actions.js';
import { createChatSessionRemoval } from './chat-session-removal.js';
import { createChatNavigation } from './chat-navigation.js';
import { createChatProjectControls } from './chat-project-controls.js';
import { createChatTaskControls } from './chat-task-controls.js';
import { createChatComposerAttachments, type ComposerDraftOwner } from './chat-composer-attachments.js';
import { createChatSessionControls } from './chat-session-controls.js';
import { createChatDraftState } from './chat-draft-state.js';
import { createChatDeliveryControls } from './chat-delivery-controls.js';
import { createChatSessionChangeScheduler } from './chat-session-change-scheduler.js';
import { createChatInputNoticeDismissals } from './chat-input-notice-dismissals.js';
import { createChatVisibilityLifecycle } from './chat-visibility-lifecycle.js';
export type { ComposerDraftOwner } from './chat-composer-attachments.js';

import { createAgentPanel } from '../agents/agent-panel.js';
import { renderSwarmView } from '../agents/swarm-view.js';
import { createChatReaderState } from './chat-reader-state.js';
import { createSidebarOrder } from './sidebar/order.js';
import { createSidebarPins } from './sidebar/pins.js';
import { createSidebarCompletionState } from './sidebar/completion-state.js';
import { paintContextMeter } from './context-meter.js';
import { ensureSelectedChatWarmup } from './chat-composer-ready.js';

import type { InputEntry } from '../../../backend/domains/sessions/input/input.js';
import type { LocalProject } from '../../../contracts/workspace/projects.js';
// Desktop chat workspace: recorded prose/tool truth, exact-session controls and a composer. The companion extension drives signed-in provider pages; main owns permissions, delivery, Goal and compaction. The renderer crosses only the fixed preload API and scopes async views to the selected session generation. Token and cost values remain explicitly estimates.

import type {
  Handoff,
  SessionEvent,
  SessionSummary,
  SwarmState,
  TokenPressure
} from '../../../contracts/session.js';
import type { AppState, Config } from '../../../contracts/types.js';
import { $, run, toast } from '../../shared/dom.js';
import type { RowMenuItem } from './row-menu.js';
import { renderedMarkdown, renderedMessage } from './markdown-renderer.js';
import { createChatFeatureComposition } from './chat-runtime-composition.js';
import { createChatRuntimeBindings, liveBinding, liveGetter } from './chat-runtime-bindings.js';
import { initializeChatRenderer } from './chat-initialization.js';
import { createChatRendererAdapters } from './chat-renderer-adapters.js';
import { createChatRenderingRuntime, type ChatRenderingRuntime } from './chat-rendering-runtime.js';
import { createChatTaskRuntime } from './chat-task-runtime.js';
import { t } from '../../shared/i18n.js';
export { renderedMarkdown, renderedMessage };

export let chatDetailRendererRuntime: ChatRenderingRuntime['chatDetailRendererRuntime'] = {} as ChatRenderingRuntime['chatDetailRendererRuntime'];
let paintDetail: ChatRenderingRuntime['paintDetail'] = () => {};
let chatRecoveryView: ChatRenderingRuntime['chatRecoveryView'] = {} as ChatRenderingRuntime['chatRecoveryView'];

const api = window.api;
let chatSearch: ChatSearch | null = null;
let chatSearchNavigation: ReturnType<typeof createChatSearchNavigation> | null = null;
let chatEventRenderer: ReturnType<typeof createChatEventRenderer> | null = null;
let timelinePresentation: ReturnType<typeof createTimelinePresentation> | null = null;
let chatNavigation: ReturnType<typeof createChatNavigation> | null = null;
let chatComposerAttachments: ReturnType<typeof createChatComposerAttachments> | null = null;
let chatTaskControls: ReturnType<typeof createChatTaskControls> | null = null;
let chatSessionControls: ReturnType<typeof createChatSessionControls> | null = null;
let chatDraftState: ReturnType<typeof createChatDraftState> | null = null;
let chatDeliveryControls: ReturnType<typeof createChatDeliveryControls> | null = null;

function drafts(): NonNullable<typeof chatDraftState> {
  if (!chatDraftState) throw new Error('Chat draft state is not initialized');
  return chatDraftState;
}

function taskControls(): NonNullable<typeof chatTaskControls> {
  if (!chatTaskControls) throw new Error('Chat task controls are not initialized');
  return chatTaskControls;
}

function navigation(): NonNullable<typeof chatNavigation> {
  if (!chatNavigation) throw new Error('Chat navigation is not initialized');
  return chatNavigation;
}

function eventRenderer(): NonNullable<typeof chatEventRenderer> {
  if (!chatEventRenderer) throw new Error('Chat event renderer is not initialized');
  return chatEventRenderer;
}

function timelineView(): NonNullable<typeof timelinePresentation> {
  if (!timelinePresentation) throw new Error('Timeline presentation is not initialized');
  return timelinePresentation;
}

const {
  eventBody,
  attachmentCard,
  answerActions,
  retainedInputImages,
  paintMessageReaction,
  stoppedTurnEnd,
  timelineItems,
  itemKey,
  itemSignature,
  eventRow,
  compactionRow,
  reconcileChildren,
  renderRounds,
  tagImageRow,
  groupImageRows,
  paintInputReceipt,
  hasLaterModelActivity
} = createChatRendererAdapters(eventRenderer, timelineView);

// Page size and bounded staging capacity. A page is not a viewport: hundreds of collapsed tool records can occupy less space than one authored message.
const MAX_TIMELINE_ROWS = 160;
const TIMELINE_BATCH_SIZE = 30;
const SESSION_PAGE_SIZE = 60;
const SESSION_SCROLL_MARGIN = 72;

// Unattributed activity stays separate from all agents so filtered views cannot hide calls whose owner is unknown.
const UNATTRIBUTED = '\u0000unattributed';
let agentFilter: string | null = null;
// The session the current filter was chosen in; selecting a different one resets it.
let filterFor: string | null = null;

export interface ChatRendererDependencies {
  // The renderer's single save path — reads every control, including ours.
  save: () => Promise<void>;
  state: () => AppState | null;
}

let deps: ChatRendererDependencies;
const chatVisibility = createChatVisibilityLifecycle({
  loadSessions: () => loadSessions(),
  loadSwarm: () => run(api.getSwarm()),
  paintSwarm: state => paintSwarm(state),
  stopToolActivityExpiry: () => chatSessionList.stopToolActivityExpiry(),
  clearDurationTimer: () => window.clearTimeout(chatTaskRuntime.durationTimer)
});
const chatSessionChangeScheduler = createChatSessionChangeScheduler({
  isVisible: () => chatVisibility.visible,
  loadSessions: detail => loadSessions(detail)
});
const scheduleReload = chatSessionChangeScheduler.scheduleReload;

let sessions: SessionSummary[] = [];
let pressure = new Map<string, TokenPressure>();
let sessionTotal = 0;
let sessionPageCursor: { updatedAt: number; id: string } | null = null;
let sessionPageLoading = false;
// True after the user has explicitly paged beyond the newest page.
let loadedOlderSessions = false;
let activeId: string | null = null;
let selectedId: string | null = null;
let newChatSelected = true;
let selectedProjectId: string | null = null;
let projects: LocalProject[] = [];
// Window-local disclosure intent. Project groups start closed until the user or selection opens one.
const expandedProjects = new Set<string>();
const projectVisibleCounts = new Map<string, number>();
let chatProjectControls: ReturnType<typeof createChatProjectControls> | null = null;
function projectControls(): ReturnType<typeof createChatProjectControls> {
  if (!chatProjectControls) throw new Error('Chat project controls are not initialized');
  return chatProjectControls;
}
function projectGroup(id: string | null | undefined): string | null { return projectControls().projectGroup(id); }
function rowMenuButton(owner: string): HTMLElement | null { return projectControls().rowMenuButton(owner); }
function projectMenuItems(id: string): RowMenuItem[] { return projectControls().projectMenuItems(id); }
function selectedLocalProject(): LocalProject | null { return projectControls().selectedLocalProject(); }
let workspaceTerminal: ChatWorkspaceContentPanels['workspaceTerminal'] | null = null;
let rightWorkspaceTerminal: ChatWorkspaceContentPanels['rightWorkspaceTerminal'] | null = null;
let workspaceDocks: ReturnType<typeof createWorkspaceDocks> | null = null;
const PROJECT_TASK_PAGE_SIZE = 5;
const PROJECT_TASK_PAGE_INCREMENT = 8;
let sidebarOrder: ReturnType<typeof createSidebarOrder> | undefined;
let sidebarPins: ReturnType<typeof createSidebarPins> | undefined;
// Only a person's own recorded chats can be pinned; workers live inside their task's row.
const pinnable = (entry: SessionSummary): boolean => !!entry.conversationId && entry.origin?.kind !== 'worker';
const pinnedChat = (entry: SessionSummary): boolean => pinnable(entry) && sidebarPins?.has(entry.id) === true;
let sidebarCompletion: ReturnType<typeof createSidebarCompletionState> | undefined;
function draftKey(): string { return drafts().draftKey(); }
let selectionGeneration = 0;
function composerDraftOwner(): ComposerDraftOwner { return drafts().composerDraftOwner(); }
function ownsComposerDraft(owner: ComposerDraftOwner): boolean { return drafts().ownsComposerDraft(owner); }
function replaceComposerDraft(): void { drafts().replaceComposerDraft(); }
let pendingNewInput: { id: string; generation: number } | null = null;
let agentPanel: ReturnType<typeof createAgentPanel> | null = null;
let filePanel: ChatWorkspaceContentPanels['filePanel'] | null = null;
let reviewPanel: ChatWorkspaceContentPanels['reviewPanel'] | null = null;
const expandedWorkers = new Set<string>();
const startingInputs = new Map<string, InputEntry>();
const visibleInputIds = new Set<string>();
// Window-local presentation only: a new incident or changed status is visible again.
const dismissedRecoveryNotices = new Map<string, string>();
// Dismisses presentation only; durable cancellation and late receipts remain in the outbox.
const { dismissedInputNotices, dismissInputNotice } = createChatInputNoticeDismissals({
  storage: () => window.localStorage,
  refreshInputQueue: () => refreshInputQueue()
});
function authoredComposerText(): string { return drafts().authoredText(); }
function rememberDraft(): void { drafts().rememberDraft(); }
let skillPicker: ReturnType<typeof initSkills> | undefined;
function restoreDraft(): void { drafts().restoreDraft(); }
function paintComposerImages(): void {
  chatComposerAttachments?.paint();
}

let events: SessionEvent[] = [];
let totalEvents = 0;
// The session whose `events`/cursor pair belongs together.
let detailFor: string | null = null;
let detailCursor: number | null = null;
let historyBefore: number | null = null;
let historyLoading = false;
let historyRefreshPending = false;
let historyDemand: { sessionId: string; selection: number; direction: number; opening: boolean } | null = null;
let historyStart: number | null = null;
// The last swarm the app reported, so the header can summarise it without the log.
let swarm: SwarmState | null = null;
// The renderer mirrors the main process policy that blocks a browser conversation from using local tools.
let blockedChats = new Set<string>();
// Exact conversations explicitly allowed while strict chat allowlisting is enabled.
let trustedChats = new Set<string>();
// Badges the list is currently drawn with. See repaintBadges.
let badgeKey = '';

// Handoff currently shown, and the id it was loaded for.
let handoff: Handoff | null = null;
let handoffFor: string | null = null;

// Summary values the selected transcript's latest live-tail read was requested against.
let detailStamp: { updatedAt: number; events: number } | null = null;
let sessionsLoadGeneration = 0;
let detailLoadGeneration = 0;
let handoffLoadGeneration = 0;

// Sessions
function pressureOf(id: string): TokenPressure | null {
  return pressure.get(id) ?? null;
}

export type { Badge } from './chat-session-row.js';

let renaming: { id: string; original: string; value: string; start: number; end: number } | null = null;

function sessionWorking(summary: SessionSummary): boolean {
  return chatSessionList.sessionWorking(summary);
}

function sessionBadges(summary: SessionSummary) {
  return chatSessionRows.sessionBadges(summary);
}

function placeSessionTooltip(tip: HTMLElement, row: HTMLElement): void {
  chatSessionRows.placeSessionTooltip(tip, row);
}

function sessionRow(summary: SessionSummary): HTMLElement {
  return chatSessionRows.sessionRow(summary);
}

const removeSessionFromView = createChatSessionRemoval({
  get sessions() { return sessions; },
  set sessions(value) { sessions = value; },
  pressure,
  get sessionTotal() { return sessionTotal; },
  set sessionTotal(value) { sessionTotal = value; },
  get selectedId() { return selectedId; },
  set selectedId(value) { selectedId = value; },
  get events() { return events; },
  set events(value) { events = value; },
  get totalEvents() { return totalEvents; },
  set totalEvents(value) { totalEvents = value; },
  get detailFor() { return detailFor; },
  set detailFor(value) { detailFor = value; },
  get detailCursor() { return detailCursor; },
  set detailCursor(value) { detailCursor = value; },
  get handoff() { return handoff; },
  set handoff(value) { handoff = value; },
  get handoffFor() { return handoffFor; },
  set handoffFor(value) { handoffFor = value; },
  get detailLoadGeneration() { return detailLoadGeneration; },
  set detailLoadGeneration(value) { detailLoadGeneration = value; },
  get handoffLoadGeneration() { return handoffLoadGeneration; },
  set handoffLoadGeneration(value) { handoffLoadGeneration = value; }
});

export const chatSessionActionsRuntime = {
  $,
  api,
  loadSessions: () => loadSessions(),
  paintSessions: () => paintSessions(),
  removeFromView: removeSessionFromView,
  run,
  save: () => deps.save(),
  setBlockedChats: (value: Set<string>) => { blockedChats = value; },
  setTrustedChats: (value: Set<string>) => { trustedChats = value; },
  toast,
  t
};
const chatSessionActions = createChatSessionActions(chatSessionActionsRuntime);

const chatTaskRuntime = createChatTaskRuntime({
  api,
  taskControls,
  taskPlanController: () => taskPlanController,
  get selectedId() { return selectedId; },
  get selectionGeneration() { return selectionGeneration; },
  get chatDeliveryControls() { return chatDeliveryControls; },
  get chatSessionControls() { return chatSessionControls; }
});
const {
  cancelGoalRequest,
  paintGoalProgress,
  paintDeliveryControls,
  dockAction,
  closeObjectiveEditor,
  openObjectiveEditor,
  currentPreparedPlan,
  paintTaskPlan,
  createTaskPlan,
  sendPreparedPlan,
  paintLoopDeliveryTitle,
  paintTaskActions,
  paintLoopDelivery,
  openingLoopDelivery,
  paintAutomationSwitch,
  refreshSessionControls
} = chatTaskRuntime;

async function loadDetail(navigate = false, olderBefore?: number, newerFrom?: number): Promise<boolean> {
  return chatTimelineHistory.loadDetail(navigate, olderBefore, newerFrom);
}

// Timeline rows stay expanded by durable call id across recorded updates.
const openTools = new Set<string>();

// Preserve unchanged timeline rows by signature so streamed activity does not collapse details or shift the reader's position.
const rowCache = new Map<string, { sig: string; row: HTMLElement }>();

// A sent message rides to the top of the view and its answer grows in the reserved space beneath it, so nothing moves while it streams; an answer taller than the view is read from the top rather than chased. Scrolling by the reader releases the hold, and a button brings them back to the end whenever content lies below.
const followOutput = (): boolean => deps.state()?.config.ui.followOutput !== false;
type ChatReader = ReturnType<typeof createChatReaderState>;
let chatReaderState: ChatReader | null = null;
function chatReader(): ChatReader {
  if (!chatReaderState) throw new Error('Chat reader state is not initialized');
  return chatReaderState;
}

function userMessageKeys(): Set<string> { return chatReader().userMessageKeys(); }
function holdSentMessage(): boolean { return chatReader().holdSentMessage(); }

function distanceFromTail(): number { return chatReader().distanceFromTail(); }
function timelineShown(): boolean { return chatReader().timelineShown(); }
function paintJumpLatest(): void { chatReader().paintJumpLatest(); }
function jumpToLatest(): void { chatReader().jumpToLatest(); }

function readTimeline(): void { chatReader().readTimeline(); }

function forgetTimelineRows(): void {
  openTools.clear();
  rowCache.clear();
}

function requestHistory(direction: number, opening = false): void { chatTimelineHistory.requestHistory(direction, opening); }
async function fillTimelineHistory(): Promise<void> { return chatTimelineHistory.fillTimelineHistory(); }
function paintAgentFilter(): void { chatTimelineHistory.paintAgentFilter(); }
function visibleEvents(): SessionEvent[] { return chatTimelineHistory.visibleEvents(); }
// Keeps disclosure state for grouped tool activity.
const toolGroups = new Map<string, HTMLElement>();
// Maps painted rows to the recorded event that produced them.
const rowEvents = new WeakMap<HTMLElement, SessionEvent>();
// Keeps timeline rows for assistant narration that has no recorded message.
let roundsEnter = false;
function composerSessionSelection(summary: SessionSummary | null | undefined) {
  if (summary?.conversationId) return summary.selectedModel;
  const opening = chatTaskRuntime.pendingComposerInputs.find(row => row.opening && row.sessionId === summary?.id && ['queued', 'browser'].includes(row.state));
  return opening?.model ? { model: opening.model, reasoningEffort: opening.reasoningEffort ?? undefined, observedAt: opening.createdAt } : null;
}
function paintHandoff(): void { chatRecoveryView.paintHandoff(); }

function paintRecoveryStatus(): boolean { return chatRecoveryView.paintRecoveryStatus(); }

// Each turn opens with how long it has worked: "Working for 12s" live on the turn in progress, "Worked for 17s" once the page reports its end. The live line mirrors the status caption (same text, same clock) and the header no longer repeats it; earlier completed turns keep a still line. Nothing folds. A running turn with no row on screen yet (just sent, or a page that reports no turn) shows its line right after your pending message, where the turn will begin, so the line is born in place instead of appearing in the header and moving. A finished turn with no row on screen (an empty chat, a folded Compact & Resume) keeps the caption in the header.
function placeTurnLines(rows: HTMLElement[], workedSeconds: ReadonlyMap<number, number>): void {
  chatProgress.placeTurnLines(rows, workedSeconds);
}

function exchangeDurations(list: readonly SessionEvent[]): Map<number, number> {
  return chatProgress.exchangeDurations(list);
}

function paintStateLine(): void {
  chatProgress.paintStateLine();
}

function badgeSignature(): string {
  return chatProgress.badgeSignature();
}

function paintBackgroundProcesses(): void {
  chatProgress.paintBackgroundProcesses();
}

function refreshBackgroundProcesses(): void {
  chatProgress.refreshBackgroundProcesses();
}

function paintSwarm(state: SwarmState): void {
  swarm = state;
  renderSwarmView(state, { paintStateLine, paintSessions });
}

export function chatSettingsPatch(current: Config) {
  return chatSettings.chatSettingsPatch(current);
}

export function chatApply(state: AppState, previous?: Config): void {
  chatSettings.chatApply(state, previous);
  if (deps) {
    paintDeliveryControls();
    ensureSelectedChatWarmup();
  }
}

// Called when the Chat tab becomes visible or is left, so it only polls when shown.
export function chatVisible(next: boolean): void {
  chatVisibility.setVisible(next);
}

// Retired automatic drafts belong to their creation time, never the live composer queue.
function historicalAutomaticInput(entry: InputEntry): boolean { return chatInputQueue.historicalAutomaticInput(entry); }
function inputMessageRow(entry: InputEntry, notice: boolean): HTMLElement { return chatInputQueue.inputMessageRow(entry, notice); }
async function adoptAcceptedOpening(entry: InputEntry): Promise<boolean> { return chatInputQueue.adoptAcceptedOpening(entry); }
function paintPendingInputs(): void { chatInputQueue.paintPendingInputs(); }
async function refreshInputQueue(): Promise<void> { return chatInputQueue.refreshInputQueue(); }
function showAutoSkillReceipt(entry: Pick<InputEntry, 'autoSkills'>): void { chatInputQueue.showAutoSkillReceipt(entry); }
async function sendComposer(delivery?: 'finish', plan?: string[], planObjective?: string, controlAction = false): Promise<boolean | void> {
  return chatComposerDelivery.sendComposer(delivery, plan, planObjective, controlAction);
}

// Open the chat search dialog from the View menu or primary shortcut.
export function openChatSearch(): void {
  chatSearch?.open();
}

// Switches the session card's body. Settings is reachable only from the gear, so it is deliberately not one of the switcher buttons: while it is open no switcher button is selected, and the gear itself carries the selected state instead. That is what keeps a property sheet from reading as a third view of this session.
export function openChatView(name: string): void {
  showView(name);
}

function showView(name: string): void { navigation().showView(name); }
function selectSession(id: string): void { navigation().selectSession(id); }
function selectNewChat(projectId: string | null = null): void { navigation().selectNewChat(projectId); }

export function initChat(next: ChatRendererDependencies): void {
  initializeChatRenderer(chatInitializationBindings, next);
}

// Gives the session list its shared state, UI helpers, and owner actions.
export const chatRuntimeBindings = createChatRuntimeBindings(
  {
  api,
  drafts,
  taskControls,
  attachmentCard,
  timelineItems,
  itemKey,
  reconcileChildren,
  hasLaterModelActivity,
  MAX_TIMELINE_ROWS,
  TIMELINE_BATCH_SIZE,
  SESSION_PAGE_SIZE,
  SESSION_SCROLL_MARGIN,
  UNATTRIBUTED,
  expandedProjects,
  projectVisibleCounts,
  projectGroup,
  rowMenuButton,
  projectMenuItems,
  selectedLocalProject,
  PROJECT_TASK_PAGE_SIZE,
  PROJECT_TASK_PAGE_INCREMENT,
  pinnable,
  pinnedChat,
  draftKey,
  replaceComposerDraft,
  expandedWorkers,
  startingInputs,
  visibleInputIds,
  dismissedInputNotices,
  dismissInputNotice,
  authoredComposerText,
  rememberDraft,
  paintComposerImages,
  dismissedRecoveryNotices,
  sessionWorking,
  sessionBadges,
  placeSessionTooltip,
  sessionRow,
  chatSessionActions,
  cancelGoalRequest,
  paintGoalProgress,
  cancelledStarts: chatTaskRuntime.cancelledStarts,
  paintDeliveryControls,
  dockAction,
  closeObjectiveEditor,
  openObjectiveEditor,
  currentPreparedPlan,
  paintTaskPlan,
  createTaskPlan,
  sendPreparedPlan,
  paintLoopDeliveryTitle,
  paintTaskActions,
  openingLoopDelivery,
  paintAutomationSwitch,
  refreshSessionControls,
  loadDetail,
  followOutput,
  chatReader,
  applyComposerSessionModel,
  composerSessionSelection,
  paintContextMeter,
  observedComposerModel,
  paintBackgroundProcesses,
  paintAgentFilter,
  visibleEvents,
  historicalAutomaticInput,
  inputMessageRow,
  exchangeDurations,
  stoppedTurnEnd,
  itemSignature,
  paintMessageReaction,
  paintInputReceipt,
  compactionRow,
  eventRow,
  answerActions,
  placeTurnLines,
  groupImageRows,
  renderRounds,
  paintPendingInputs,
  pressureOf,
  paintJumpLatest,
  userMessageKeys,
  holdSentMessage,
  timelineShown,
  paintRecoveryStatus,
  paintStateLine,
  badgeSignature,
  adoptAcceptedOpening,
  refreshInputQueue,
  showAutoSkillReceipt,
  stopCurrentTurn: () => chatTaskRuntime.stopCurrentTurn(),
  sendComposer,
  selectSession,
  selectNewChat,
  },
  {
    chatSearch: liveBinding(() => chatSearch, value => { chatSearch = value; }),
    chatTaskControls: liveBinding(() => chatTaskControls, value => { chatTaskControls = value; }),
    chatSessionControls: liveBinding(() => chatSessionControls, value => { chatSessionControls = value; }),
    chatDraftState: liveBinding(() => chatDraftState, value => { chatDraftState = value; }),
    chatDeliveryControls: liveBinding(() => chatDeliveryControls, value => { chatDeliveryControls = value; }),
    agentFilter: liveBinding(() => agentFilter, value => { agentFilter = value; }),
    filterFor: liveBinding(() => filterFor, value => { filterFor = value; }),
    deps: liveBinding(() => deps, value => { deps = value; }),
    visible: liveBinding(() => chatVisibility.visible, value => { chatVisibility.setVisibleState(value); }),
    sessions: liveBinding(() => sessions, value => { sessions = value; }),
    pressure: liveBinding(() => pressure, value => { pressure = value; }),
    sessionTotal: liveBinding(() => sessionTotal, value => { sessionTotal = value; }),
    sessionPageCursor: liveBinding(() => sessionPageCursor, value => { sessionPageCursor = value; }),
    sessionPageLoading: liveBinding(() => sessionPageLoading, value => { sessionPageLoading = value; }),
    loadedOlderSessions: liveBinding(() => loadedOlderSessions, value => { loadedOlderSessions = value; }),
    activeId: liveBinding(() => activeId, value => { activeId = value; }),
    selectedId: liveBinding(() => selectedId, value => { selectedId = value; }),
    newChatSelected: liveBinding(() => newChatSelected, value => { newChatSelected = value; }),
    selectedProjectId: liveBinding(() => selectedProjectId, value => { selectedProjectId = value; }),
    projects: liveBinding(() => projects, value => { projects = value; }),
    chatProjectControls: liveBinding(() => chatProjectControls, value => { chatProjectControls = value; }),
    workspaceTerminal: liveBinding(() => workspaceTerminal, value => { workspaceTerminal = value; }),
    rightWorkspaceTerminal: liveBinding(() => rightWorkspaceTerminal, value => { rightWorkspaceTerminal = value; }),
    workspaceDocks: liveBinding(() => workspaceDocks, value => { workspaceDocks = value; }),
    sidebarOrder: liveBinding(() => sidebarOrder, value => { sidebarOrder = value; }),
    sidebarPins: liveBinding(() => sidebarPins, value => { sidebarPins = value; }),
    sidebarCompletion: liveBinding(() => sidebarCompletion, value => { sidebarCompletion = value; }),
    selectionGeneration: liveBinding(() => selectionGeneration, value => { selectionGeneration = value; }),
    pendingNewInput: liveBinding(() => pendingNewInput, value => { pendingNewInput = value; }),
    agentPanel: liveBinding(() => agentPanel, value => { agentPanel = value; }),
    filePanel: liveBinding(() => filePanel, value => { filePanel = value; }),
    reviewPanel: liveBinding(() => reviewPanel, value => { reviewPanel = value; }),
    skillPicker: liveBinding(() => skillPicker, value => { skillPicker = value; }),
    events: liveBinding(() => events, value => { events = value; }),
    totalEvents: liveBinding(() => totalEvents, value => { totalEvents = value; }),
    detailFor: liveBinding(() => detailFor, value => { detailFor = value; }),
    detailCursor: liveBinding(() => detailCursor, value => { detailCursor = value; }),
    historyBefore: liveBinding(() => historyBefore, value => { historyBefore = value; }),
    historyLoading: liveBinding(() => historyLoading, value => { historyLoading = value; }),
    historyRefreshPending: liveBinding(() => historyRefreshPending, value => { historyRefreshPending = value; }),
    historyDemand: liveBinding(() => historyDemand, value => { historyDemand = value; }),
    historyStart: liveBinding(() => historyStart, value => { historyStart = value; }),
    swarm: liveBinding(() => swarm, value => { swarm = value; }),
    blockedChats: liveBinding(() => blockedChats, value => { blockedChats = value; }),
    trustedChats: liveBinding(() => trustedChats, value => { trustedChats = value; }),
    badgeKey: liveBinding(() => badgeKey, value => { badgeKey = value; }),
    changedTranscripts: liveBinding(() => chatSessionChangeScheduler.changedTranscripts, value => { chatSessionChangeScheduler.changedTranscripts = value; }),
    detailStamp: liveBinding(() => detailStamp, value => { detailStamp = value; }),
    sessionsLoadGeneration: liveBinding(() => sessionsLoadGeneration, value => { sessionsLoadGeneration = value; }),
    detailLoadGeneration: liveBinding(() => detailLoadGeneration, value => { detailLoadGeneration = value; }),
    handoffLoadGeneration: liveBinding(() => handoffLoadGeneration, value => { handoffLoadGeneration = value; }),
    handoff: liveBinding(() => handoff, value => { handoff = value; }),
    handoffFor: liveBinding(() => handoffFor, value => { handoffFor = value; }),
    renaming: liveBinding(() => renaming, value => { renaming = value; }),
    diagnosticsExpanded: liveBinding(() => chatTaskRuntime.diagnosticsExpanded, value => { chatTaskRuntime.diagnosticsExpanded = value; }),
    controlsGeneration: liveBinding(() => chatTaskRuntime.controlsGeneration, value => { chatTaskRuntime.controlsGeneration = value; }),
    controlledSessionId: liveBinding(() => chatTaskRuntime.controlledSessionId, value => { chatTaskRuntime.controlledSessionId = value; }),
    controlledTurnId: liveBinding(() => chatTaskRuntime.controlledTurnId, value => { chatTaskRuntime.controlledTurnId = value; }),
    controlledSelection: liveBinding(() => chatTaskRuntime.controlledSelection, value => { chatTaskRuntime.controlledSelection = value; }),
    controlledStopPending: liveBinding(() => chatTaskRuntime.controlledStopPending, value => { chatTaskRuntime.controlledStopPending = value; }),
    controlledFinishWaiting: liveBinding(() => chatTaskRuntime.controlledFinishWaiting, value => { chatTaskRuntime.controlledFinishWaiting = value; }),
    controlledQueueAtFinish: liveBinding(() => chatTaskRuntime.controlledQueueAtFinish, value => { chatTaskRuntime.controlledQueueAtFinish = value; }),
    controlledCanInject: liveBinding(() => chatTaskRuntime.controlledCanInject, value => { chatTaskRuntime.controlledCanInject = value; }),
    controlledCanSendDirectly: liveBinding(() => chatTaskRuntime.controlledCanSendDirectly, value => { chatTaskRuntime.controlledCanSendDirectly = value; }),
    controlledRecovery: liveBinding(() => chatTaskRuntime.controlledRecovery, value => { chatTaskRuntime.controlledRecovery = value; }),
    pendingComposerInputs: liveBinding(() => chatTaskRuntime.pendingComposerInputs, value => { chatTaskRuntime.pendingComposerInputs = value; }),
    inputQueueGeneration: liveBinding(() => chatTaskRuntime.inputQueueGeneration, value => { chatTaskRuntime.inputQueueGeneration = value; }),
    goalIntentGeneration: liveBinding(() => chatTaskRuntime.goalIntentGeneration, value => { chatTaskRuntime.goalIntentGeneration = value; }),
    goalProgress: liveBinding(() => chatTaskRuntime.goalProgress, value => { chatTaskRuntime.goalProgress = value; }),
    goalDraftView: liveBinding(() => chatTaskRuntime.goalDraftView, value => { chatTaskRuntime.goalDraftView = value; }),
    goalWaitView: liveBinding(() => chatTaskRuntime.goalWaitView, value => { chatTaskRuntime.goalWaitView = value; }),
    finishGoalDraftView: liveBinding(() => chatTaskRuntime.finishGoalDraftView, value => { chatTaskRuntime.finishGoalDraftView = value; }),
    durationTimer: liveBinding(() => chatTaskRuntime.durationTimer, value => { chatTaskRuntime.durationTimer = value; }),
    roundsEnter: liveBinding(() => roundsEnter, value => { roundsEnter = value; }),
    rowCache: liveGetter(() => rowCache),
    toolGroups: liveGetter(() => toolGroups),
    rowEvents: liveGetter(() => rowEvents),
    paintDetail: liveGetter(() => paintDetail),
    chatRecoveryView: liveGetter(() => chatRecoveryView),
  }
);
export type ChatRuntimeBindings = typeof chatRuntimeBindings;
const chatRenderingRuntime = createChatRenderingRuntime(chatRuntimeBindings, () => chatProgress.turnWorking);
chatDetailRendererRuntime = chatRenderingRuntime.chatDetailRendererRuntime;
paintDetail = chatRenderingRuntime.paintDetail;
chatRecoveryView = chatRenderingRuntime.chatRecoveryView;
const chatFeatureComposition = createChatFeatureComposition(chatRuntimeBindings);

export const chatProgressRuntime = chatFeatureComposition.chatProgressRuntime;
const chatProgress = chatFeatureComposition.chatProgress;
export const chatTimelineHistoryRuntime = chatFeatureComposition.chatTimelineHistoryRuntime;
const chatTimelineHistory = chatFeatureComposition.chatTimelineHistory;
export const chatInputQueueRuntime = chatFeatureComposition.chatInputQueueRuntime;
const chatInputQueue = chatFeatureComposition.chatInputQueue;
export const chatComposerDeliveryRuntime = chatFeatureComposition.chatComposerDeliveryRuntime;
const chatComposerDelivery = chatFeatureComposition.chatComposerDelivery;
export const chatTaskPlanRuntime = chatFeatureComposition.chatTaskPlanRuntime;
const taskPlanController = chatFeatureComposition.taskPlanController;
export const chatComposerInputRuntime = chatFeatureComposition.chatComposerInputRuntime;
export const chatAutomationRuntime = chatFeatureComposition.chatAutomationRuntime;
const chatAutomationControls = chatFeatureComposition.chatAutomationControls;
export const chatSessionRowRuntime = chatFeatureComposition.chatSessionRowRuntime;
const chatSessionRows = chatFeatureComposition.chatSessionRows;
export const chatSessionListRuntime = chatFeatureComposition.chatSessionListRuntime;
const chatSessionList = chatFeatureComposition.chatSessionList;
const { loadSessions, maybePageSessions, projectSortEntries, paintSessions } = chatFeatureComposition;
export const chatSettingsRuntime = chatFeatureComposition.chatSettingsRuntime;
const chatSettings = chatFeatureComposition.chatSettings;
export const chatProjectControlsRuntime = chatFeatureComposition.chatProjectControlsRuntime;

const chatInitializationExtras = {
  get chatEventRenderer() { return chatEventRenderer; },
  set chatEventRenderer(value) { chatEventRenderer = value; },
  get timelinePresentation() { return timelinePresentation; },
  set timelinePresentation(value) { timelinePresentation = value; },
  get chatNavigation() { return chatNavigation; },
  set chatNavigation(value) { chatNavigation = value; },
  get chatReaderState() { return chatReaderState; },
  set chatReaderState(value) { chatReaderState = value; },
  get chatSearchNavigation() { return chatSearchNavigation; },
  set chatSearchNavigation(value) { chatSearchNavigation = value; },
  get chatComposerAttachments() { return chatComposerAttachments; },
  set chatComposerAttachments(value) { chatComposerAttachments = value; },
  chatAutomationControls,
  chatComposerInputRuntime,
  chatProgress,
  chatSessionList,
  chatSettings,
  composerDraftOwner,
  composerSessionSelection,
  distanceFromTail,
  eventBody,
  fillTimelineHistory,
  forgetTimelineRows,
  groupImageRows,
  get handoff() { return handoff; },
  set handoff(value) { handoff = value; },
  get handoffFor() { return handoffFor; },
  set handoffFor(value) { handoffFor = value; },
  jumpToLatest,
  maybePageSessions,
  openTools,
  ownsComposerDraft,
  paintHandoff,
  paintJumpLatest,
  paintLoopDelivery,
  paintSessions,
  paintSwarm,
  projectSortEntries,
  readTimeline,
  refreshAll: () => chatVisibility.refreshAll(),
  refreshBackgroundProcesses,
  renderRounds,
  requestHistory,
  restoreDraft,
  retainedInputImages,
  rowEvents,
  scheduleReload,
  showView,
  tagImageRow,
};
export type ChatInitializationBindings = ChatRuntimeBindings & typeof chatInitializationExtras;
const chatInitializationBindings = Object.create(chatRuntimeBindings) as ChatInitializationBindings;
Object.defineProperties(chatInitializationBindings, Object.getOwnPropertyDescriptors(chatInitializationExtras));
