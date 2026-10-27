// Browser provider chat executor with local tool dispatch and durable thread history.
import { randomUUID } from 'node:crypto';
import {
  webChatRoundReminder,
  WEB_CHAT_READ_ONLY_TOOLS,
  formatWebChatResult,
  incompleteWebChatTool,
  incompleteToolNotice,
  incompletePlanToolNotice,
  parseWebChatTools,
  stripWebChatTools,
  webPlainChatInstructions,
  webProjectPlanToolGuide,
  webToolGuide,
  type WebChatMessage,
  type WebChatThread
} from '../../../contracts/chat-protocol.js';
import { WEB_PROVIDERS, providerForConversationId, webProviderConversationId, type WebProviderId } from '../../../contracts/web-providers.js';
import {
  configureProviderPageForTests,
  onProviderPageProgress,
  requestProviderPageComplete,
  resetProviderPageForTests
} from './provider-page.js';
import { logInfo, logWarn } from '../../infrastructure/settings/logger.js';
import { getConfig } from '../../infrastructure/settings/config.js';
import { recoveryMessage } from '../../../contracts/recovery.js';
import {
  persistWebProviderThread,
  replayWebProviderTranscript,
  readWebProviderThread,
  trimWebProviderThread,
  withWebProviderSystem
} from './browser-chat-thread.js';
import {
  confirmsWebProviderContext,
  prepareLocalProviderPrompt,
  prepareWebProviderBootstrap,
  prepareWebProviderContextCheck,
  LEGACY_WEB_BOOTSTRAP_ACK,
  WEB_BOOTSTRAP_ACK
} from '../sessions/input/provider-context.js';
import { recordChatObservations } from '../sessions/history/recorder.js';
import {
  acceptLocalExecutorInput,
  listInputs,
  type InputEntry
} from '../sessions/input/input.js';
import { recordDeliveredInput } from '../sessions/input/input-history.js';
import { noteLocalAgentTurnStarted } from '../automation/local-agent-observations.js';
import {
  clearProjectPlanState,
  getSession,
  readProjectPlanState,
  updateProjectPlanState
} from '../sessions/history/store.js';
import { readSessionEvents } from '../sessions/history/read-model.js';
import { summarizeProviderConversation, summarizeSessionHistory, sessionHistoryMessages, textOnlyWebMessages } from './conversation-summary.js';
import { projectPlanAction, projectPlanContext } from './project-plan-flow.js';
import {
  advertisedBrowserChatTools,
  createBrowserChatToolRegistrar,
  getBrowserChatGuideContext,
  invokeBrowserChatTool
} from './browser-chat-tools.js';

const MAX_TOOL_ROUNDS = 64;
const MAX_INCOMPLETE_TOOL = 3;
const MAX_DEEPSEEK_IDLE_RECOVERIES = 2;
const MAX_TOOL_RESULT_CONTEXT_CHARS = 64_000;
const MAX_ACTIVE_REQUEST_CHARS = 4_000;
const MAX_PROVIDER_PAGE_CHARS = 96_000;
const DEFAULT_WEB_CHAT_READINESS_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_WEB_CHAT_READINESS_MAX_DURATION_MS = 5 * 60_000;
let webChatReadinessTimeoutMs = DEFAULT_WEB_CHAT_READINESS_TIMEOUT_MS;
let webChatReadinessMaxDurationMs = DEFAULT_WEB_CHAT_READINESS_MAX_DURATION_MS;
const DEEPSEEK_CONTEXT_UNAVAILABLE = 'DEEPSEEK_CONTEXT_UNAVAILABLE:';
const VERIFIED_DEEPSEEK_CONTEXT_TTL_MS = 2 * 60_000;
const verifiedDeepseekContexts = new Map<string, { conversationId: string; verifiedAt: number }>();

interface Flight {
  turnId: string;
  abort: AbortController;
}
const flights = new Map<string, Flight>();

export function webProviderFlightTurnId(sessionId: string): string | undefined {
  return flights.get(sessionId)?.turnId;
}

