import { pageToolKey, type LiveConversation, type ProgressRecord } from './recorder-observations.js';
import type { SessionOrigin } from '../../../../contracts/session.js';
import { originTitle } from '../../../../contracts/session.js';
import { logInfo, logWarn } from '../../../infrastructure/settings/logger.js';
import { appendEvent, createSession, conversationWasSuperseded, findSessionByConversation, getSession, readRecentEvents, reopenSession, renameSession, setSessionOrigin } from './store.js';
import { REPLACEMENT_CHAT_CLAIM_WINDOW_MS, hasPendingReplacementChat } from '../continuity/replacement-chat-gate.js';

interface Runtime {
  conversations: Map<string, LiveConversation>;
  recordingEnabled: () => boolean;
  notifyChanged: (...sessionIds: string[]) => void;
}

export function createRecorderSessionLifecycle(runtime: Runtime) {
  const { conversations, recordingEnabled, notifyChanged } = runtime;
  const sessionInitializations = new Map<string, Promise<string | null>>();
  const pendingOrigins = new Map<string, SessionOrigin>();
  const MAX_PENDING_ORIGINS = 50;
  let unattributedSessionId: string | null = null;
  let unattributedInitialization: Promise<string | null> | null = null;
  let lastActiveSessionId: string | null = null;
  const REOPEN_NOTICE_MS = 60_000;

  // The session a conversation writes to, created on first sight. First sight can race: two extension batches, or an extension batch and another recorder path, may reach a conversation before either has installed its live map entry. Sharing the whole initialization promise prevents both callers from independently passing the disk lookup and creating two durable sessions for the same chat.
  async function sessionForConversation(
    conversationId: string | null,
    title?: string
  ): Promise<string | null> {
    if (!conversationId) return initializeSessionForConversation(conversationId, title);

    const pending = sessionInitializations.get(conversationId);
    if (pending) {
      const sessionId = await pending;
      if (sessionId) {
        // A caller that arrived while initialization was in flight may carry evidence the first caller did not yet have: command origin or the first authored user title. Apply both after the shared initialization rather than dropping the later evidence.
        if (pendingOrigins.has(conversationId)) await applyOrigin(sessionId, conversationId);
        await promoteGenericTitle(sessionId, title);
      }
      return sessionId;
    }

    const initializing = initializeSessionForConversation(conversationId, title);
    sessionInitializations.set(conversationId, initializing);
    try {
      const sessionId = await initializing;
      // noteChatOrigin() can race the find/create window too. Its pending entry is authoritative and must be stamped before this first caller returns even if it arrived after the initializer sampled pendingOrigins.
      if (sessionId) {
        if (pendingOrigins.has(conversationId)) await applyOrigin(sessionId, conversationId);
        await promoteGenericTitle(sessionId, title);
      }
      return sessionId;
    } finally {
      if (sessionInitializations.get(conversationId) === initializing) {
        sessionInitializations.delete(conversationId);
      }
    }
  }

  // Reattaches a recorded provider conversation after process-memory loss without creating an unproven session.
  async function restoreRecordedConversation(conversationId: string, pageObservedAt = Date.now()): Promise<string | null> {
    if (!recordingEnabled() || !conversationId) return null;
    const existing = conversations.get(conversationId);
    const known = existing ? await getSession(existing.sessionId) : await findSessionByConversation(conversationId);
    if (!known) return null;
    if (known.browserRecoveryDismissedAt !== undefined) {
      // A poll accepted before Close cannot undo a newer user decision after an await.
      if (pageObservedAt <= known.browserRecoveryDismissedAt) return null;
      await reopenSession(known.id, pageObservedAt);
    }
    if (existing) return existing.sessionId;
    return sessionForConversation(conversationId);
  }

  // Honor the continuation's existing claim window before creating an unknown conversation. An independent shorter deadline can mint a shadow session while the destination still legitimately awaits its commit. Cap each wait at one claim window so overlapping claims cannot indefinitely prevent an unrelated new chat from being recorded.
  async function settleResumeCommit(): Promise<void> {
    const deadline = Date.now() + REPLACEMENT_CHAT_CLAIM_WINDOW_MS;
    while (hasPendingReplacementChat() && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        timer.unref?.();
      });
    }
  }

  async function initializeSessionForConversation(
    conversationId: string | null,
    title?: string
  ): Promise<string | null> {
    if (!recordingEnabled()) return null;
    if (!conversationId) return ensureUnattributedSession();
    const existing = conversations.get(conversationId);
    if (existing) {
      lastActiveSessionId = existing.sessionId;
      if (pendingOrigins.has(conversationId)) await applyOrigin(existing.sessionId, conversationId);
      await promoteGenericTitle(existing.sessionId, title);
      return existing.sessionId;
    }
    // Reuse a session already recorded for this conversation, so closing and reopening the tab continues the same history instead of fragmenting it.
    let known = await findSessionByConversation(conversationId);
    if (!known && hasPendingReplacementChat()) {
      // A compaction is opening its replacement chat right now, and this unknown conversation may be it. Creating a session here is what breaks the move: the commit that follows finds its own destination owned by a session it has never heard of and refuses to rebind. Wait within the claim's existing bound, then resolve this conversation to the session that was moved onto it so the batch is recorded in the right place. See replacement-chat-gate.ts for what this cost the session it was written for.
      await settleResumeCommit();
      const moved = conversations.get(conversationId);
      if (moved) {
        lastActiveSessionId = moved.sessionId;
        return moved.sessionId;
      }
      known = await findSessionByConversation(conversationId);
    }
    if (!known && (await conversationWasSuperseded(conversationId))) {
      // Compact & Resume moved this chat's session onto its replacement. Whatever the old page still reports — the brief re-rendered with its HTML, a lingering turn, the user typing into it — is history of that one session, never a chat of its own: on 2026-09-02 the brief's late re-render minted a second session holding nothing but the summary. recordChatObservationsNow() files such messages into the lineage; nothing else may mint a session for a conversation this app has already replaced.
      logInfo(`conversation ${conversationId} was replaced by Compact & Resume; its late observation gets no session of its own`);
      return null;
    }
    // A chat this app opened is named for the command that opened it. The alternative — the first thing said in the chat — is this app's own bootstrap prompt.
    const origin = pendingOrigins.get(conversationId) ?? null;
    const summary =
      known ??
      (await createSession({
        conversationId,
        title: origin && origin.kind !== 'desktop' ? await titleForOrigin(origin) : title,
        origin,
        titleSource: 'fallback'
      }));
    if (origin && !known) pendingOrigins.delete(conversationId);
    // Reopening a chat that was closed earlier makes its session live again. Appending to a session still stamped with an end time left the UI showing a finished session that was visibly still growing.
    if (known && known.endedAt !== null) {
      const closedFor = Date.now() - known.endedAt;
      await reopenSession(known.id).catch(() => undefined);
      // Only worth saying when the session was actually away. A reload, a bfcache round-trip or a brief disconnect closes and reopens within seconds and changes nothing the user could act on; announcing each one filled the Activity log with ten identical lines in seventy seconds across five tabs.
      if (closedFor >= REOPEN_NOTICE_MS) {
        logInfo(`session ${known.id} reopened — its provider conversation is active again`);
      }
    }
    const history = known
      ? await storedHistory(summary.id)
      : {
          openTurns: new Set<string>(),
          knownTurnStarts: new Set<string>(),
          knownTurnEnds: new Set<string>(),
          lastTurnStartedAt: null,
          activeTurnId: null,
          activeTurnStartedAt: null,
          pageTools: new Map<string, ProgressRecord>()
        };

    // `storedHistory()` can take long enough for Compact & Resume to durably move this exact session from chat A to chat B while first-sight initialisation of A is still in flight. The lookup at the top of this function is therefore no longer authority after that await. Re-check the session itself immediately before publishing the live map and returning its id. If durable metadata no longer names A, this stale initializer must publish nothing and return nothing; a later observation from A can then take the normal "new session" path rather than resurrecting the moved session behind B's back.
    if (known) {
      const current = await getSession(summary.id);
      if (!current || current.conversationId !== conversationId) {
        logInfo(
          `session ${summary.id} moved away from conversation ${conversationId} while that conversation was being restored; discarded stale live initialization`
        );
        return null;
      }
    }
    conversations.set(conversationId, {
      conversationId,
      sessionId: summary.id,
      // A running turn survives an app/content-script restart. The durable log is the only component that can still know the old document's generation id, so restore it here and let /activity hand it back to the replacement content script.
      turnStartedAt: history.activeTurnStartedAt,
      turnId: history.activeTurnId,
      openTurns: history.openTurns,
      knownTurnStarts: history.knownTurnStarts,
      knownTurnEnds: history.knownTurnEnds,
      lastTurnOutcome: summary.lastTurnOutcome,
      lastTurnStartedAt: history.lastTurnStartedAt,
      turnRequestIds: new Set<string>(),
      endedTurn: null,
      pageTools: history.pageTools
    });
    if (!known) {
      await appendEvent(summary.id, {
        time: Date.now(),
        source: 'extension',
        kind: 'session_start',
        conversationId,
        title: summary.title
      });
      logInfo(`session started for a provider conversation (${summary.id})`);
    }
    if (origin && known) await applyOrigin(summary.id, conversationId);
    if (known) await promoteGenericTitle(summary.id, title);
    if (known) {
      // There are two awaited metadata niceties above. A rebind that starts after the pre-publish check can therefore still commit before this initializer returns. Re-check once more and retract only our own stale A→S publication if durable ownership moved in that window. No await follows this check before return, so a caller can never receive S from an initializer that has already observed S belonging to B.
      const current = await getSession(summary.id);
      if (!current || current.conversationId !== conversationId) {
        const published = conversations.get(conversationId);
        if (published?.sessionId === summary.id) conversations.delete(conversationId);
        logInfo(
          `session ${summary.id} moved away from conversation ${conversationId} before restore completed; retracted stale live initialization`
        );
        return null;
      }
    }
    lastActiveSessionId = summary.id;
    notifyChanged(summary.id);
    return summary.id;
  }

  /** Generic placeholders yield to authored previews; store owns naming precedence. */
  async function promoteGenericTitle(sessionId: string, title?: string): Promise<void> {
    const next = title?.trim();
    if (!next) return;
    const summary = await getSession(sessionId);
    if (!summary || !['ChatGPT session', 'New chat'].includes(summary.title)) return;
    await renameSession(sessionId, next, 'fallback');
    notifyChanged(sessionId);
  }

  /** Provider titles may arrive before message history, after a receipt, or after restart. */
  async function promoteConversationTitle(sessionId: string, title?: string, conversationId?: string): Promise<void> {
    const next = title?.trim();
    if (!next) return;
    await renameSession(sessionId, next, 'provider', conversationId);
    notifyChanged(sessionId);
  }

  // Records that this app opened a chat, so the session can be named for the work rather than for the bootstrap prompt. Called from the bridge the moment the extension acknowledges having typed a command into a fresh tab — the only point at which the queued command and the conversation it became are both known.
  async function noteChatOrigin(conversationId: string, origin: SessionOrigin): Promise<void> {
    if (!conversationId) return;
    pendingOrigins.set(conversationId, origin);
    while (pendingOrigins.size > MAX_PENDING_ORIGINS) {
      const oldest = pendingOrigins.keys().next();
      if (oldest.done) break;
      pendingOrigins.delete(oldest.value);
    }
    if (!recordingEnabled()) return;
    const live = conversations.get(conversationId);
    const sessionId =
      live?.sessionId ??
      (await findSessionByConversation(conversationId))?.id ??
      null;
    // No session yet is the common case: the ack beats the page's first observation. sessionForConversation picks the origin up out of pendingOrigins when it creates one.
    if (sessionId) await applyOrigin(sessionId, conversationId);
  }

  /** The name for a chat this app opened, taking a resume's name from its source. */
  async function titleForOrigin(origin: SessionOrigin): Promise<string> {
    const source = origin.fromSessionId ? await getSession(origin.fromSessionId) : null;
    return originTitle(origin, source?.title ?? null);
  }

  /** Stamps a pending origin onto an existing session, once. */
  async function applyOrigin(sessionId: string, conversationId: string): Promise<void> {
    const origin = pendingOrigins.get(conversationId);
    if (!origin) return;
    pendingOrigins.delete(conversationId);
    const summary = await getSession(sessionId);
    // Already stamped: a worker's bootstrap can be acknowledged more than once, and a second stamp would rename a session that has since become the user's to name.
    if (!summary) return;
    if (summary.origin) {
      // Older workers omitted their prime link. Repair only that missing relation from exact broker ownership; keep the user's title and original task unchanged.
      if (summary.origin.kind === 'worker' && origin.kind === 'worker' &&
          summary.origin.agentId === origin.agentId && !summary.origin.fromSessionId && origin.fromSessionId) {
        await setSessionOrigin(sessionId, { ...summary.origin, fromSessionId: origin.fromSessionId }, summary.title);
        notifyChanged(sessionId);
      }
      return;
    }
    await setSessionOrigin(sessionId, origin, origin.kind === 'desktop' ? summary.title : await titleForOrigin(origin)).catch((err: Error) =>
      logWarn(`could not name the ${origin.kind} session: ${err.message}`)
    );
    logInfo(`session ${sessionId} named for the ${origin.kind} chat this app opened`);
    notifyChanged(sessionId);
  }

  /** What a session's own log already says, for a conversation being picked up again. */
  interface StoredHistory {
    /** Turns this log started and never ended — the only ones a recovery may close. */
    openTurns: Set<string>;
    /** Every durable turn start, including starts whose turn has already ended. */
    knownTurnStarts: Set<string>;
    /** Durable turn ends not superseded by an app-authored reopen. */
    knownTurnEnds: Set<string>;
    /** Durable start time of the newest turn that ended in the recovered tail. */
    lastTurnStartedAt: number | null;
    /** Current generation from lifecycle replay; older unended turns are history, not active work. */
    activeTurnId: string | null;
    /** Durable start time of activeTurnId. */
    activeTurnStartedAt: number | null;
    /** Latest stable provider-native activity row by website thought/message identity. */
    pageTools: Map<string, ProgressRecord>;
  }

  // Reads what a session already contains. Read once when a conversation is picked up again, so both de-duplication and turn recovery survive an app restart rather than only a page that was never reloaded. The open-turn ledger is what stops a reload from resurrecting a finished turn. A cold page reports a final assistant message carrying whatever turn id the page has, and those ids are reused; without knowing which turns this log actually left open, the recovery path appended a second completion for a turn that had ended many turns ago.
  async function storedHistory(sessionId: string): Promise<StoredHistory> {
    const openTurns = new Set<string>();
    const knownTurnStarts = new Set<string>();
    const knownTurnEnds = new Set<string>();
    let lastTurnEndedAt: number | null = null;
    let lastTurnStartedAt: number | null = null;
    let activeTurnId: string | null = null;
    let activeTurnStartedAt: number | null = null;
    const turnStarts = new Map<string, number>();
    const pageTools = new Map<string, ProgressRecord>();
    try {
      const events = await readRecentEvents(sessionId, 4096, {
        kinds: ['turn_start', 'turn_end', 'page_tool'],
        maxBytes: 2 * 1024 * 1024
      });
      // Presentation groups a turn's starts before its end. Lifecycle replay must instead retain an app-authored reopen that was committed after that end.
      for (const event of events.sort((a, b) => a.seq - b.seq)) {
        if (event.kind === 'turn_start') {
          if (event.turnId) {
            knownTurnStarts.add(event.turnId);
            knownTurnEnds.delete(event.turnId);
            openTurns.add(event.turnId);
            turnStarts.set(event.turnId, event.time);
            // Match live recording: each committed start replaces the current generation. An older turn missing its end remains forensic history; it must not become active again after a later turn completes and the user closes/revisits the chat.
            activeTurnId = event.turnId;
            activeTurnStartedAt = event.time;
          }
        } else if (event.kind === 'turn_end') {
          if (event.turnId) {
            knownTurnEnds.add(event.turnId);
            openTurns.delete(event.turnId);
            if (activeTurnId === event.turnId) {
              activeTurnId = null;
              activeTurnStartedAt = null;
            }
          }
          if (lastTurnEndedAt === null || event.time >= lastTurnEndedAt) {
            lastTurnEndedAt = event.time;
            lastTurnStartedAt = event.turnId ? turnStarts.get(event.turnId) ?? null : null;
          }
        } else if (event.kind === 'page_tool' && event.messageId) {
          const held = pageTools.get(pageToolKey(event.messageId));
          if (!held) {
            pageTools.set(pageToolKey(event.messageId), {
              seq: event.origin ?? event.seq,
              time: event.time,
              updatedAt: event.time,
              text: event.label,
              contentSeq: event.contentSeq,
              ...(event.turnId ? { turnId: event.turnId } : {})
            });
          } else {
            held.updatedAt = Math.max(held.updatedAt, event.time);
            held.text = event.label;
            if (!held.turnId && event.turnId) held.turnId = event.turnId;
          }
        }
      }
    } catch (err) {
      logWarn(`could not read stored session history: ${(err as Error).message}`);
    }
    return { openTurns, knownTurnStarts, knownTurnEnds, lastTurnStartedAt, activeTurnId, activeTurnStartedAt, pageTools };
  }

  async function ensureUnattributedSession(): Promise<string | null> {
    if (!recordingEnabled()) return null;
    if (unattributedSessionId) return unattributedSessionId;
    if (unattributedInitialization) return unattributedInitialization;
    const initializing = (async () => {
      const summary = await createSession({ title: 'Unattributed activity' });
      await appendEvent(summary.id, {
        time: Date.now(), source: 'app', kind: 'session_start', conversationId: null, title: summary.title
      });
      unattributedSessionId = summary.id;
      lastActiveSessionId = summary.id;
      notifyChanged(summary.id);
      return summary.id;
    })();
    unattributedInitialization = initializing;
    try {
      return await initializing;
    } finally {
      if (unattributedInitialization === initializing) unattributedInitialization = null;
    }
  }

  function reset(): void {
    sessionInitializations.clear();
    pendingOrigins.clear();
    unattributedSessionId = null;
    unattributedInitialization = null;
    lastActiveSessionId = null;
  }

  return {
    sessionForConversation,
    restoreRecordedConversation,
    noteChatOrigin,
    ensureUnattributedSession,
    promoteConversationTitle,
    activeSessionId: () => lastActiveSessionId,
    setActiveSessionId: (sessionId: string | null) => { lastActiveSessionId = sessionId; },
    unattributedSessionId: () => unattributedSessionId,
    setUnattributedSessionId: (sessionId: string | null) => { unattributedSessionId = sessionId; },
    reset
  };
}
