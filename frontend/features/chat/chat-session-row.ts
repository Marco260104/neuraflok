import {
  committedResumeAncestorsFromSummary,
  type AgentState,
  type SessionSummary,
  type SwarmState,
} from '../../../contracts/session.js';
import { providerForConversationId } from '../../../contracts/web-providers.js';
import { workerReportedFinish } from '../../../contracts/sessions/activity-state.js';
import type { AppState } from '../../../contracts/types.js';
import { $, ago, el, icon, run } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';
import type { RowMenuItem } from './row-menu.js';
import { createChatSessionRename } from './chat-session-rename.js';
import { createChatSessionTooltip } from './chat-session-tooltip.js';

export interface ChatSessionRowRuntime {
  selectedId: string | null;
  activeId: string | null;
  blockedChats: Set<string>;
  trustedChats: Set<string>;
  swarm: SwarmState | null;
  renaming: { id: string; original: string; value: string; start: number; end: number } | null;
  state: () => AppState | null;
  sessionWorking: (summary: SessionSummary) => boolean;
  suppressProjectPreparationActivity: (summary: SessionSummary) => boolean;
  isUnseen: (summary: SessionSummary) => boolean;
  pinnable: (summary: SessionSummary) => boolean;
  pinnedChat: (summary: SessionSummary) => boolean;
  sidebarPins: { toggle: (id: string) => void } | undefined;
  deleteSession: (id: string) => Promise<void>;
  loadSessions: (detail?: 'reread' | 'changed') => Promise<void>;
  paintSessions: () => void;
  openRowMenu: typeof import('./row-menu.js').openRowMenu;
  rowMenuButton: (owner: string) => HTMLElement | null;
  rowMenuOpenFor: typeof import('./row-menu.js').rowMenuOpenFor;
  toggleRowMenu: typeof import('./row-menu.js').toggleRowMenu;
  toggleSessionBlock: (id: string, blocked: boolean) => Promise<void>;
  toggleSessionTrust: (id: string, conversationId: string, trusted: boolean) => Promise<void>;
  toggleUnattributedBlock: (blocked: boolean) => Promise<void>;
}

type Runtime = ChatSessionRowRuntime;

export interface Badge {
  text: string;
  tone: '' | 'is-active' | 'is-finished' | 'is-failed' | 'is-unseen';
}