export function configureBrowserChatForTests(options: {
  complete?: (text: string, signal?: AbortSignal, options?: { fresh?: boolean }) => Promise<{ text: string }>;
  readinessTimeoutMs?: number;
  readinessMaxDurationMs?: number;
}): void {
  webChatReadinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_WEB_CHAT_READINESS_TIMEOUT_MS;
  webChatReadinessMaxDurationMs = options.readinessMaxDurationMs ?? DEFAULT_WEB_CHAT_READINESS_MAX_DURATION_MS;
  configureProviderPageForTests({
    complete: options.complete
      ? (_provider, _conversationId, text, signal, pageOptions) => options.complete!(text, signal, pageOptions)
      : undefined
  });
}

export function resetBrowserChatForTests(): void {
  resetProviderPageForTests();
  webChatReadinessTimeoutMs = DEFAULT_WEB_CHAT_READINESS_TIMEOUT_MS;
  webChatReadinessMaxDurationMs = DEFAULT_WEB_CHAT_READINESS_MAX_DURATION_MS;
  verifiedDeepseekContexts.clear();
  for (const flight of flights.values()) flight.abort.abort(new Error('test reset'));
  flights.clear();
}

export function abortWebProviderSession(sessionId: string, expectedTurnId: string): boolean {
  const flight = flights.get(sessionId);
  if (!flight || flight.turnId !== expectedTurnId) return false;
  flight.abort.abort(new Error('Stop requested'));
  flights.delete(sessionId);
  return true;
}

function linkAbort(outer?: AbortSignal): AbortController {
  const local = new AbortController();
  if (!outer) return local;
  const onAbort = () => local.abort(outer.reason);
  if (outer.aborted) local.abort(outer.reason);
  else outer.addEventListener('abort', onAbort, { once: true });
  return local;
}

async function observe(
  conversationId: string,
  items: Parameters<typeof recordChatObservations>[1]
): Promise<void> {
  await recordChatObservations(conversationId, items);
}

function mintConversationId(provider: WebProviderId): string {
  return webProviderConversationId(provider, randomUUID());
}

function resolveConversation(provider: WebProviderId, entry: InputEntry, sessionConversationId: string | null | undefined): string {
  const existing = entry.conversationId || sessionConversationId;
  if (existing) {
    if (providerForConversationId(existing) !== provider) {
      throw new Error(`This session belongs to ${providerForConversationId(existing) ?? 'another executor'}. Start a new chat to use ${WEB_PROVIDERS[provider].label}.`);
    }
    return existing;
  }
  return mintConversationId(provider);
}

function isOpening(messages: WebChatMessage[]): boolean {
  return messages.every(row => row.role === 'system');
}

function isDeepseekContextUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(DEEPSEEK_CONTEXT_UNAVAILABLE);
}

function isVerifiedIdleProviderFailure(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { providerIdle?: unknown }).providerIdle === true;
}

async function latestAuthoredRequest(sessionId: string, excludeInputId?: string): Promise<string | null> {
  const detail = await readSessionEvents(sessionId, { limit: 160, kinds: ['user_message'] });
  const latest = detail?.events.filter(event => event.kind === 'user_message' && event.inputId !== excludeInputId)
    .sort((left, right) => right.seq - left.seq)[0];
  return latest?.kind === 'user_message'
    ? latest.authoredText?.trim() || latest.message.text.trim() || null
    : null;
}

function validBootstrapReply(text: string): boolean {
  return (text.trim() === WEB_BOOTSTRAP_ACK || text.trim() === LEGACY_WEB_BOOTSTRAP_ACK) &&
    parseWebChatTools(text).length === 0 && !incompleteWebChatTool(text);
}

function boundedText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = '\n[…middle omitted…]\n';
  const available = Math.max(0, limit - marker.length);
  const head = Math.ceil(available / 2);
  return `${text.slice(0, head)}${marker}${text.slice(-(available - head))}`;
}

