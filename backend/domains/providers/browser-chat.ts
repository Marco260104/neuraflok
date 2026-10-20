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
  readWebProviderThread,
  trimWebProviderThread,
  withWebProviderSystem
} from './browser-chat-thread.js';
import { prepareLocalProviderPrompt, prepareWebProviderBootstrap, LEGACY_WEB_BOOTSTRAP_ACK, WEB_BOOTSTRAP_ACK } from '../sessions/input/provider-context.js';
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
import {
  advertisedBrowserChatTools,
  createBrowserChatToolRegistrar,
  getBrowserChatGuideContext,
  invokeBrowserChatTool
} from './browser-chat-tools.js';

const MAX_ROUEDS = 24;
const MAX_INCOMPLETE_TOOL = 3;

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
}): void {
  configureProviderPageForTests({
    complete: options.complete
      ? (_provider, _conversationId, text, signal, pageOptions) => options.complete!(text, signal, pageOptions)
      : undefined
  });
}

export function resetBrowserChatForTests(): void {
  resetProviderPageForTests();
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
  const opening = isOpening(messages);
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
      await observe(ownedConversation, [{ kind: 'turn_start', time: now(), turnId }]);
      await noteLocalAgentTurnStarted(ownedConversation, now());
    }
    let thread: WebChatThread = {
      version: 1,
      sessionId,
      conversationId: ownedConversation,
      messages,
      updatedAt: now()
    };
    await persistWebProviderThread(thread, provider);

    if (bootstrap) {
      const ready = await requestProviderPageComplete(provider, ownedConversation, bootstrap, abort.signal, { fresh: true });
      if ((!ready.text.includes(WEB_BOOTSTRAP_ACK) && !ready.text.includes(LEGACY_WEB_BOOTSTRAP_ACK)) || parseWebChatTools(ready.text).length || incompleteWebChatTool(ready.text)) {
        throw new Error('The provider did not acknowledge NEURAFLOK setup. Your task was not sent to the page.');
      }
      thread.messages = trimWebProviderThread([...thread.messages, { role: 'user', content: bootstrap }, { role: 'assistant', content: ready.text }]);
      await persistWebProviderThread(thread, provider);
      if (entry.warmup) {
        await observe(ownedConversation, [{
          kind: 'assistant_message',
          time: now(),
          messageId: randomUUID(),
          text: WEB_BOOTSTRAP_ACK,
          turnId,
          final: true,
          state: 'final',
          activeNow: true
        }]);
        return turnId;
      }
    }
    if (entry.warmup) return turnId;
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
      for (let round = 0; round < MAX_ROUEDS; round++) {
        abort.signal.throwIfAborted();
        const live = createBrowserChatToolRegistrar();
        const completion = await requestProviderPageComplete(provider, ownedConversation, pageText, abort.signal);
        const raw = completion.text ?? '';
        const calls = parseWebChatTools(raw);
        thread.messages = trimWebProviderThread([...thread.messages, { role: 'assistant', content: raw }]);
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
            text: lastObservedClean,
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
        const results: string[] = [];
        for (const call of calls) {
          abort.signal.throwIfAborted();
          const content = await invokeBrowserChatTool(live, call, requestId, ownedConversation, sessionId);
          results.push(formatWebChatResult(call.function.name, content));
          thread.messages = trimWebProviderThread([...thread.messages, {
            role: 'tool',
            tool_call_id: call.id,
            content
          }]);
          await persistWebProviderThread(thread, provider);
        }
        pageText = `${results.join('\n\n')}\n\n${reminder}`;
        if (round === MAX_ROUEDS - 1) {
          assistantText = stripWebChatTools(raw) || 'Stopped after too many tool rounds.';
        }
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
    const detail = (error as Error).message.slice(0, 500);
    logWarn(`${provider}: session ${sessionId} failed: ${detail}`);
    await observe(ownedConversation, [
      { kind: 'chat_error', time: now(), turnId, text: detail, recoverable: false },
      { kind: 'turn_end', time: now(), turnId, outcome: 'failed', detail }
    ]).catch(() => undefined);
    return null;
  } finally {
    const current = flights.get(sessionId);
    if (current?.turnId === turnId) flights.delete(sessionId);
  }
}

