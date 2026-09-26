import type { SessionEvent } from '../../../contracts/session.js';
import type { CommandSpec } from './command-broker/model.js';
import type { BridgeSessionControlsRuntime } from './bridge-session-controls-runtime.js';
import type { SessionControlsView } from './bridge-session-controls.js';

type Runtime = Pick<BridgeSessionControlsRuntime,
  | 'STOP_COMMAND_TIMEOUT_MS'
  | 'armDeadline'
  | 'cancelResumeNow'
  | 'chatUrl'
  | 'commandWrites'
  | 'getBridgeLifecycleEpoch'
  | 'getCommands'
  | 'getConfig'
  | 'getRepairsInFlight'
  | 'getSession'
  | 'isBridgeShutdownRequested'
  | 'liveConversations'
  | 'logInfo'
  | 'persistCommandLease'
  | 'providerForConversationId'
  | 'queue'
  | 'readRecentEvents'
  | 'releaseSessionFinish'
  | 'retire'
  | 'revokeSilenceInputs'
  | 'wakeBrowserUrl'
  | 'wakeBrowserWork'
  | 'changed'
  | 'continuationForSession'
  | 'conversationWasSuperseded'
  | 'endActivity'
  | 'isApiConversationId'>;

type Controls = {
  controlledConversation(sessionId: string): Promise<string>;
  sessionControlsFor(sessionId: string): Promise<SessionControlsView>;
  setSessionAutomation(sessionId: string, automation: SessionControlsView['automation']): Promise<SessionControlsView>;
};

