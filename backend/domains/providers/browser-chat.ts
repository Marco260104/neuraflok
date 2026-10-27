// Browser provider chat executor with local tool dispatch and durable thread history.
import { randomUUID } from 'node:crypto';
import {
  webChatRoundReminder,
  webChatConversationGuide,
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
import {
  prepareLocalProviderPrompt,
  prepareWebProviderBootstrap,
  buildProviderProjectContext,
  buildGeneralChatContext,
  isNewProviderChat,
  localProviderNeedsWorkspace,
  looksLikeContinueRequest,
  looksLikeStaleCompletion,
  looksLikeProjectStatusRecap,
  parseWorkPlan,
  formatPlanOnlyPrompt,
  formatExecuteStepPrompt,
  getSessionWorkPlan,
  setSessionWorkPlan,
  advanceSessionWorkPlan,
  clearSessionWorkPlan,
  markLocalProviderHydrated,
  resetLocalProviderHydrationForTests,
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
import {
  advertisedBrowserChatTools,
  createBrowserChatToolRegistrar,
  getBrowserChatGuideContext,
  invokeBrowserChatTool
} from './browser-chat-tools.js';

const MAX_ROUEDS = 48;
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
  resetLocalProviderHydrationForTests();
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

function sameNormalizedText(left: string, right: string): boolean {
  return String(left || '').replace(/\s+/g, ' ').trim() === String(right || '').replace(/\s+/g, ' ').trim();
}

function isBootstrapAssistant(content: string): boolean {
  return /NEURAFLOK_READY|NEURAL_JAM_READY|Initialize this NEURAFLOK conversation/i.test(content);
}

function lastPublicAssistantText(messages: WebChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const row = messages[index];
    if (row?.role !== 'assistant') continue;
    const content = String(row.content || '');
    if (isBootstrapAssistant(content)) continue;
    if (looksLikeProjectStatusRecap(content)) continue;
    const clean = stripWebChatTools(content).replace(/\s+/g, ' ').trim();
    if (looksLikeProjectStatusRecap(clean)) continue;
    if (clean) return clean;
    if (content.trim()) return content;
  }
  return '';
}

function isForeignProjectRecap(userText: string, answer: string, general: boolean): boolean {
  if (!general) return false;
  if (looksLikeProjectStatusRecap(userText)) return false;
  return looksLikeProjectStatusRecap(answer);
}

/** Leftover recap from a previous DeepSeek tab. Extracted recaps are send-only and must not be stored. */
function isPageLeftoverRecap(userText: string, answer: string, sawTools: boolean, general: boolean): boolean {
  if (!looksLikeProjectStatusRecap(answer)) return false;
  if (looksLikeProjectStatusRecap(userText)) return false;
  if (general) return true;
  return !sawTools;
}

function isLeftoverConversationError(error: unknown): boolean {
  return /still showed a previous conversation/i.test(error instanceof Error ? error.message : String(error || ''));
}

function isLeftoverPageReply(raw: string, messages: WebChatMessage[]): boolean {
  const text = String(raw || '').trim();
  if (!text) return false;
  const substantial = text.length >= 80 || parseWebChatTools(text).length > 0;
  if (!substantial) return false;
  const rawClean = stripWebChatTools(text).replace(/\s+/g, ' ').trim();
  for (const row of messages) {
    if (row?.role !== 'assistant') continue;
    const content = String(row.content || '');
    if (isBootstrapAssistant(content)) continue;
    if (sameNormalizedText(content, text)) return true;
    const clean = stripWebChatTools(content).replace(/\s+/g, ' ').trim();
    if (rawClean && clean && rawClean === clean) return true;
  }
  return false;
}

// Accept the outbox row, drive the provider chat, persist its thread, and record the turn.
export async function runWebProviderInput(entry: InputEntry, provider: WebProviderId, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted();
  const sessionId = entry.sessionId ?? entry.id;
  const session = await getSession(sessionId);
  const conversationId = resolveConversation(provider, entry, session?.conversationId ?? null);
  const registrar = createBrowserChatToolRegistrar();
  const guideCtx = await getBrowserChatGuideContext(sessionId, entry.projectId);
  const general = !guideCtx.project;
  const reminder = webChatRoundReminder(guideCtx);
  const system = general
    ? webChatConversationGuide(guideCtx)
    : webToolGuide(advertisedBrowserChatTools(registrar), guideCtx);
  const prior = await readWebProviderThread(sessionId, conversationId, provider);
  let messages = withWebProviderSystem(prior?.messages ?? [], system);
  const opening = isOpening(messages);
  const newChat = isNewProviderChat(messages, entry.opening === true);
  const hydrateWorkspace = general ? false : localProviderNeedsWorkspace(sessionId, opening, entry.text);
  const recap = !entry.warmup
    ? general
      ? await buildGeneralChatContext(sessionId, messages, { newChat })
      : await buildProviderProjectContext(sessionId, messages, {
        newChat,
        continueOnly: looksLikeContinueRequest(entry.text),
        currentTask: entry.text,
        replyGuide: newChat ? undefined : reminder
      })
    : '';
  const preparedText = entry.warmup ? '' : await prepareLocalProviderPrompt(entry, sessionId, opening, {
    recap,
    hydrateWorkspace,
    conversationOnly: general
  });
  const needsBootstrap = opening && !general && (Boolean(guideCtx.project) || Boolean(entry.projectId) || Boolean(entry.warmup));
  const bootstrap = needsBootstrap ? await prepareWebProviderBootstrap(entry, sessionId, system) : null;
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
      const acknowledged = ready.text.includes(WEB_BOOTSTRAP_ACK) || ready.text.includes(LEGACY_WEB_BOOTSTRAP_ACK);
      const ranTools = parseWebChatTools(ready.text).length > 0 || incompleteWebChatTool(ready.text);
      const leftoverSetup = looksLikeProjectStatusRecap(ready.text)
        || isLeftoverPageReply(ready.text, thread.messages)
        || (!acknowledged && String(ready.text || '').trim().length >= 80 && !ranTools);
      if (!String(ready.text || '').trim()) {
        throw new Error('The provider did not acknowledge NEURAFLOK setup. Your task was not sent to the page.');
      }
      if (ranTools) {
        logWarn(`${provider}: setup reply included tool blocks; ignoring them and sending the user message.`);
      }
      if (leftoverSetup) {
        logWarn(`${provider}: ignored leftover setup reply from a previous conversation`);
      } else if (!acknowledged) {
        logWarn(`${provider}: setup reply was not ${WEB_BOOTSTRAP_ACK}; sending the user message anyway.`);
      }
      thread.messages = trimWebProviderThread([
        ...thread.messages,
        { role: 'user', content: bootstrap },
        { role: 'assistant', content: WEB_BOOTSTRAP_ACK }
      ]);
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
        markLocalProviderHydrated(sessionId);
        return turnId;
      }
      markLocalProviderHydrated(sessionId);
    }
    if (entry.warmup) return turnId;
    thread.messages = trimWebProviderThread([...thread.messages, { role: 'user', content: entry.text }]);
    await persistWebProviderThread(thread, provider);

    const continueOnly = looksLikeContinueRequest(entry.text);
    const planning = entry.planOnly === true;
    if (!continueOnly) clearSessionWorkPlan(sessionId);
    const pendingPlan = continueOnly ? getSessionWorkPlan(sessionId) : null;
    let pageText = general
      ? [reminder, preparedText].filter(Boolean).join('\n\n')
      : `${preparedText}\n\n${reminder}`;
    let phase: 'plan' | 'work' = 'work';
    let planRetries = 0;
    if (pendingPlan && pendingPlan.index < pendingPlan.steps.length) {
      pageText = `${preparedText}\n\n${reminder}\n\n${formatExecuteStepPrompt(pendingPlan)}`;
    } else if (planning) {
      phase = 'plan';
      pageText = `${preparedText}\n\n${formatPlanOnlyPrompt(entry.text)}`;
    }
    let assistantText = '';
    let incompleteTries = 0;
    let leftoverTries = 0;
    let sawToolsThisTurn = false;
    let usedOpeningFresh = Boolean(bootstrap);
    let retryFresh = false;
    let assistantMessageId = randomUUID();
    let lastObservedClean = lastPublicAssistantText(thread.messages);

    const unsubscribeProgress = onProviderPageProgress(async (progress) => {
      if (progress.conversationId !== ownedConversation) return;
      const clean = stripWebChatTools(progress.text);
      if (!clean || clean === lastObservedClean) return;
      if (sameNormalizedText(progress.text, lastObservedClean) || sameNormalizedText(clean, lastObservedClean)) return;
      if (looksLikeStaleCompletion(clean)) return;
      if (isPageLeftoverRecap(entry.text, clean, sawToolsThisTurn, general) || isForeignProjectRecap(entry.text, clean, general)) return;
      if (isLeftoverPageReply(progress.text, thread.messages) || isLeftoverPageReply(clean, thread.messages)) return;
      if (/^(Let me|Let's|We need|I will|I'll |The user |Need to |Must not |Pensado|Pensó|Detenido|Voy a |Vamos a |Déjame |Dejame |Necesito |Debo |Hay que )\b/i.test(clean.replace(/\s+/g, ' ').trim())
        && !parseWebChatTools(progress.text).length && !incompleteWebChatTool(progress.text)) {
        return;
      }
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
    });

    try {
      for (let round = 0; round < MAX_ROUEDS; round++) {
        abort.signal.throwIfAborted();
        const live = createBrowserChatToolRegistrar();
        const pageOptions = retryFresh || !usedOpeningFresh ? { fresh: true } : undefined;
        if (pageOptions) usedOpeningFresh = true;
        retryFresh = false;
        let completion: { text: string };
        try {
          completion = await requestProviderPageComplete(provider, ownedConversation, pageText, abort.signal, pageOptions);
        } catch (error) {
          if (!isLeftoverConversationError(error) || leftoverTries >= 1) throw error;
          leftoverTries += 1;
          logWarn(`${provider}: ignored leftover page answer from a previous conversation`);
          retryFresh = true;
          continue;
        }
        let raw = completion.text ?? '';
        const rawClean = stripWebChatTools(raw) || raw;
        if (
          (isBootstrapAssistant(raw) && Boolean(bootstrap))
          || isLeftoverPageReply(raw, thread.messages)
          || isPageLeftoverRecap(entry.text, rawClean, sawToolsThisTurn, general)
          || isForeignProjectRecap(entry.text, rawClean, general)
        ) {
          leftoverTries += 1;
          logWarn(`${provider}: ignored leftover page answer from a previous conversation`);
          if (leftoverTries >= 2) {
            throw new Error('The provider page still showed a previous conversation. Open a new chat and send again.');
          }
          retryFresh = true;
          continue;
        }
        leftoverTries = 0;
        const calls = general ? [] : parseWebChatTools(raw);
        const clean = stripWebChatTools(raw);
        if (calls.length) sawToolsThisTurn = true;
        thread.messages = trimWebProviderThread([...thread.messages, { role: 'assistant', content: general ? (clean || raw) : raw }]);
        await persistWebProviderThread(thread, provider);
        if (general) {
          assistantText = clean || raw.trim();
          break;
        }
        if (phase === 'plan') {
          const reads = calls.filter(call => call.function.name !== 'apply_patch');
          const patches = calls.filter(call => call.function.name === 'apply_patch');
          if (reads.length && !patches.length) {
            const requestId = `dsreq-${randomUUID()}`;
            const results: string[] = [];
            for (const call of reads) {
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
            pageText = `${results.join('\n\n')}\n\n${reminder}\n\n${formatPlanOnlyPrompt(entry.text)}`;
            continue;
          }
          if ((patches.length || looksLikeStaleCompletion(clean)) && planRetries < 2) {
            planRetries += 1;
            lastObservedClean = '';
            pageText = `${formatPlanOnlyPrompt(entry.text)}`;
            continue;
          }
          const steps = parseWorkPlan(clean);
          if (steps.length >= 2) {
            if (planning) {
              assistantText = clean;
              break;
            }
            const plan = { task: entry.text, steps, index: 0 };
            setSessionWorkPlan(sessionId, plan);
            phase = 'work';
            pageText = `${formatExecuteStepPrompt(plan)}`;
            continue;
          }
          if (calls.length) {
            phase = 'work';
          } else if (looksLikeStaleCompletion(clean)) {
            phase = 'work';
            lastObservedClean = '';
            pageText = `${preparedText}\n\nThe previous "already complete" reply is wrong. Do the latest user request now.\n\n${reminder}`;
            continue;
          } else {
            assistantText = clean;
            break;
          }
        }
        if (!calls.length) {
          if (incompleteWebChatTool(raw) && incompleteTries < MAX_INCOMPLETE_TOOL) {
            incompleteTries++;
            pageText = incompleteToolNotice(guideCtx);
            continue;
          }
          assistantText = clean;
          if (getSessionWorkPlan(sessionId)) advanceSessionWorkPlan(sessionId);
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
      markLocalProviderHydrated(sessionId);
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