function boundedWebToolResults(results: Array<{ name: string; content: string }>): string {
  const marker = '[Some tool output was shortened or omitted to fit the provider limit. Read focused ranges again if needed.]';
  const resultBudget = MAX_TOOL_RESULT_CONTEXT_CHARS - marker.length - 2;
  const selected: string[] = [];
  let used = 0;
  let shortened = false;
  for (let index = 0; index < results.length; index++) {
    const result = results[index]!;
    const separator = selected.length ? 2 : 0;
    const remaining = resultBudget - used - separator;
    const share = Math.floor(remaining / (results.length - index));
    const full = formatWebChatResult(result.name, result.content);
    if (full.length <= share) {
      selected.push(full);
      used += separator + full.length;
      continue;
    }
    let contentLimit = Math.max(0, share - 256);
    let compact = '';
    while (contentLimit > 0) {
      compact = formatWebChatResult(result.name, boundedText(result.content, contentLimit));
      if (compact.length <= share) break;
      contentLimit = Math.floor(contentLimit * 0.75);
    }
    if (contentLimit > 0 && compact.length <= share) {
      selected.push(compact);
      used += separator + compact.length;
    } else {
      const omitted = formatWebChatResult(result.name, '[output omitted to fit the provider context limit]');
      if (omitted.length <= remaining) {
        selected.push(omitted);
        used += separator + omitted.length;
      }
    }
    shortened = true;
  }
  const text = selected.join('\n\n');
  return shortened ? `${text}${text ? '\n\n' : ''}${marker}` : text;
}

function webProviderRoundFollowup(
  entry: InputEntry,
  results: Array<{ name: string; content: string }>,
  reminder: string,
  finalizing: boolean
): string {
  const activeRequest = boundedText(entry.text.trim(), MAX_ACTIVE_REQUEST_CHARS);
  const guidance = [
    reminder,
    `ACTIVE REQUEST: ${activeRequest}`,
    'Continue this request from the completed work and tool results above. Do not switch tasks or ask the user to repeat the request.',
    ...(finalizing ? ['This run has reached its tool-round limit. Finish the task now without another tool call. State clearly if any requested action remains incomplete.'] : [])
  ].join('\n\n');
  const output = boundedWebToolResults(results);
  const pageText = `${output}${output ? '\n\n' : ''}${guidance}`;
  return pageText.length <= MAX_PROVIDER_PAGE_CHARS ? pageText : boundedText(pageText, MAX_PROVIDER_PAGE_CHARS);
}

function webProviderCompletionReview(entry: InputEntry): string {
  const activeRequest = boundedText(entry.text.trim(), MAX_ACTIVE_REQUEST_CHARS);
  return [
    'COMPLETION REVIEW: Before ending this task, compare the original request with the work and tool results in this conversation. Inspect the actual project files and run focused checks when useful.',
    `ACTIVE REQUEST: ${activeRequest}`,
    'If any requested deliverable or verification is missing, continue working with the available tools now. Preserve successful work, avoid repeating completed edits, and do not stop at a status report. If everything is complete, give a concise final response with concrete verification evidence. Never claim an unverified result.'
  ].join('\n\n');
}

function rememberDeepseekContext(sessionId: string, conversationId: string): void {
  verifiedDeepseekContexts.set(sessionId, { conversationId, verifiedAt: Date.now() });
}

function hasRecentDeepseekContext(sessionId: string, conversationId: string): boolean {
  const verified = verifiedDeepseekContexts.get(sessionId);
  if (!verified || verified.conversationId !== conversationId || Date.now() - verified.verifiedAt >= VERIFIED_DEEPSEEK_CONTEXT_TTL_MS) {
    verifiedDeepseekContexts.delete(sessionId);
    return false;
  }
  return true;
}