// Owns session row badges, menus, tool policy controls, and inline renaming.
export function createChatSessionRow(runtime: Runtime) {
  const api = window.api;
  const rename = createChatSessionRename(runtime);
  const tooltip = createChatSessionTooltip();

  // Live word per worker state, in the user's vocabulary rather than the protocol's.
  const AGENT_BADGE: Record<AgentState, Badge> = {
    invited: { text: 'opening', tone: 'is-active' },
    active: { text: 'active', tone: 'is-active' },
    // Still working, as far as this app knows — only its browser tab is gone. Said as "no tab" rather than "detached" because that is the part a user can act on.
    detached: { text: 'no tab', tone: 'is-active' },
    // Between jobs, not over. Its chat is intact and the prime can put it back to work in it, so the word has to read as a pause rather than as an ending — a user who reads "finished" here closes the tab, which is the one thing that costs nothing and helps nothing.
    sleeping: { text: 'sleeping', tone: '' },
    waking: { text: 'waking', tone: 'is-active' },
    finished: { text: 'finished', tone: 'is-finished' },
    failed: { text: 'failed', tone: 'is-failed' },
  };

  // What a row is, and what it is doing right now. Once resume and multi-agent mode are in use, most rows in the list are chats this app opened, and they are all recorded within a minute of each other. A name alone cannot separate them — which run a chat belonged to, whether its tab ever opened, whether the worker in it ever joined — and that is how a user loses track of a delayed tab. The first badge is durable and comes from the session itself; the second is live and comes from the swarm or the compaction currently reported by the app.

  // Sidebar rows are intentionally rebuilt when fresh activity arrives. Anchor the spinner to a wall-clock phase so a new tool repaint does not visually restart an already-running turn. Keep this period aligned with `.session-status.is-active` in styles.css.
  const SESSION_SPIN_MS = 900;
  function syncSessionSpinner(indicator: HTMLElement): void {
    indicator.style.animationDelay = `-${Date.now() % SESSION_SPIN_MS}ms`;
  }

  // Is the Unattributed stream blocked? There is no per-chat block to read: the whole point of this row is that the app cannot say which chat these calls came from, so the only switch that can answer for them is the app-wide one. Off is a block — a call the app cannot attribute is refused — which is why the row draws it with the same button and the same word as a blocked chat.
  function unattributedBlocked(): boolean {
    const multiAgent = runtime.state()?.config.multiAgent;
    return (
      multiAgent?.strictChatAllowlist === true ||
      multiAgent?.allowUnattributedCalls === false
    );
  }

  function sessionBadges(summary: SessionSummary): Badge[] {
    const badges: Badge[] = [];
    const origin = summary.origin;
    // The one session that is not a chat. Saying so on the row is what stops it reading as a chat that mysteriously lost its name.
    if (summary.conversationId === null) {
      return unattributedBlocked()
        ? [
            { text: 'blocked', tone: 'is-failed' },
            { text: 'not a chat', tone: '' },
          ]
        : [{ text: 'not a chat', tone: '' }];
    }
    // First, and in the failure tone: a blocked chat is the one state on this row that says the app is actively refusing work, and the user came to the list to find it at a glance.
    if (runtime.blockedChats.has(summary.conversationId))
      badges.push({ text: 'blocked', tone: 'is-failed' });
    if (origin?.kind === 'worker')
      badges.push({ text: origin.agentId ?? 'worker', tone: '' });
    else if (origin?.kind === 'resume')
      badges.push({ text: 'resumed', tone: '' });
    else if (summary.agents.includes('prime'))
      badges.push({ text: 'prime', tone: '' });

    // Agent ids are reused across runs (`worker-1`, `worker-2`, ...). Matching only by the short id made old worker sessions inherit a new run's live badge. The provider conversation id identifies the exact worker page.
    const agent = origin?.agentId
      ? runtime.swarm?.agents.find(
          (entry) =>
            entry.id === origin.agentId &&
            Boolean(entry.conversationId) &&
            entry.conversationId === summary.conversationId,
        )
      : runtime.swarm?.agents.find(
          (entry) =>
            entry.role === 'prime' &&
            entry.conversationId === summary.conversationId,
        );
    // Owning a run is not the same as running a turn. Exact chat activity wins; only an idle worker falls back to its broker lifecycle label. Exact recorded tool activity belongs to the session, not to the renderer's current swarm projection. A parked/restarted run can lose its AgentView while the chat still makes calls.
    const workerStopped =
      agent?.role === 'worker' &&
      ['sleeping', 'finished', 'failed'].includes(agent.state);
    if (workerStopped) badges.push(AGENT_BADGE[agent.state]);
    // The swarm no longer shows this worker — its run parked when it and its siblings stopped — but its own session records that its last call was the finish report. That is a worker between jobs, and "sleeping" is the word that says its chat can be woken.
    else if (!agent && workerReportedFinish(summary))
      badges.push(AGENT_BADGE.sleeping);
    else if (!runtime.suppressProjectPreparationActivity(summary) && runtime.sessionWorking(summary)) badges.push(AGENT_BADGE.active);
    else if (agent && agent.role !== 'prime')
      badges.push(AGENT_BADGE[agent.state]);
    if (!runtime.suppressProjectPreparationActivity(summary) && !runtime.sessionWorking(summary) && runtime.isUnseen(summary))
      badges.push({ text: 'New response', tone: 'is-unseen' });
    return badges;
  }

  function sessionRow(summary: SessionSummary): HTMLElement {
    const row = el('div', 'sess');
    row.dataset.id = summary.id;
    if (summary.id === runtime.selectedId) row.classList.add('is-sel');
    if (summary.id === runtime.activeId && summary.endedAt === null)
      row.classList.add('is-live');

    const top = el('div', 'sess-top');
    top.setAttribute('role', 'button');
    if (summary.id === runtime.selectedId)
      top.setAttribute('aria-current', 'true');
    top.tabIndex = 0;
    top.dataset.sessionSelect = '';
    top.dataset.sortHandle = '';
    if (runtime.renaming?.id === summary.id) top.append(rename.renameField(summary));
    else {
      const title = el('b', '', () => summary.title || t('Untitled session'));
      title.dir = 'auto';
      // Double-click names the chat, like the pencil does.
      if (summary.conversationId)
        title.addEventListener('dblclick', (event) => {
          event.stopPropagation();
          rename.startRename(summary);
        });
      top.append(title);
    }
    const badges = sessionBadges(summary);
    const pinned = runtime.pinnedChat(summary);
    if (pinned) {
      row.classList.add('is-pinned');
      const mark = icon('i-pinned', 'ico sess-pin-mark');
      top.append(mark);
    }
    ui(row, 'title', () =>
      [
        summary.title || t('Untitled session'),
        ...(pinned ? [t('Pinned')] : []),
        ...badges.map((badge) => t(badge.text)),
        ago(summary.updatedAt),
      ].join(' · '),
    );
    tooltip.bind(row, summary);
    // A pointer's click puts the tooltip away until the pointer leaves the row, through the repaint that follows. A keyboard's click puts nothing away: no pointer would leave to bring the tooltip back.
    // Unseen is presentation only and is appended last, so every existing lifecycle tone keeps its previous priority (blocked/active/worker finished/failed).
    const status = badges.find((badge) => badge.tone);
    if (status) {
      const indicator = el('span', `session-status ${status.tone}`);
      if (status.tone === 'is-active') syncSessionSpinner(indicator);
      ui(indicator, 'title', () => t(status.text));
      ui(indicator, 'aria-label', () => t(status.text));
      top.append(indicator);
    }
    // One button gathers the chat actions; a right click on the row opens the same menu.
    const owner = `chat:${summary.id}`;
    const items: RowMenuItem[] = [];
    const remove: RowMenuItem = {
      action: 'remove',
      icon: 'i-trash',
      danger: true,
      separated: true,
      label: () => t('Remove'),
      title: () =>
        t(
          'Remove this chat and its saved history from NEURAFLOK. The conversation stays in the provider account.',
        ),
      run: () => void runtime.deleteSession(summary.id),
    };
    if (summary.conversationId === null) {
      // Strict mode cannot trust an unattributed stream by definition. Do not offer an "Allow" that the kernel will intentionally ignore; the Settings checkbox explains that unattributed calls stay blocked until strict mode is turned off.
      if (runtime.state()?.config.multiAgent?.strictChatAllowlist !== true) {
        // The same decision as a chat's Block: may this activity use local tools? It has no conversation to be stored against, so it moves the app-wide switch and nothing else.
        const blocked = unattributedBlocked();
        items.push({
          action: 'block',
          icon: blocked ? 'i-play' : 'i-ban',
          label: () =>
            blocked
              ? t('Allow unattributed calls')
              : t('Block unattributed calls'),
          title: () =>
            blocked
              ? t(
                  'Allow unattributed calls: self-contained calls run again even when the app cannot prove which chat sent them',
                )
              : t(
                  'Block unattributed calls: every call the app cannot attribute to a chat is refused and the chat is told to stop',
                ),
          run: () => void runtime.toggleUnattributedBlock(!blocked),
        });
      }
    } else {
      const policyLineage = [
        summary.conversationId,
        ...committedResumeAncestorsFromSummary(summary, summary.conversationId),
      ];
      const strictAllowlist =
        runtime.state()?.config.multiAgent?.strictChatAllowlist === true;
      // Mirror main's exact decision order for presentation: exact Block wins; in strict mode an exact Trust wins before inherited lineage, then each committed predecessor is considered nearest-first with Block ahead of Trust. An older policy hidden behind a nearer decision is not the current effective state and must not paint this row inconsistently with the kernel.
      let effectivePolicy: 'blocked' | 'trusted' | null =
        runtime.blockedChats.has(summary.conversationId)
          ? 'blocked'
          : strictAllowlist && runtime.trustedChats.has(summary.conversationId)
            ? 'trusted'
            : null;
      if (strictAllowlist && effectivePolicy === null) {
        for (const conversationId of policyLineage.slice(1)) {
          if (runtime.blockedChats.has(conversationId)) {
            effectivePolicy = 'blocked';
            break;
          }
          if (runtime.trustedChats.has(conversationId)) {
            effectivePolicy = 'trusted';
            break;
          }
        }
      }
      items.push({
        action: 'rename',
        icon: 'i-pencil',
        label: () => t('Rename'),
        title: () => t('Rename this session in NEURAFLOK.'),
        run: () => rename.startRename(summary),
      });
      const provider = providerForConversationId(summary.conversationId);
      if (provider)
        items.push({
          action: 'open',
          icon: 'i-out',
          label: () => t('Open this chat'),
          title: () => t('Open this chat in its provider'),
          // Open the provider page linked to this saved session. A generic provider home page loses the conversation history needed to diagnose and continue a chat.
          run: () => void run(api.openSessionChat(summary.id)),
        });
      // Blocking removes this chat's local tool access; the provider controls model generation. A resumed row can release a policy inherited from its committed predecessors.
      const blocked = effectivePolicy === 'blocked';
      items.push({
        action: 'block',
        icon: blocked ? 'i-play' : 'i-ban',
        separated: true,
        label: () => (blocked ? t('Release chat') : t('Block chat')),
        title: () =>
          blocked
            ? t('Release this chat: its tool calls run again')
            : t(
                'Block this chat: every tool call it makes is refused and it is told to stop',
              ),
        run: () => void runtime.toggleSessionBlock(summary.id, !blocked),
      });
      if (strictAllowlist && summary.origin?.kind !== 'worker') {
        // `trustedChats` is the explicit durable registry. A committed resumed chat can be effectively trusted by one of those historical ids, so project the same durable lineage that main enforces. This only chooses the item; IPC remains authoritative.
        const trusted = effectivePolicy === 'trusted';
        items.push({
          action: 'trust',
          icon: trusted ? 'i-lock' : 'i-check',
          label: () => (trusted ? t('Untrust chat') : t('Trust chat')),
          title: () =>
            trusted
              ? t('Untrust this chat: strict mode refuses its tool calls')
              : t('Trust this chat: strict mode lets its tool calls run'),
          run: () =>
            void runtime.toggleSessionTrust(
              summary.id,
              summary.conversationId!,
              !trusted,
            ),
        });
      }
      if (runtime.pinnable(summary)) {
        // Keep pinned chats above unpinned chats in their list.
        items.unshift({
          action: 'pin',
          icon: pinned ? 'i-pinned' : 'i-pin',
          label: () => (pinned ? t('Unpin chat') : t('Pin chat')),
          title: () =>
            pinned
              ? t('Unpin this chat')
              : t('Pin this chat to the top of its list'),
          run: () => {
            runtime.sidebarPins?.toggle(summary.id);
            runtime.paintSessions();
            // The row moved: keep the keyboard on the same chat's menu button. Its button shows only while the row has focus, so the row takes focus first.
            const rebuilt = $('sessionList').querySelector<HTMLElement>(
              `.sess[data-id="${CSS.escape(summary.id)}"]`,
            );
            rebuilt
              ?.querySelector<HTMLElement>('.sess-top')
              ?.focus({ preventScroll: true });
            runtime.rowMenuButton(owner)?.focus({ preventScroll: true });
          },
        });
      }
    }
    items.push(remove);
    const more = el(
      'button',
      'btn row-menu-button sess-menu',
    ) as HTMLButtonElement;
    more.type = 'button';
    more.dataset.rowMenu = owner;
    more.append(icon('i-more-vertical'));
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', String(runtime.rowMenuOpenFor(owner)));
    ui(more, 'title', () => t('More options'));
    ui(more, 'aria-label', () => t('More options'));
    const menu = (at?: { x: number; y: number }) => ({
      owner,
      at,
      label: () => summary.title || t('Untitled session'),
      anchor: () => runtime.rowMenuButton(owner),
      items: () => items,
    });
    more.addEventListener('click', (event) => {
      event.stopPropagation();
      document.getElementById('sessionTooltip')?.remove();
      runtime.toggleRowMenu(menu());
    });
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      document.getElementById('sessionTooltip')?.remove();
      runtime.openRowMenu(menu({ x: event.clientX, y: event.clientY }));
    });
    const actionBar = el('div', 'sess-actions');
    actionBar.append(more);
    row.append(top, actionBar);
    return row;
  }

  // The Unattributed row delegates policy changes to the app setting owner.

  return { sessionBadges, placeSessionTooltip: tooltip.placeSessionTooltip, sessionRow };
}
