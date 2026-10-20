// Browser provider chat executor with local tool dispatch and durable thread history.
import { randomUUID } from 'node:crypto';
import {
  webChatRoundReminder,
  formatWebChatResult,
  incompleteWebChatTool,
  incompleteToolNotice,
  parseWebChatTools,
  stripWebChatTools,
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
  getSession
} from '../sessions/history/store.js';
import { readSessionEvents } from '../sessions/history/read-model.js';
import {
  advertisedBrowserChatTools,
  createBrowserChatToolRegistrar,
  getBrowserChatGuideContext,
  invokeBrowserChatTool
} from './browser-chat-tools.js';

const MAX_TOOL_ROUNDS = 64;
const MAX_INCOMPLETE_TOOL = 3;
const MAX_TOOL_RESULT_CONTEXT_CHARS = 64_000;
const MAX_ACTIVE_REQUEST_CHARS = 4_000;
const MAX_PROVIDER_PAGE_CHARS = 96_000;
const DEFAULT_WEB_CHAT_READINESS_TIMEOUT_MS = 60_000;
let webChatReadinessTimeoutMs = DEFAULT_WEB_CHAT_READINESS_TIMEOUT_MS;
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
}): void {
  webChatReadinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_WEB_CHAT_READINESS_TIMEOUT_MS;
  configureProviderPageForTests({
    complete: options.complete
      ? (_provider, _conversationId, text, signal, pageOptions) => options.complete!(text, signal, pageOptions)
      : undefined
  });
}

export function resetBrowserChatForTests(): void {
  resetProviderPageForTests();
  webChatReadinessTimeoutMs = DEFAULT_WEB_CHAT_READINESS_TIMEOUT_MS;
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
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`${WEB_PROVIDERS[provider].label} took too long to prepare this chat. Check the provider tab and retry.`);

  const controller = new AbortController();
  const relayAbort = () => controller.abort(signal.reason);
  if (signal.aborted) relayAbort();
  else signal.addEventListener('abort', relayAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('Chat readiness timed out'));
      reject(new Error(`${WEB_PROVIDERS[provider].label} took too long to prepare this chat. Check the provider tab and retry.`));
    }, remaining);
  });
  try {
    return await Promise.race([
      requestProviderPageComplete(provider, conversationId, text, controller.signal, options),
      timeout
    ]);
  } catch (error) {
    if (timedOut) throw new Error(`${WEB_PROVIDERS[provider].label} took too long to prepare this chat. Check the provider tab and retry.`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', relayAbort);
  }
}

async function acknowledgeWarmup(
  entry: InputEntry,
  provider: WebProviderId,
  sessionId: string,
  conversationId: string,
  system: string,
  prior: WebChatThread | null,
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
    const replay = replayWebProviderTranscript(prior?.messages ?? [], check.prompt, 96_000);
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
  const conversationId = resolveConversation(provider, entry, session?.conversationId ?? null);
  const registrar = createBrowserChatToolRegistrar();
  const guideCtx = await getBrowserChatGuideContext(sessionId);
  const reminder = webChatRoundReminder(guideCtx);
  const system = webToolGuide(advertisedBrowserChatTools(registrar), guideCtx);
  const prior = await readWebProviderThread(sessionId, conversationId, provider);
  let messages = withWebProviderSystem(prior?.messages ?? [], system);
  // A missing local mirror must not turn a bound conversation into a fresh provider chat.
  const opening = !session?.conversationId && !entry.conversationId && isOpening(messages);
  const preparedText = entry.warmup ? '' : await prepareLocalProviderPrompt(entry, sessionId, opening);
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
    const warmupDeadline = entry.warmup ? Date.now() + webChatReadinessTimeoutMs : null;
    if (bootstrap) {
      const ready = warmupDeadline
        ? await requestReadinessComplete(provider, ownedConversation, bootstrap, abort.signal, warmupDeadline, { fresh: true })
        : await requestProviderPageComplete(provider, ownedConversation, bootstrap, abort.signal, { fresh: true });
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
      await acknowledgeWarmup(entry, provider, sessionId, ownedConversation, system, prior, abort.signal,
        warmupDeadline ?? Date.now() + webChatReadinessTimeoutMs, turnId);
      await observe(ownedConversation, [{ kind: 'turn_end', time: now(), turnId, outcome: 'completed', final: true }]);
      return turnId;
    }
    if (provider === 'deepseek' && !hasRecentDeepseekContext(sessionId, ownedConversation)) {
      await acknowledgeWarmup(entry, provider, sessionId, ownedConversation, system, prior, abort.signal,
        Date.now() + webChatReadinessTimeoutMs, turnId);
    }
    thread.messages = trimWebProviderThread([...thread.messages, { role: 'user', content: entry.text }]);
    await persistWebProviderThread(thread, provider);

    let pageText = `${preparedText}\n\n${reminder}`;
    let assistantText = '';
    let incompleteTries = 0;
    let assistantMessageId = randomUUID();
    let lastObservedClean = '';

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
        try {
          completion = await requestProviderPageComplete(provider, ownedConversation, pageText, abort.signal);
        } catch (error) {
          if (provider !== 'deepseek' || round !== 0 || !isDeepseekContextUnavailable(error)) throw error;
          const replay = replayWebProviderTranscript(prior?.messages ?? [], pageText, 96_000, entry.text);
          if (!replay) {
            throw new Error('DeepSeek perdió el historial remoto y NeuraFlok no tiene suficiente transcripción local para reconstruir el contexto. No se envió el mensaje.');
          }
          abort.signal.throwIfAborted();
          const setup = await prepareWebProviderBootstrap(entry, sessionId, system);
          const ready = await requestProviderPageComplete(provider, ownedConversation, setup, abort.signal, { fresh: true });
          if (!validBootstrapReply(ready.text)) {
            throw new Error('DeepSeek no confirmó la restauración del contexto. No se envió el mensaje.');
          }
          if (provider === 'deepseek') rememberDeepseekContext(sessionId, ownedConversation);
          completion = await requestProviderPageComplete(provider, ownedConversation, replay, abort.signal);
        }
        const raw = completion.text ?? '';
        const calls = parseWebChatTools(raw);
        const assistantContent = stripWebChatTools(raw);
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
            pageText = incompleteToolNotice(guideCtx);
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
          const content = await invokeBrowserChatTool(live, call, requestId, ownedConversation, sessionId);
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