async function requestReadinessComplete(
  provider: WebProviderId,
  conversationId: string,
  text: string,
  signal: AbortSignal,
  deadline: number,
  options?: { fresh?: boolean }
): Promise<{ text: string }> {
  const timeoutMessage = `${WEB_PROVIDERS[provider].label} took too long to prepare this chat. Check the provider tab and retry.`;
  async function requestOnce(requestText: string, requestOptions?: { fresh?: boolean }): Promise<{ text: string }> {
    if (deadline - Date.now() <= 0) throw new Error(timeoutMessage);

    const controller = new AbortController();
    const relayAbort = () => controller.abort(signal.reason);
    if (signal.aborted) relayAbort();
    else signal.addEventListener('abort', relayAbort, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let rejectTimeout: (error: Error) => void = () => undefined;
    const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
    const armTimeout = () => {
      if (timer) clearTimeout(timer);
      const remaining = Math.min(deadline - Date.now(), webChatReadinessTimeoutMs);
      if (remaining <= 0) {
        timedOut = true;
        controller.abort(new Error('Chat readiness timed out'));
        rejectTimeout(new Error(timeoutMessage));
        return;
      }
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('Chat readiness timed out'));
        rejectTimeout(new Error(timeoutMessage));
      }, remaining);
    };
    // Only actual provider generation extends this idle window. The absolute
    // deadline still bounds all attempts to prepare the chat.
    const stopWatchingProgress = onProviderPageProgress(progress => {
      if (progress.conversationId === conversationId && progress.generating) armTimeout();
    });
    armTimeout();
    try {
      return await Promise.race([
        requestProviderPageComplete(provider, conversationId, requestText, controller.signal, requestOptions),
        timeout
      ]);
    } catch (error) {
      if (timedOut) throw new Error(timeoutMessage);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      stopWatchingProgress();
      signal.removeEventListener('abort', relayAbort);
    }
  }

  let requestText = text;
  let requestOptions = options;
  let idleRecoveries = 0;
  while (true) {
    signal.throwIfAborted();
    try {
      return await requestOnce(requestText, requestOptions);
    } catch (error) {
      if (provider !== 'deepseek' || getConfig().ui.autoContinue === false ||
          idleRecoveries >= MAX_DEEPSEEK_IDLE_RECOVERIES ||
          !isVerifiedIdleProviderFailure(error) || signal.aborted || Date.now() >= deadline) throw error;
      idleRecoveries++;
      requestText = [
        'Continue the preparation request already present in this exact chat. Use the project and conversation context supplied there.',
        'Complete that same preparation work and return its requested readiness or context confirmation. Do not start the user’s queued request yet.'
      ].join('\n\n');
      // The first attempt may have created this chat. Continue on its saved page
      // so the already-sent setup and project context remain available.
      requestOptions = undefined;
    }
  }
}

async function acknowledgeWarmup(
  entry: InputEntry,
  provider: WebProviderId,
  sessionId: string,
  conversationId: string,
  system: string,
  priorMessages: WebChatMessage[],
  signal: AbortSignal,
  deadline: number,
  turnId: string
): Promise<void> {
  const check = prepareWebProviderContextCheck(await latestAuthoredRequest(sessionId, entry.warmup ? undefined : entry.id));
  let reply: { text: string } | null = null;
  try {
    reply = await requestReadinessComplete(provider, conversationId, check.prompt, signal, deadline);
  } catch (error) {
    if (provider !== 'deepseek' || !isDeepseekContextUnavailable(error)) throw error;
  }
  const confirmed = !!reply && confirmsWebProviderContext(reply.text, check.expectedWords) &&
    parseWebChatTools(reply.text).length === 0 && !incompleteWebChatTool(reply.text);
  if (!confirmed) {
    if (provider !== 'deepseek') throw new Error(`${WEB_PROVIDERS[provider].label} did not confirm this chat's previous context. No message was sent.`);
    const replay = replayWebProviderTranscript(priorMessages, check.prompt, 96_000);
    if (!replay) throw new Error('DeepSeek could not confirm this chat context, and no saved transcript is available to restore it. No message was sent.');

    const setup = await prepareWebProviderBootstrap(entry, sessionId, system);
    const setupReply = await requestReadinessComplete(provider, conversationId, setup, signal, deadline, { fresh: true });
    if (!validBootstrapReply(setupReply.text)) {
      throw new Error('DeepSeek did not confirm the restored project context. No message was sent.');
    }
    reply = await requestReadinessComplete(provider, conversationId, replay, signal, deadline);
    if (!confirmsWebProviderContext(reply.text, check.expectedWords) ||
        parseWebChatTools(reply.text).length || incompleteWebChatTool(reply.text)) {
      throw new Error('DeepSeek could not confirm the restored conversation history. No message was sent.');
    }
  }

  await observe(conversationId, [{
    kind: 'assistant_message',
    time: Date.now(),
    messageId: randomUUID(),
    inputId: entry.id,
    text: WEB_BOOTSTRAP_ACK,
    turnId,
    final: true,
    state: 'final',
    activeNow: false
  }]);
  if (provider === 'deepseek') rememberDeepseekContext(sessionId, conversationId);
}