// Owns durable Stop requests against one exact active session turn.
export function createBridgeStopControls(runtime: Runtime, controls: Controls) {
  const {
    STOP_COMMAND_TIMEOUT_MS,
    armDeadline,
    cancelResumeNow,
    chatUrl,
    commandWrites,
    getBridgeLifecycleEpoch,
    getCommands,
    getConfig,
    getRepairsInFlight,
    getSession,
    isBridgeShutdownRequested,
    liveConversations,
    logInfo,
    persistCommandLease,
    providerForConversationId,
    queue,
    readRecentEvents,
    releaseSessionFinish,
    retire,
    revokeSilenceInputs,
    wakeBrowserUrl,
    wakeBrowserWork,
    changed,
    continuationForSession,
    conversationWasSuperseded,
    endActivity,
    isApiConversationId
  } = runtime;
  const { controlledConversation, sessionControlsFor, setSessionAutomation } = controls;

  async function stopUserAnchor(sessionId: string, turnId: string): Promise<string | undefined> {
    const rows = await readRecentEvents(sessionId, 64, { kinds: ['user_message', 'turn_start', 'turn_end'] });
    const order = (event: SessionEvent) => ('origin' in event ? event.origin : undefined) ?? event.seq;
    const chronological = [...rows].sort((a, b) => order(a) - order(b));
    let user: string | undefined;
    for (const event of chronological) {
      if (event.kind === 'user_message') user = event.source === 'extension' ? event.messageId : undefined;
      else if (event.kind === 'turn_start' && event.turnId === turnId) return user;
      else user = undefined;
    }
    return undefined;
  }

  // Stop is a request against one exact live turn, never a predicted final boundary.
  async function stopSessionTurn(sessionId: string, expectedTurnId: string): Promise<SessionControlsView> {
    const id = await controlledConversation(sessionId);
    const assertCurrent = async () => {
      const latest = await getSession(sessionId);
      if (latest?.conversationId !== id || latest.activeTurnId !== expectedTurnId || !expectedTurnId ||
          await conversationWasSuperseded(id) || (await sessionControlsFor(sessionId)).activeTurnId !== expectedTurnId) throw new Error('active_turn_changed');
    };
    await assertCurrent();
    await setSessionAutomation(sessionId, 'off');
    await assertCurrent();
    if (isApiConversationId(id)) {
      const { abortApiChatSession } = await import('../providers/api-chat.js');
      abortApiChatSession(sessionId, expectedTurnId);
      await assertCurrent().catch(() => undefined);
      await releaseSessionFinish(sessionId, expectedTurnId, 'stop').catch(() => undefined);
      await revokeSilenceInputs(sessionId);
      endActivity(id);
      changed();
      return sessionControlsFor(sessionId);
    }
    if (providerForConversationId(id)) {
      const { abortWebProviderSession } = await import('../providers/browser-chat.js');
      abortWebProviderSession(sessionId, expectedTurnId);
      await assertCurrent().catch(() => undefined);
      await releaseSessionFinish(sessionId, expectedTurnId, 'stop').catch(() => undefined);
      await revokeSilenceInputs(sessionId);
      endActivity(id);
      changed();
      return sessionControlsFor(sessionId);
    }
    if (continuationForSession(sessionId)) { await cancelResumeNow(sessionId); await assertCurrent(); }
    const userMessageId = await stopUserAnchor(sessionId, expectedTurnId);
    await assertCurrent();
    const alreadyQueued = getCommands().some(entry => entry.spec.type === 'stop' && entry.spec.sessionId === sessionId && entry.spec.turnId === expectedTurnId);
    const command = queue({ type: 'stop', sessionId, conversationId: id, turnId: expectedTurnId, ...(userMessageId ? { userMessageId } : {}) });
    try {
      // Reuse the command lease barrier: status must not hand out an unsaved request.
      const pendingLease = commandWrites.get(command.id);
      if (pendingLease && !await pendingLease) throw new Error('stop_request_not_durable');
      if (!getCommands().includes(command) || (command.claimedAt === null && !await persistCommandLease(command, null, Date.now())))
        throw new Error('stop_request_not_durable');
      await assertCurrent();
      await releaseSessionFinish(sessionId, expectedTurnId, 'stop');
      await assertCurrent();
    } catch (error) { retire(command, 'stop request could not be saved or its turn changed'); throw error; }
    armDeadline(command);
    await revokeSilenceInputs(sessionId);
    endActivity(id);
    getRepairsInFlight().delete(id);
    if (!alreadyQueued) logInfo(`bridge: desktop Stop requested for session ${sessionId}, conversation ${id}, turn ${expectedTurnId}, command ${command.id}; native cancellation is unconfirmed`);
    wakeBrowserWork();
    changed();
    if (!alreadyQueued) {
      const lifecycle = getBridgeLifecycleEpoch();
      // The shared startup owner launches only on positive process absence. An existing browser remains the extension election's responsibility.
      await wakeBrowserUrl(chatUrl(id), false, getConfig().ui.backgroundChats === true, {
        current: () => getBridgeLifecycleEpoch() === lifecycle && !isBridgeShutdownRequested() && getCommands().includes(command) &&
          Date.now() < command.createdAt + STOP_COMMAND_TIMEOUT_MS &&
          liveConversations().some(row => row.sessionId === sessionId && row.conversationId === id && row.activeTurnId === expectedTurnId)
      });
    }
    return sessionControlsFor(sessionId);
  }

  async function stopCommandCurrent(spec: Extract<CommandSpec, { type: 'stop' }>): Promise<boolean> {
    const session = await getSession(spec.sessionId);
    return Boolean(session?.conversationId === spec.conversationId && session.activeTurnId === spec.turnId &&
      !await conversationWasSuperseded(spec.conversationId));
  }

  function stopRequestedFor(conversationId: string, turnId = liveConversations().find(row => row.conversationId === conversationId)?.activeTurnId): boolean {
    return getCommands().some(command => command.spec.type === 'stop' && command.spec.conversationId === conversationId &&
      (!turnId || command.spec.turnId === turnId) && Date.now() - command.createdAt < STOP_COMMAND_TIMEOUT_MS);
  }

  async function pendingStopCommands(): Promise<Array<{ id: string; conversationId: string; turnId: string; expiresAt: number }>> {
    const pending = [];
    for (const command of [...getCommands()]) {
      if (command.spec.type !== 'stop' || commandWrites.has(command.id)) continue;
      if (Date.now() - command.createdAt >= STOP_COMMAND_TIMEOUT_MS || !await stopCommandCurrent(command.spec)) {
        retire(command, 'the requested turn is no longer stoppable'); continue;
      }
      if (getCommands().includes(command)) pending.push({ id: command.id, conversationId: command.spec.conversationId, turnId: command.spec.turnId, expiresAt: command.createdAt + STOP_COMMAND_TIMEOUT_MS });
    }
    return pending;
  }

  return { pendingStopCommands, stopCommandCurrent, stopRequestedFor, stopSessionTurn };
}
