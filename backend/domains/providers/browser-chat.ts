// Browser provider chat executor with local tool dispatch and durable thread history.
import { randomUUID } from 'node:crypto';
import {
  webChatRoundReminder,
  WEB_CHAT_READ_ONLY_TOOLS,
  WEB_CHAT_PLAN_DECISION_TOOLS,
  isWebChatPlanDecisionToolName,
  formatWebChatResult,
  incompleteWebChatTool,
  incompleteToolNotice,
  incompletePlanToolNotice,
  parseWebChatTools,
  stripWebChatTools,
  containsUnwrappedApplyPatch,
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
import type { ProviderPageAttachment, ProviderPageAttachmentSource } from './provider-page.js';
import { logInfo, logWarn } from '../../infrastructure/settings/logger.js';
import { getConfig } from '../../infrastructure/settings/config.js';
import { recoveryMessage } from '../../../contracts/recovery.js';
import type { UiLanguage } from '../../../contracts/ui-language.js';
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
import { recordDeliveredInput, updateDeliveredInputAttachmentStatus } from '../sessions/input/input-history.js';
import { readProviderUploadAttachment } from '../sessions/input/attachments/index.js';
import { isDeepseekDirectUpload } from '../../../contracts/attachments.js';
import { hasFreshProviderAttachmentSession, markProviderAttachmentSessionPrepared, retirePreuploadedProviderAttachments, wasProviderAttachmentPreuploaded } from './preuploaded-attachments.js';
import { noteLocalAgentTurnStarted } from '../automation/local-agent-observations.js';
import {
  clearProjectPlanState,
  getSession,
  readProjectPlanState,
  updateProjectPlanState
} from '../sessions/history/store.js';
import { readSessionEvents } from '../sessions/history/read-model.js';
import { summarizeProviderConversation, summarizeSessionHistory, sessionHistoryMessages, textOnlyWebMessages } from './conversation-summary.js';
import {
  hasEmptyProjectPlanDecisionArguments,
  projectPlanContext,
  projectPlanDecisionFromTool,
  projectPlanRevisionFromTool,
  type ProjectPlanStage
} from './project-plan-flow.js';
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
const DEEPSEEK_ATTACHMENT_STAGE_UNAVAILABLE = 'DEEPSEEK_ATTACHMENT_STAGE_UNAVAILABLE:';
const VERIFIED_DEEPSEEK_CONTEXT_TTL_MS = 2 * 60_000;
const verifiedDeepseekContexts = new Map<string, { conversationId: string; verifiedAt: number }>();

async function providerPageAttachments(
  entry: Readonly<InputEntry>,
  provider: WebProviderId,
  includePreuploaded = false,
  conversationId = entry.conversationId ?? ''
): Promise<ProviderPageAttachmentSource[]> {
  if (provider !== 'deepseek' || !entry.attachments?.length) return [];
  const files = entry.attachments.filter(file => (includePreuploaded || !wasProviderAttachmentPreuploaded(conversationId, file.id)) &&
    isDeepseekDirectUpload(file.name, file.mimeType));
  return Promise.all(files.map(async file => ({
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    bytes: await readProviderUploadAttachment(file)
  })));
}

function emptyAssistantReply(language: UiLanguage | undefined): string {
  const replies: Record<UiLanguage, string> = {
    en: 'The provider did not return a response. Please try again.',
    de: 'Der Anbieter hat keine Antwort zurückgegeben. Bitte versuche es erneut.',
    es: 'El proveedor no devolvió una respuesta. Inténtalo de nuevo.',
    fr: 'Le fournisseur n’a pas renvoyé de réponse. Réessayez.',
    'pt-BR': 'O provedor não retornou uma resposta. Tente novamente.',
    'pt-PT': 'O fornecedor não devolveu uma resposta. Tente novamente.',
    ru: 'Провайдер не вернул ответ. Попробуйте ещё раз.',
    tr: 'Sağlayıcı yanıt vermedi. Lütfen tekrar deneyin.',
    vi: 'Nhà cung cấp không trả về câu trả lời. Vui lòng thử lại.',
    ja: 'プロバイダーから応答がありませんでした。もう一度お試しください。',
    ko: '제공업체가 응답을 반환하지 않았습니다. 다시 시도해 주세요.',
    'zh-CN': '提供商没有返回回复，请重试。',
    'zh-TW': '供應商未傳回回覆，請再試一次。'
  };
  return replies[language ?? 'en'];
}

function unwrappedPatchRecoveryFailure(language: UiLanguage | undefined): string {
  const replies: Record<UiLanguage, string> = {
    en: 'I could not safely finish the project task in this turn. Existing project changes were preserved; send a follow-up to continue from the current state.',
    de: 'Ich konnte die Projektaufgabe in diesem Zug nicht sicher abschließen. Vorhandene Änderungen wurden beibehalten; sende eine weitere Nachricht, um mit dem aktuellen Stand fortzufahren.',
    es: 'No pude completar de forma segura la tarea del proyecto en este turno. Se conservaron los cambios existentes; envía otro mensaje para continuar desde el estado actual.',
    fr: 'Je n’ai pas pu terminer la tâche du projet en toute sécurité pendant ce tour. Les modifications existantes ont été conservées ; envoyez un autre message pour reprendre à partir de l’état actuel.',
    'pt-BR': 'Não consegui concluir a tarefa do projeto com segurança nesta rodada. As alterações existentes foram preservadas; envie outra mensagem para continuar do estado atual.',
    'pt-PT': 'Não consegui concluir a tarefa do projeto com segurança nesta interação. As alterações existentes foram preservadas; envie outra mensagem para continuar a partir do estado atual.',
    ru: 'Не удалось безопасно завершить задачу проекта за этот ход. Существующие изменения сохранены; отправьте ещё одно сообщение, чтобы продолжить с текущего состояния.',
    tr: 'Proje görevini bu turda güvenli şekilde tamamlayamadım. Mevcut değişiklikler korundu; geçerli durumdan devam etmek için yeni bir mesaj gönderin.',
    vi: 'Tôi chưa thể hoàn thành an toàn tác vụ dự án trong lượt này. Các thay đổi hiện có đã được giữ lại; hãy gửi tin nhắn tiếp theo để tiếp tục từ trạng thái hiện tại.',
    ja: 'このターンではプロジェクト作業を安全に完了できませんでした。既存の変更は保持されています。現在の状態から続けるには、もう一度メッセージを送信してください。',
    ko: '이번 응답에서 프로젝트 작업을 안전하게 완료하지 못했습니다. 기존 변경 사항은 보존되었습니다. 현재 상태에서 계속하려면 후속 메시지를 보내 주세요.',
    'zh-CN': '本轮未能安全完成项目任务。现有更改已保留；请发送后续消息，从当前状态继续。',
    'zh-TW': '本回合未能安全完成專案工作。現有變更已保留；請傳送後續訊息，從目前狀態繼續。'
  };
  return replies[language ?? 'en'];
}

interface Flight {
  turnId: string;
  abort: AbortController;
  warmup: boolean;
}
const flights = new Map<string, Flight>();

export function webProviderFlightTurnId(sessionId: string): string | undefined {
  return flights.get(sessionId)?.turnId;
}

/** A provider-side chat preparation is real work for delivery ordering, but it is not a user turn to expose as Stop/Thinking. */
export function webProviderAuthoredFlightTurnId(sessionId: string): string | undefined {
  const flight = flights.get(sessionId);
  return flight && !flight.warmup ? flight.turnId : undefined;
}

export function configureBrowserChatForTests(options: {
  complete?: (text: string, signal?: AbortSignal, options?: {
    fresh?: boolean;
    uploadOnly?: boolean;
    removeOnly?: boolean;
    attachments?: ProviderPageAttachmentSource[];
    attachmentTargets?: ProviderPageAttachment[];
    preparedAttachmentPage?: boolean;
  }) => Promise<{ text: string; attachmentUploaded?: boolean; attachmentRemoved?: boolean }>;
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

function isDeepseekAttachmentStageUnavailable(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(DEEPSEEK_ATTACHMENT_STAGE_UNAVAILABLE);
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
  if (parseWebChatTools(text).length > 0 || incompleteWebChatTool(text)) return false;
  const lines = text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim().split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !/^```(?:[\w+-]+)?$/.test(line));
  if (lines.length !== 1) return false;
  let reply = lines[0]!.replace(/^(?:>\s*)+/, '').replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '').trim();
  reply = reply.replace(/[.!。！?？]+$/, '').trim();
  const wrappers: Array<[string, string]> = [['**', '**'], ['__', '__'], ['~~', '~~'], ['`', '`'], ['*', '*'], ['_', '_'], ['“', '”'], ['\"', '\"'], ["'", "'"]];
  for (const [open, close] of wrappers) {
    if (reply.startsWith(open) && reply.endsWith(close) && reply.length > open.length + close.length) {
      reply = reply.slice(open.length, -close.length).trim();
      break;
    }
  }
  reply = reply.replace(/[.!。！?？]+$/, '').trim();
  return reply === WEB_BOOTSTRAP_ACK || reply === LEGACY_WEB_BOOTSTRAP_ACK;
}

function confirmsContextReply(text: string, expectedWords: readonly string[]): boolean {
  // Remove unsupported provider-internal markup before reading the proof. Supported
  // NeuraFlok calls still invalidate readiness and are never executed here.
  return parseWebChatTools(text).length === 0 &&
    confirmsWebProviderContext(stripWebChatTools(text), expectedWords);
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
    'If any requested deliverable or verification is missing, continue working with the available tools now. Preserve successful work, avoid repeating completed edits, and do not stop at a status report. If everything is complete, give a concise, natural, direct final response that answers only the user’s request, in the configured language. Include concrete verification evidence only when it directly answers the request. Never claim an unverified result.'
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
  const confirmed = !!reply && confirmsContextReply(reply.text, check.expectedWords);
  if (!confirmed) {
    if (provider !== 'deepseek') throw new Error(`${WEB_PROVIDERS[provider].label} did not confirm this chat's previous context. No message was sent.`);
    const replay = replayWebProviderTranscript(priorMessages, check.prompt, 96_000);
    if (!replay) throw new Error('DeepSeek could not confirm this chat context, and no saved transcript is available to restore it. No message was sent.');

    const setup = await prepareWebProviderBootstrap(entry, sessionId, system);
    const setupReply = await requestReadinessComplete(provider, conversationId, setup, signal, deadline, { fresh: true });
    if (!validBootstrapReply(setupReply.text)) {
      throw new Error('DeepSeek did not confirm the restored chat context. No message was sent.');
    }
    reply = await requestReadinessComplete(provider, conversationId, replay, signal, deadline);
    if (!confirmsContextReply(reply.text, check.expectedWords)) {
      // A restored transcript can contain stale provider-specific tool syntax.
      // Give DeepSeek one clean handshake retry before leaving the user's turn queued.
      const retryPrompt = [
        check.prompt,
        'RECOVERY HANDSHAKE RETRY: The previous reply did not complete this hidden check.',
        `Do not answer prior tasks or call tools. Reply with exactly ${WEB_BOOTSTRAP_ACK} on the first line and, if asked above, copy the requested words from the restored transcript on the second line.`
      ].join('\n');
      reply = await requestReadinessComplete(provider, conversationId, retryPrompt, signal, deadline);
    }
    if (!confirmsContextReply(reply.text, check.expectedWords)) {
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
    activeNow: false,
    ...(entry.warmup ? { internalWarmup: true as const } : {})
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
  let pendingPlan = projectChat ? await readProjectPlanState(sessionId) : null;
  let planStage: ProjectPlanStage = !projectChat ? null : entry.projectPlanPhase === 'draft'
    ? 'draft'
    : pendingPlan ? 'review' : null;
  let projectPlanReadOnly = planStage !== null;
  const conversationId = resolveConversation(provider, entry, session?.conversationId ?? null);
  const deepseekProviderAttachments = provider === 'deepseek' ? (entry.attachments ?? []).filter(file =>
    isDeepseekDirectUpload(file.name, file.mimeType)) : [];
  let preparedFreshAttachmentPage = deepseekProviderAttachments.length > 0 &&
    deepseekProviderAttachments.every(file => wasProviderAttachmentPreuploaded(conversationId, file.id)) &&
    hasFreshProviderAttachmentSession(sessionId, conversationId);
  const registrar = createBrowserChatToolRegistrar();
  const guideCtx = await getBrowserChatGuideContext(sessionId);
  const allTools = advertisedBrowserChatTools(registrar);
  const planTools = allTools.filter(tool => (WEB_CHAT_READ_ONLY_TOOLS as readonly string[]).includes(tool.name));
  const planReviewTools = pendingPlan ? [...planTools, ...WEB_CHAT_PLAN_DECISION_TOOLS] : planTools;
  if (projectPlanReadOnly && (!guideCtx.project || !planTools.some(tool => tool.name === 'read'))) {
    throw new Error('Plan mode needs a readable project folder and file-reading permission. No message was sent.');
  }
  let reminder = !projectChat ? '' : projectPlanReadOnly
    ? 'Only read or search relevant project files. Do not edit, run commands, or use other tools. Answer the current request and wait for explicit plan approval before making changes.'
    : webChatRoundReminder(guideCtx);
  let system = !projectChat ? webPlainChatInstructions(guideCtx.language)
    : projectPlanReadOnly ? webProjectPlanToolGuide(planStage === 'review' ? planReviewTools : planTools, guideCtx)
      : webToolGuide(allTools, guideCtx);
  const prior = await readWebProviderThread(sessionId, conversationId, provider);
  const hasProviderTranscript = Boolean(prior?.messages.some(message => message.role !== 'system'));
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
  const opening = !preparedFreshAttachmentPage && isOpening(messages) && !hasProviderTranscript && (!hasPriorAuthoredContext ||
    (!session?.conversationId && !entry.conversationId) || session?.origin?.kind === 'worker' || openingWarmup);
  let preparedText = '';
  let bootstrap: string | null = null;
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
  flights.set(sessionId, { turnId, abort, warmup: entry.warmup === true });
  const now = () => Date.now();
  const internalWarmup = entry.warmup ? { internalWarmup: true as const } : {};
  let acceptedInput: InputEntry | undefined;
  let attachmentUploadConfirmed = false;
  const attachmentUploadTracked = deepseekProviderAttachments.length > 0 &&
    !deepseekProviderAttachments.every(file => wasProviderAttachmentPreuploaded(ownedConversation, file.id));
  try {
    acceptedInput = (await listInputs()).find(row => row.id === entry.id && row.state === 'sent');
    if (!acceptedInput) throw new Error(`NEURAFLOK could not verify the accepted ${WEB_PROVIDERS[provider].label} message.`);
    if (!entry.warmup) {
      await recordDeliveredInput(acceptedInput, undefined, { turnId, attachmentUpload: attachmentUploadTracked });
    }
    await observe(ownedConversation, [{ kind: 'turn_start', time: now(), turnId, ...internalWarmup }]);
    if (!entry.warmup) await noteLocalAgentTurnStarted(ownedConversation, now());
    preparedText = entry.warmup ? '' : await prepareLocalProviderPrompt(entry, sessionId, {
      allowImageAttachments: provider === 'deepseek',
      allowPdfAttachments: provider === 'deepseek',
      allowOfficeAttachments: provider === 'deepseek',
      historySummary: opening || !hasPriorAuthoredContext ? undefined : historySummary,
      projectPlanPhase: planStage === 'draft' ? 'draft' : undefined,
      projectPlanContext: planStage && planStage !== 'draft'
        ? projectPlanContext(pendingPlan ?? { request: entry.text, plan: '' }, planStage)
        : undefined
    });
    bootstrap = opening ? await prepareWebProviderBootstrap(entry, sessionId, system) : null;
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
          activeNow: false,
          ...internalWarmup
        }, { kind: 'turn_end', time: now(), turnId, outcome: 'completed', final: true, ...internalWarmup }]);
        return turnId;
      }
    }
    if (entry.warmup) {
      await acknowledgeWarmup(entry, provider, sessionId, ownedConversation, system, priorMessages, abort.signal,
        warmupDeadline ?? Date.now() + webChatReadinessMaxDurationMs, turnId);
      await observe(ownedConversation, [{ kind: 'turn_end', time: now(), turnId, outcome: 'completed', final: true, ...internalWarmup }]);
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
    let unwrappedPatchRetries = 0;
    let unwrappedPatchFinalizationRequested = false;
    let planReplyUsable = true;
    let assistantMessageId = randomUUID();
    let lastObservedClean = '';
    let idleRecoveries = 0;
    let plainTextRetries = 0;
    let prohibitedPlanRetries = 0;
    let planDecisionRetries = 0;
    let planDecisionAllowed = true;
    let executedToolCalls = 0;
    let reviewedToolCalls = 0;
    let pageAttachments: ProviderPageAttachmentSource[] = [];
    const unsubscribeProgress = onProviderPageProgress(async (progress) => {
      if (progress.conversationId !== ownedConversation) return;
      if (progress.attachmentsUploaded && attachmentUploadTracked && acceptedInput && !attachmentUploadConfirmed) {
        attachmentUploadConfirmed = true;
        pageAttachments = [];
        await updateDeliveredInputAttachmentStatus(acceptedInput, 'ready');
      }
      const clean = stripWebChatTools(progress.text);
      if (projectChat && containsUnwrappedApplyPatch(clean)) {
        if (lastObservedClean) {
          lastObservedClean = '';
          await observe(ownedConversation, [{
            kind: 'assistant_message',
            time: now(),
            messageId: assistantMessageId,
            text: '',
            turnId,
            final: false,
            state: 'streaming',
            activeNow: true
          }]);
        }
        return;
      }
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
      pageAttachments = await providerPageAttachments(acceptedInput, provider, false, ownedConversation);
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        abort.signal.throwIfAborted();
        const live = createBrowserChatToolRegistrar();
        let completion: Awaited<ReturnType<typeof requestProviderPageComplete>>;
        let requestText = pageText;
        let contextRecoveryAttempted = false;
        while (true) {
          abort.signal.throwIfAborted();
          try {
            const offerOptions = pageAttachments.length || preparedFreshAttachmentPage
              ? {
                ...(pageAttachments.length ? { attachments: pageAttachments } : {}),
                ...(preparedFreshAttachmentPage ? { preparedAttachmentPage: true } : {})
              }
              : undefined;
            completion = await requestProviderPageComplete(provider, ownedConversation, requestText, abort.signal, offerOptions);
            markProviderAttachmentSessionPrepared(sessionId, ownedConversation);
            pageAttachments = [];
            if (attachmentUploadTracked && acceptedInput && !attachmentUploadConfirmed) {
              attachmentUploadConfirmed = true;
              await updateDeliveredInputAttachmentStatus(acceptedInput, 'ready');
            }
            break;
          } catch (error) {
            const canContinue = provider === 'deepseek' && !entry.warmup &&
              getConfig().ui.autoContinue !== false && idleRecoveries < MAX_DEEPSEEK_IDLE_RECOVERIES &&
              isVerifiedIdleProviderFailure(error);
            if (canContinue) {
              idleRecoveries++;
              if (attachmentUploadConfirmed) pageAttachments = [];
              requestText = `${recoveryMessage(entry.text)}\n\n${reminder}`;
              thread.messages = trimWebProviderThread([...thread.messages, { role: 'user', content: requestText }]);
              await persistWebProviderThread(thread, provider);
              continue;
            }
            const attachmentStageUnavailable = isDeepseekAttachmentStageUnavailable(error);
            if (attachmentStageUnavailable) {
              if (provider !== 'deepseek' || contextRecoveryAttempted || round !== 0) throw error;
              // Losing a composer receipt does not mean the provider chat or
              // its history is lost. Keep this exact chat, clear its stale
              // local receipt in the page, and retry once with the original
              // attachment bytes before sending the same request.
              const restoredAttachments = await providerPageAttachments(acceptedInput ?? entry, provider, true, ownedConversation);
              if (!restoredAttachments.length) {
                throw new Error('DeepSeek lost the staged attachment and NeuraFlok could not restore its local file. No message was sent.');
              }
              contextRecoveryAttempted = true;
              preparedFreshAttachmentPage = false;
              pageAttachments = restoredAttachments;
              continue;
            }
            if (provider !== 'deepseek' || contextRecoveryAttempted || round !== 0 ||
                !isDeepseekContextUnavailable(error)) throw error;
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
            markProviderAttachmentSessionPrepared(sessionId, ownedConversation);
            contextRecoveryAttempted = true;
            preparedFreshAttachmentPage = false;
            // Rebuilding a lost provider page also loses its unsent composer
            // attachments. Replay the staged originals on the recovered page.
            pageAttachments = await providerPageAttachments(acceptedInput ?? entry, provider, true, ownedConversation);
            requestText = replay ?? requestText;
          }
        }
        const raw = completion.text ?? '';
        const calls = parseWebChatTools(raw);
        const assistantContent = stripWebChatTools(raw);
        const decisionCalls = calls.filter(call => isWebChatPlanDecisionToolName(call.function.name));
        if (decisionCalls.length) {
          const decisionCall = decisionCalls[0]!;
          const candidate = planDecisionAllowed && decisionCalls.length === 1 && calls.length === 1 && planStage === 'review' && pendingPlan
            ? projectPlanDecisionFromTool(decisionCall.function.name) : null;
          const revision = candidate === 'revise' ? projectPlanRevisionFromTool(decisionCall.function.arguments) : null;
          const decision = candidate && (candidate === 'revise' ? revision !== null : hasEmptyProjectPlanDecisionArguments(decisionCall.function.arguments))
            ? candidate : null;
          const result = !decision
            ? 'No decision or project action was applied. A plan decision is valid only as one workflow decision call with empty arguments and no other tool calls. Reassess the latest user-authored message by its meaning; if it is uncertain, answer or ask a concise clarification without changing files.'
            : decision === 'approved'
              ? 'Approval confirmed. The user’s latest message authorizes the pending plan. No project action has run yet; continue in the next turn using the updated workflow instructions.'
              : decision === 'cancel'
                ? 'Cancellation confirmed. The user’s latest message cancels the pending plan. No project action has run.'
                : 'The revised plan was saved for review. No project action has run.';
          thread.messages = trimWebProviderThread([...thread.messages,
            { role: 'assistant', ...(assistantContent ? { content: assistantContent } : {}), tool_calls: calls },
            ...calls.map(call => ({ role: 'tool' as const, tool_call_id: call.id,
              content: isWebChatPlanDecisionToolName(call.function.name) ? result : 'No tool was executed because a plan decision cannot be combined with other tool calls.' }))
          ]);
          if (!decision) {
            await persistWebProviderThread(thread, provider);
            if (planDecisionAllowed && planDecisionRetries++ === 0 && planStage === 'review' && pendingPlan) {
              pageText = `${formatWebChatResult(decisionCall.function.name, result)}\n\n${projectPlanContext(pendingPlan, 'review')}\n\n${webProjectPlanToolGuide(planReviewTools, guideCtx)}`;
              continue;
            }
            assistantText = assistantContent || emptyAssistantReply(guideCtx.language);
            break;
          }
          if (decision === 'approved') {
            planStage = 'approved';
            projectPlanReadOnly = false;
            reminder = webChatRoundReminder(guideCtx);
            system = `${webToolGuide(allTools, guideCtx)}\n\n${projectPlanContext(pendingPlan!, 'approved')}`;
          } else if (decision === 'cancel') {
            planStage = 'cancel';
            system = `${webPlainChatInstructions(guideCtx.language)}\n\n${projectPlanContext(pendingPlan!, 'cancel')}`;
          } else {
            const revisedPlanState = { request: pendingPlan!.request, plan: revision!, updatedAt: now() };
            await updateProjectPlanState(sessionId, ownedConversation, revisedPlanState, now());
            pendingPlan = revisedPlanState;
            planDecisionAllowed = false;
            system = `${webProjectPlanToolGuide(planTools, guideCtx)}\n\nOriginal request:\n${revisedPlanState.request}\n\nRevised plan:\n${revisedPlanState.plan}\n\nThe requested revision has been saved. In this reply, present the updated plan and wait for the user. Do not call workflow decision tools or make project changes.`;
          }
          if (decision === 'cancel') await clearProjectPlanState(sessionId, ownedConversation);
          thread.messages = withWebProviderSystem(thread.messages, system);
          await persistWebProviderThread(thread, provider);
          pageText = `${formatWebChatResult(decisionCall.function.name, result)}\n\n${system}\n\n${decision === 'approved'
            ? 'Continue the approved work now. Start with the next required project tool call; do not ask for approval again.'
            : decision === 'cancel'
              ? 'Reply briefly and naturally to acknowledge that the plan was cancelled. Do not call tools.'
              : 'Present the revised plan naturally, then wait for the user’s decision. Do not call tools in this reply.'}`;
          continue;
        }
        if (!projectChat && (calls.length || incompleteWebChatTool(raw))) {
          if (plainTextRetries++ === 0) {
            pageText = 'Answer the user\'s current message directly in natural text. This is a normal chat with no file or command tools. Do not emit tool syntax.';
            continue;
          }
          assistantText = assistantContent || emptyAssistantReply(guideCtx.language);
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
          : { role: 'assistant', content: assistantContent }]);
        await persistWebProviderThread(thread, provider);
        if (!calls.length) {
          if (projectChat && containsUnwrappedApplyPatch(raw)) {
            // Keep malformed diffs out of both the user timeline and future
            // reconstructed prompts. The provider already saw this output;
            // record only that it was suppressed and ask it to inspect the
            // current project before trying the remaining work again.
            const previous = thread.messages.at(-1);
            if (previous?.role === 'assistant' && previous.content === assistantContent) {
              previous.content = '[NeuraFlok suppressed an unwrapped patch response; no changes from that text were applied.]';
            }
            if (unwrappedPatchRetries < 2) {
              unwrappedPatchRetries++;
              pageText = projectPlanReadOnly
                ? 'RECOVERY: The previous assistant response exposed raw apply_patch diff text. That text was not executed. Do not change files while the plan is read-only. Inspect the project with read/find if needed, then provide only a concise, natural plan in the configured reply language. Do not print a patch or tool transcript.'
                : 'RECOVERY: The previous assistant response exposed raw apply_patch diff text instead of an executable tool call. That text was not executed. Inspect the current project state first; do not repeat changes that are already present. If work remains, use complete neuraflok-tool calls for read/apply_patch/commands as required. When finished, answer naturally and directly in the configured reply language; never print raw patch syntax.';
              thread.messages = trimWebProviderThread([...thread.messages, { role: 'user', content: pageText }]);
              await persistWebProviderThread(thread, provider);
              if (lastObservedClean) {
                lastObservedClean = '';
                await observe(ownedConversation, [{
                  kind: 'assistant_message',
                  time: now(),
                  messageId: assistantMessageId,
                  text: '',
                  turnId,
                  final: false,
                  state: 'streaming',
                  activeNow: true
                }]);
              }
              continue;
            }
            if (!unwrappedPatchFinalizationRequested) {
              unwrappedPatchFinalizationRequested = true;
              pageText = 'FINAL RECOVERY: Do not emit tools, patch syntax, or code. Give a brief, natural status in the configured reply language. State what is complete and, if project work remains, say clearly that it is not complete and can be continued. Do not invent verification.';
              thread.messages = trimWebProviderThread([...thread.messages, { role: 'user', content: pageText }]);
              await persistWebProviderThread(thread, provider);
              continue;
            }
            assistantText = unwrappedPatchRecoveryFailure(guideCtx.language);
            planReplyUsable = false;
            break;
          }
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
      if (!assistantText) assistantText = emptyAssistantReply(guideCtx.language);
      const usablePlanReply = planReplyUsable && assistantText !== emptyAssistantReply(guideCtx.language) &&
        !/could not prepare a safe read-only plan/i.test(assistantText);
      if (projectChat && usablePlanReply) {
        if (planStage === 'draft') {
          await updateProjectPlanState(sessionId, ownedConversation, { request: entry.text, plan: assistantText }, now());
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
      if (acceptedInput?.attachments?.length) retirePreuploadedProviderAttachments(ownedConversation, acceptedInput.attachments);
      logInfo(`${provider}: session ${sessionId} completed turn ${turnId}`);
      return turnId;
    } finally {
      unsubscribeProgress();
    }
  } catch (error) {
    const aborted = abort.signal.aborted || (error instanceof Error && error.name === 'AbortError');
    if (attachmentUploadTracked && acceptedInput && !attachmentUploadConfirmed) {
      await updateDeliveredInputAttachmentStatus(acceptedInput, 'failed').catch(() => false);
    }
    if (aborted) {
      await observe(ownedConversation, [
        { kind: 'turn_end', time: now(), turnId, outcome: 'stopped', detail: 'Stop requested', ...internalWarmup }
      ]).catch(() => undefined);
      return null;
    }
    const detail = (error as Error).message.replace(/^DEEPSEEK_(?:CONTEXT_UNAVAILABLE|ATTACHMENT_STAGE_UNAVAILABLE):\s*/, '').slice(0, 500);
    logWarn(`${provider}: session ${sessionId} failed: ${detail}`);
    await observe(ownedConversation, [
      { kind: 'chat_error', time: now(), turnId, inputId: entry.id, text: detail, recoverable: false, ...internalWarmup },
      { kind: 'turn_end', time: now(), turnId, outcome: 'failed', detail, ...internalWarmup }
    ]).catch(() => undefined);
    return null;
  } finally {
    const current = flights.get(sessionId);
    if (current?.turnId === turnId) flights.delete(sessionId);
  }
}