// Accept the outbox row, drive the provider chat, persist its thread, and record the turn.
export async function runWebProviderInput(entry: InputEntry, provider: WebProviderId, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted();
  const sessionId = entry.sessionId ?? entry.id;
  const session = await getSession(sessionId);
  const projectChat = Boolean(session?.projectId);
  if (entry.projectPlanPhase === 'draft' && !projectChat) {
    throw new Error('Plan mode is available only in a chat linked to a project.');
  }
  const pendingPlan = projectChat ? await readProjectPlanState(sessionId) : null;
  const planStage = !projectChat ? null : entry.projectPlanPhase === 'draft'
    ? 'draft'
    : pendingPlan ? projectPlanAction(entry.text) ?? 'review' : null;
  const projectPlanReadOnly = planStage !== null && planStage !== 'approved';
  const conversationId = resolveConversation(provider, entry, session?.conversationId ?? null);
  const registrar = createBrowserChatToolRegistrar();
  const guideCtx = await getBrowserChatGuideContext(sessionId);
  const allTools = advertisedBrowserChatTools(registrar);
  const planTools = allTools.filter(tool => (WEB_CHAT_READ_ONLY_TOOLS as readonly string[]).includes(tool.name));
  if (projectPlanReadOnly && (!guideCtx.project || !planTools.some(tool => tool.name === 'read'))) {
    throw new Error('Plan mode needs a readable project folder and file-reading permission. No message was sent.');
  }
  const reminder = !projectChat ? '' : projectPlanReadOnly
    ? 'Only read or search relevant project files. Do not edit, run commands, or use other tools. Answer the current request and wait for explicit plan approval before making changes.'
    : webChatRoundReminder(guideCtx);
  const system = !projectChat ? webPlainChatInstructions(guideCtx.language)
    : projectPlanReadOnly ? webProjectPlanToolGuide(planTools, guideCtx)
      : webToolGuide(allTools, guideCtx);
  const prior = await readWebProviderThread(sessionId, conversationId, provider);
  const history = !prior && session?.conversationId
    ? await readSessionEvents(sessionId, { limit: 160 })
    : null;
  const recoveredMessages = sessionHistoryMessages(history?.events ?? [], { includeTools: projectChat });
  const priorMessages = projectChat
    ? prior?.messages ?? recoveredMessages
    : textOnlyWebMessages(prior?.messages ?? recoveredMessages);
  let messages = withWebProviderSystem(priorMessages, system);
  const historySummary = summarizeProviderConversation(priorMessages, { includeTools: projectChat }) ||
    summarizeSessionHistory(history?.events ?? [], { includeTools: projectChat });
  const priorAuthoredRequest = await latestAuthoredRequest(sessionId, entry.warmup ? undefined : entry.id);
  // An automatic opening warmup can leave a setup message and its ACK in the
  // provider transcript before the user sends anything. That is not prior chat
  // history: the first authored request should carry the current instructions
  // and project context directly, without a model-level readiness round trip.
  const hasPriorAuthoredContext = Boolean(priorAuthoredRequest || historySummary);
  // A project chat can reserve its local provider conversation id before the
  // provider has seen any setup. Its automatic warmup is still the opening
  // exchange when there is no earlier authored request in the session.
  const openingWarmup = entry.warmup === true && !priorAuthoredRequest;
  // A worker session reserves its local provider id before its first delivery, so
  // the first worker turn still needs a fresh provider bootstrap. A bound user
  // chat with a missing local mirror must remain a context check and replay.
  // Bootstrap only when the provider transcript is actually empty. A completed
  // automatic warmup already loaded setup into this provider chat, even when
  // the first authored request arrives after the context-verification TTL.
  const opening = isOpening(messages) && (!hasPriorAuthoredContext ||
    (!session?.conversationId && !entry.conversationId) || session?.origin?.kind === 'worker' || openingWarmup);
  const preparedText = entry.warmup ? '' : await prepareLocalProviderPrompt(entry, sessionId, {
    historySummary: opening || !hasPriorAuthoredContext ? undefined : historySummary,
    projectPlanPhase: planStage === 'draft' ? 'draft' : undefined,
    projectPlanContext: planStage && planStage !== 'draft'
      ? projectPlanContext(pendingPlan ?? { request: entry.text, plan: '' }, planStage)
      : undefined
  });
  const bootstrap = opening ? await prepareWebProviderBootstrap(entry, sessionId, system) : null;
  const userMessageId = randomUUID();
  const turnId = randomUUID();
  signal?.throwIfAborted();
  if (!await acceptLocalExecutorInput(entry.id, conversationId, userMessageId)) {
    throw new Error(`${WEB_PROVIDERS[provider].label} could not accept this message into the local session.`);
  }
  const bound = await getSession(sessionId);
  if (!bound?.conversationId) throw new Error('The provider session is missing its conversation binding.');
  const ownedConversation = bound.conversationId;
  const abort = linkAbort(signal);
  flights.set(sessionId, { turnId, abort });
  const now = () => Date.now();
  try {
    const accepted = (await listInputs()).find(row => row.id === entry.id && row.state === 'sent');
    if (!accepted) throw new Error(`NEURAFLOK could not verify the accepted ${WEB_PROVIDERS[provider].label} message.`);
    if (!entry.warmup) {
      await recordDeliveredInput(accepted, undefined, { turnId });
    }
    await observe(ownedConversation, [{ kind: 'turn_start', time: now(), turnId }]);
    if (!entry.warmup) await noteLocalAgentTurnStarted(ownedConversation, now());
    let thread: WebChatThread = {
      version: 1,
      sessionId,
      conversationId: ownedConversation,
      messages,
      updatedAt: now()
    };
    await persistWebProviderThread(thread, provider);

    // Start the readiness budget when the provider is about to be called. Local
    // session setup can take longer than a short test or provider timeout.
    const warmupDeadline = entry.warmup ? Date.now() + webChatReadinessMaxDurationMs : null;
    if (bootstrap) {
      const ready = await requestReadinessComplete(
        provider,
        ownedConversation,
        bootstrap,
        abort.signal,
        warmupDeadline ?? Date.now() + webChatReadinessMaxDurationMs,
        { fresh: true }
      );
      if (!validBootstrapReply(ready.text)) {
        throw new Error('The provider did not acknowledge NEURAFLOK setup. Your task was not sent to the page.');
      }
      if (provider === 'deepseek') rememberDeepseekContext(sessionId, ownedConversation);
      thread.messages = trimWebProviderThread([...thread.messages, { role: 'user', content: bootstrap }, { role: 'assistant', content: ready.text }]);
      await persistWebProviderThread(thread, provider);
      if (entry.warmup) {
        await observe(ownedConversation, [{
          kind: 'assistant_message',
          time: now(),
          messageId: randomUUID(),
          inputId: entry.id,
          text: WEB_BOOTSTRAP_ACK,
          turnId,
          final: true,
          state: 'final',
          activeNow: false
        }, { kind: 'turn_end', time: now(), turnId, outcome: 'completed', final: true }]);
        return turnId;
      }
    }
    if (entry.warmup) {
      await acknowledgeWarmup(entry, provider, sessionId, ownedConversation, system, priorMessages, abort.signal,
        warmupDeadline ?? Date.now() + webChatReadinessMaxDurationMs, turnId);
      await observe(ownedConversation, [{ kind: 'turn_end', time: now(), turnId, outcome: 'completed', final: true }]);
      return turnId;
    }
    if (provider === 'deepseek' && hasPriorAuthoredContext && !hasRecentDeepseekContext(sessionId, ownedConversation)) {
      await acknowledgeWarmup(entry, provider, sessionId, ownedConversation, system, priorMessages, abort.signal,
        Date.now() + webChatReadinessMaxDurationMs, turnId);
    }
    thread.messages = trimWebProviderThread([...thread.messages, { role: 'user', content: entry.text }]);
    await persistWebProviderThread(thread, provider);

    let pageText = `${preparedText}\n\n${reminder}`;
    let assistantText = '';
    let incompleteTries = 0;
    let assistantMessageId = randomUUID();
    let lastObservedClean = '';
    let idleRecoveries = 0;
    let plainTextRetries = 0;
    let prohibitedPlanRetries = 0;
    let executedToolCalls = 0;
    let reviewedToolCalls = 0;

    const unsubscribeProgress = onProviderPageProgress(async (progress) => {
      if (progress.conversationId !== ownedConversation) return;
      const clean = stripWebChatTools(progress.text);
      if (clean && clean !== lastObservedClean) {
        lastObservedClean = clean;
        await observe(ownedConversation, [{
          kind: 'assistant_message',
          time: now(),
          messageId: assistantMessageId,
          text: clean,
          turnId,
          final: false,
          state: 'streaming',
          activeNow: true
        }]);
      }
    });

    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        abort.signal.throwIfAborted();
        const live = createBrowserChatToolRegistrar();
        let completion: Awaited<ReturnType<typeof requestProviderPageComplete>>;
        let requestText = pageText;
        let contextRecoveryAttempted = false;
        while (true) {
          abort.signal.throwIfAborted();
          try {
            completion = await requestProviderPageComplete(provider, ownedConversation, requestText, abort.signal);
            break;
          } catch (error) {
            const canContinue = provider === 'deepseek' && !entry.warmup &&
              getConfig().ui.autoContinue !== false && idleRecoveries < MAX_DEEPSEEK_IDLE_RECOVERIES &&
              isVerifiedIdleProviderFailure(error);
            if (canContinue) {
              idleRecoveries++;
              requestText = `${recoveryMessage(entry.text)}\n\n${reminder}`;
              thread.messages = trimWebProviderThread([...thread.messages, { role: 'user', content: requestText }]);
              await persistWebProviderThread(thread, provider);
              continue;
            }
            if (provider !== 'deepseek' || contextRecoveryAttempted || round !== 0 || !isDeepseekContextUnavailable(error)) throw error;
            const replay = replayWebProviderTranscript(priorMessages, requestText, 96_000, entry.text);
            if (!replay) {
              throw new Error('DeepSeek perdió el historial remoto y NeuraFlok no tiene suficiente transcripción local para reconstruir el contexto. No se envió el mensaje.');
            }
            abort.signal.throwIfAborted();
            const setup = await prepareWebProviderBootstrap(entry, sessionId, system);
            const ready = await requestProviderPageComplete(provider, ownedConversation, setup, abort.signal, { fresh: true });
            if (!validBootstrapReply(ready.text)) {
              throw new Error('DeepSeek no confirmó la restauración del contexto. No se envió el mensaje.');
            }
            rememberDeepseekContext(sessionId, ownedConversation);
            contextRecoveryAttempted = true;
            requestText = replay;
          }
        }
        const raw = completion.text ?? '';
        const calls = parseWebChatTools(raw);
        const assistantContent = stripWebChatTools(raw);
        if (!projectChat && (calls.length || incompleteWebChatTool(raw))) {
          if (plainTextRetries++ === 0) {
            pageText = 'Answer the user\'s current message directly in natural text. This is a normal chat with no file or command tools. Do not emit tool syntax.';
            continue;
          }
          assistantText = assistantContent || 'I could not produce a plain-text response. Please send the question again.';
          break;
        }
        if (projectPlanReadOnly && calls.some(call => !(WEB_CHAT_READ_ONLY_TOOLS as readonly string[]).includes(call.function.name))) {
          if (prohibitedPlanRetries++ === 0) {
            pageText = 'A non-read-only tool request was blocked and did not run. Continue by reading relevant project files with read/find only, then propose a concise plan without changing anything.';
            continue;
          }
          assistantText = 'I could not prepare a safe read-only plan for this request. Please try Plan again.';
          break;
        }
        if (round === MAX_TOOL_ROUNDS && calls.length) {
          assistantText = assistantContent || `The model reached the ${MAX_TOOL_ROUNDS}-round tool limit before returning a final answer. The completed work is saved; send a follow-up to continue.`;
          thread.messages = trimWebProviderThread([...thread.messages, { role: 'assistant', content: assistantText }]);
          await persistWebProviderThread(thread, provider);
          break;
        }
        thread.messages = trimWebProviderThread([...thread.messages, calls.length
          ? { role: 'assistant', ...(assistantContent ? { content: assistantContent } : {}), tool_calls: calls }
          : { role: 'assistant', content: raw }]);
        await persistWebProviderThread(thread, provider);
        if (!calls.length) {
          if (incompleteWebChatTool(raw) && incompleteTries < MAX_INCOMPLETE_TOOL) {
            incompleteTries++;
            pageText = projectPlanReadOnly ? incompletePlanToolNotice() : incompleteToolNotice(guideCtx);
            continue;
          }
          if (!projectPlanReadOnly && executedToolCalls > reviewedToolCalls) {
            reviewedToolCalls = executedToolCalls;
            pageText = webProviderCompletionReview(entry);
            thread.messages = trimWebProviderThread([...thread.messages, { role: 'user', content: pageText }]);
            await persistWebProviderThread(thread, provider);
            continue;
          }
          assistantText = stripWebChatTools(raw);
          break;
        }
        if (lastObservedClean) {
          await observe(ownedConversation, [{
            kind: 'assistant_message',
            time: now(),
            messageId: assistantMessageId,
            text: assistantContent,
            turnId,
            final: true,
            state: 'final',
            activeNow: true
          }]);
        }
        assistantMessageId = randomUUID();
        lastObservedClean = '';
        incompleteTries = 0;
        const requestId = `dsreq-${randomUUID()}`;
        const results: Array<{ name: string; content: string }> = [];
        for (const call of calls) {
          abort.signal.throwIfAborted();
          const content = await invokeBrowserChatTool(live, call, requestId, ownedConversation, sessionId,
            projectPlanReadOnly ? guideCtx.project : undefined);
          executedToolCalls++;
          results.push({ name: call.function.name, content });
          thread.messages = trimWebProviderThread([...thread.messages, {
            role: 'tool',
            tool_call_id: call.id,
            content
          }]);
          await persistWebProviderThread(thread, provider);
        }
        pageText = webProviderRoundFollowup(entry, results, reminder, round === MAX_TOOL_ROUNDS - 1);
      }
      if (!assistantText) assistantText = '(no assistant text)';
      const usablePlanReply = assistantText !== '(no assistant text)' && !/could not prepare a safe read-only plan/i.test(assistantText);
      if (projectChat && usablePlanReply) {
        if (planStage === 'draft') {
          await updateProjectPlanState(sessionId, ownedConversation, { request: entry.text, plan: assistantText }, now());
        } else if (planStage === 'review' && pendingPlan) {
          await updateProjectPlanState(sessionId, ownedConversation, { request: pendingPlan.request, plan: assistantText }, now());
        } else if (planStage === 'approved' || planStage === 'cancel') {
          await clearProjectPlanState(sessionId, ownedConversation);
        }
      }
      await observe(ownedConversation, [
        {
          kind: 'assistant_message',
          time: now(),
          messageId: assistantMessageId,
          text: assistantText,
          turnId,
          final: true,
          state: 'final',
          activeNow: true
        },
        { kind: 'turn_end', time: now(), turnId, outcome: 'completed', final: true }
      ]);
      logInfo(`${provider}: session ${sessionId} completed turn ${turnId}`);
      return turnId;
    } finally {
      unsubscribeProgress();
    }
  } catch (error) {
    const aborted = abort.signal.aborted || (error instanceof Error && error.name === 'AbortError');
    if (aborted) {
      await observe(ownedConversation, [
        { kind: 'turn_end', time: now(), turnId, outcome: 'stopped', detail: 'Stop requested' }
      ]).catch(() => undefined);
      return null;
    }
    const detail = (error as Error).message.replace(/^DEEPSEEK_CONTEXT_UNAVAILABLE:\s*/, '').slice(0, 500);
    logWarn(`${provider}: session ${sessionId} failed: ${detail}`);
    await observe(ownedConversation, [
      { kind: 'chat_error', time: now(), turnId, inputId: entry.id, text: detail, recoverable: false },
      { kind: 'turn_end', time: now(), turnId, outcome: 'failed', detail }
    ]).catch(() => undefined);
    return null;
  } finally {
    const current = flights.get(sessionId);
    if (current?.turnId === turnId) flights.delete(sessionId);
  }
}

