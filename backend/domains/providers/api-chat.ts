/** OpenAI-compatible API executor for ordinary NEURAFLOK chats. Credentials stay in the main process. */
import { randomUUID } from 'node:crypto';
import {
  WEB_CHAT_CORE_TOOLS,
  apiConversationId,
  isApiConversationId,
  openaiTools,
} from '../../../contracts/chat-protocol.js';
import { getConfig, effectiveCapabilities } from '../../infrastructure/settings/config.js';
import { apiProviderKey, configuredApiEndpoint, resolveApiBaseUrl } from './api-settings.js';
import { completeApiChat, type ApiChatSettings, type ApiMessage, type ApiToolCall } from './api-chat-protocol.js';
import { persistApiThread, readApiThread, trimApiThread, type ApiThread } from './api-chat-thread-store.js';
import { createRegistrar, type ToolContext, type ToolResult } from '../../infrastructure/tool-gateway/protocol/kernel.js';
import { registerCoreTools } from '../../infrastructure/tool-gateway/protocol/tools-core.js';
import { withManagedSkills } from '../skills/access/managed-roots.js';
import { observeRequestCorrelation } from '../sessions/history/correlation.js';
import { recordChatObservations } from '../sessions/history/recorder.js';
import { acceptLocalExecutorInput, listInputs, type InputEntry } from '../sessions/input/input.js';
import { recordDeliveredInput } from '../sessions/input/input-history.js';
import {
  getSession,
  observeSessionModel,
} from '../sessions/history/store.js';
import { getSessionProject } from '../workspace/projects.js';
import { prepareLocalProviderPrompt } from '../sessions/input/provider-context.js';
import { normalizeInputAttachments } from '../sessions/input/attachments/index.js';
import type { InputImage } from '../../../contracts/input.js';
import { replyLanguageInstruction } from '../../../contracts/ui-language.js';
import { logInfo, logWarn } from '../../infrastructure/settings/logger.js';
import { noteLocalAgentTurnStarted } from '../automation/local-agent-observations.js';

const MAX_ROUNDS = 24;
const MAX_TOOL_RESULT_CHARS = 32_000;
const ALLOWED_TOOLS = new Set<string>([...WEB_CHAT_CORE_TOOLS, 'agents']);
interface Flight { turnId: string; controller: AbortController; }
const flights = new Map<string, Flight>();

export function resetApiChatForTests(): void {
  for (const flight of flights.values()) flight.controller.abort(new Error('test reset'));
  flights.clear();
}

/** Validate and freeze endpoint, model, and key for one turn. A custom local endpoint may be keyless. */
async function resolveApiChatSettings(sessionId?: string): Promise<ApiChatSettings> {
  const config = getConfig();
  const session = sessionId ? await getSession(sessionId).catch(() => null) : null;
  const savedModel = session?.conversationId && isApiConversationId(session.conversationId) &&
    session.selectedModel?.conversationId === session.conversationId && session.selectedModel.apiProvider
    ? session.selectedModel : null;
  const endpoint = savedModel?.apiProvider ?? configuredApiEndpoint();
  const model = (savedModel?.model ?? config.goal.model)?.trim();
  if (!model) throw new Error('Choose an API model in Settings before sending.');
  if (endpoint.kind === 'custom' && !endpoint.baseUrl.trim()) {
    throw new Error('Add the API endpoint URL in Settings before sending.');
  }
  const baseUrl = resolveApiBaseUrl(endpoint);
  const key = await apiProviderKey(endpoint.kind);
  if (endpoint.kind !== 'custom' && !key) {
    throw new Error(`Add your ${endpoint.kind === 'openai' ? 'OpenAI' : 'OpenRouter'} key in Manage models before sending.`);
  }
  return { endpoint, baseUrl, model, key };
}

/** Validate settings before a durable input is accepted. */
export async function assertApiChatReady(sessionId?: string): Promise<void> {
  await resolveApiChatSettings(sessionId);
}

export function apiChatFlightTurnId(sessionId: string): string | undefined {
  return flights.get(sessionId)?.turnId;
}

export function abortApiChatSession(sessionId: string, expectedTurnId: string): boolean {
  const flight = flights.get(sessionId);
  if (!flight || flight.turnId !== expectedTurnId) return false;
  flight.controller.abort(new Error('Stop requested'));
  flights.delete(sessionId);
  return true;
}

function toolContext(): ToolContext {
  const config = getConfig();
  const caps = effectiveCapabilities(config);
  return withManagedSkills({
    roots: config.roots,
    caps,
    exposedCaps: caps,
    readOnly: config.readOnly,
    privacyScreenshots: config.ui.privacyScreenshots,
    sessionTools: config.sessions.record,
    agentTools: config.multiAgent.enabled,
    exposedAgentTools: true,
    exposedFinishTool: false,
    exposedFind: !caps.command && caps.search
  });
}

function registrar() {
  const value = createRegistrar(null, toolContext(), 'core');
  registerCoreTools(value);
  return value;
}

function guide(declarations: ReturnType<ReturnType<typeof registrar>['declarations']>, roots: string[], project?: string): string {
  const toolNames = declarations.filter(row => ALLOWED_TOOLS.has(row.name)).map(row => row.name);
  return [
    'You are the assistant inside NEURAFLOK, a local workspace for coding and research.',
    'Use only the listed tools when you need to inspect or change approved files. A tool result is the evidence that an action happened; never claim a change before a successful result.',
    'Tool calls run on this computer under the user’s current permissions. Do not ask for or infer access outside the approved folders.',
    replyLanguageInstruction(getConfig().ui.language),
    `Approved roots: ${roots.length ? roots.join(', ') : 'none'}.`,
    project ? `Selected project directory: ${project}. Keep project work there.` : '',
    `Available local tools: ${toolNames.join(', ') || 'none'}.`
  ].filter(Boolean).join('\n\n');
}

function resultText(result: ToolResult): string {
  let text = result.content.flatMap(part => part.type === 'text' ? [part.text] : [`[image omitted: ${part.mimeType}]`]).join('\n').trim();
  if (!text && result.structuredContent) {
    try { text = JSON.stringify(result.structuredContent); } catch { text = ''; }
  }
  if (!text) text = result.isError ? 'tool error' : 'ok';
  return text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n… truncated` : text;
}

function parseArgs(source: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try { return { ok: true, value: JSON.parse(source) }; }
  catch (error) { return { ok: false, error: (error as Error).message.slice(0, 300) }; }
}

async function invokeTool(
  value: ReturnType<typeof registrar>, call: ApiToolCall, requestId: string,
  conversationId: string, sessionId: string
): Promise<string> {
  const name = call.function.name;
  if (!ALLOWED_TOOLS.has(name) || !value.registered().includes(name)) return `UNKNOWN_TOOL: ${name} is not available in this executor.`;
  const parsed = parseArgs(call.function.arguments);
  if (!parsed.ok) return `INVALID_ARGUMENTS: ${parsed.error}`;
  const session = await getSession(sessionId);
  if (!session || session.conversationId !== conversationId) throw new Error('This API response belongs to a session that is no longer active.');
  observeRequestCorrelation({ requestId, conversationId, sessionId, messageId: call.id, tool: name, observedAt: Date.now() });
  return resultText(await value.invoke(name, parsed.value, requestId));
}

async function userImages(entry: InputEntry): Promise<InputImage[]> {
  const fileImages = (entry.attachments ?? []).filter(file => file.mimeType.startsWith('image/'));
  const total = (entry.images?.length ?? 0) + fileImages.length;
  if (total > 10) throw new Error('Attach up to 10 images to an API message.');
  const normalized = fileImages.length ? await normalizeInputAttachments(fileImages) : [];
  return [...entry.images ?? [], ...normalized];
}

function apiUserMessage(text: string, images: InputImage[]): ApiMessage {
  if (!images.length) return { role: 'user', content: text };
  return { role: 'user', content: [
    { type: 'text', text },
    ...images.map(image => ({ type: 'image_url' as const, image_url: { url: image.dataUrl } }))
  ] };
}

async function observe(conversationId: string, items: Parameters<typeof recordChatObservations>[1]): Promise<void> {
  await recordChatObservations(conversationId, items);
}

function isOpening(messages: ApiMessage[]): boolean { return messages.every(row => row.role === 'system'); }

/** Persist a local thread, call the configured API, and run only the approved in-process Core tools. */
export async function runApiProviderInput(entry: InputEntry, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted();
  const sessionId = entry.sessionId ?? entry.id;
  const session = await getSession(sessionId);
  const conversationId = session?.conversationId ?? apiConversationId(randomUUID());
  if (session?.conversationId && !conversationId.startsWith('ap-')) {
    throw new Error('This session belongs to a browser provider. Start a new chat to use the API executor.');
  }
  const settings = await resolveApiChatSettings(sessionId);
  const registrarValue = registrar();
  const project = await getSessionProject(sessionId).catch(() => null);
  const roots = getConfig().roots.map(root => `/${root.name}`);
  if (!roots.includes('/skills')) roots.push('/skills');
  const system = guide(registrarValue.declarations(), roots, project?.virtual);
  const prior = await readApiThread(sessionId, conversationId);
  let messages = trimApiThread(prior?.messages ?? [{ role: 'system', content: system }]);
  messages = [{ role: 'system', content: system }, ...messages.filter(row => row.role !== 'system')];
  const opening = isOpening(messages);
  const preparedText = await prepareLocalProviderPrompt(entry, sessionId, opening, { allowImageAttachments: true });
  const images = await userImages(entry);
  const userMessageId = randomUUID();
  const turnId = randomUUID();
  signal?.throwIfAborted();
  if (!await acceptLocalExecutorInput(entry.id, conversationId, userMessageId)) {
    throw new Error('NEURAFLOK could not accept this API message into the local session.');
  }
  await observeSessionModel(sessionId, conversationId, settings.model, Date.now(), undefined, {
    kind: settings.endpoint.kind,
    baseUrl: settings.endpoint.baseUrl
  });
  const abort = new AbortController();
  const onAbort = () => abort.abort(signal?.reason);
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  const API_ROUND_WAIT_MS = 600_000;
  const armRoundWait = () => {
    const next = setTimeout(() => abort.abort(new Error('API request timed out after 10 minutes without a completed round.')), API_ROUND_WAIT_MS);
    next.unref?.();
    return next;
  };
  let timer = armRoundWait();
  flights.set(sessionId, { turnId, controller: abort });
  const now = () => Date.now();
  try {
    const bound = await getSession(sessionId);
    if (!bound?.conversationId || bound.conversationId !== conversationId) throw new Error('The API session binding changed before the request started.');
    const accepted = (await listInputs()).find(row => row.id === entry.id && row.state === 'sent');
    if (!accepted) throw new Error('NEURAFLOK could not verify the accepted API message.');
    await recordDeliveredInput(accepted, undefined, { turnId, model: settings.model, images });
    await observe(conversationId, [{ kind: 'turn_start', time: now(), turnId }]);
    await noteLocalAgentTurnStarted(conversationId, now());
    const modelUser = apiUserMessage(preparedText, images);
    messages = trimApiThread([...messages, { role: 'user', content: preparedText }]);
    const currentUserIndex = messages.length - 1;
    const thread: ApiThread = { version: 1, sessionId, conversationId, messages, updatedAt: now() };
    await persistApiThread(thread);
    const declarations = openaiTools(registrarValue.declarations().filter(row => ALLOWED_TOOLS.has(row.name)));
    let assistantText = '';
    for (let round = 0; round < MAX_ROUNDS; round++) {
      abort.signal.throwIfAborted();
      clearTimeout(timer);
      timer = armRoundWait();
      const current = await getSession(sessionId);
      if (!current || current.conversationId !== conversationId) throw new Error('This API response belongs to a session that is no longer active.');
      const requestMessages = [...thread.messages];
      // The current user message includes images only for this request; data URLs are not persisted.
      requestMessages[currentUserIndex] = modelUser;
      const completion = await completeApiChat(requestMessages, declarations, settings, abort.signal);
      abort.signal.throwIfAborted();
      thread.messages = trimApiThread([...thread.messages, completion.message]);
      await persistApiThread(thread);
      const calls = completion.message.tool_calls ?? [];
      if (!calls.length) {
        assistantText = typeof completion.message.content === 'string' ? completion.message.content.trim() : '';
        break;
      }
      const requestId = `apireq-${randomUUID()}`;
      const live = registrar();
      for (const call of calls) {
        abort.signal.throwIfAborted();
        const content = await invokeTool(live, call, requestId, conversationId, sessionId);
        thread.messages = trimApiThread([...thread.messages, { role: 'tool', tool_call_id: call.id, content }]);
        await persistApiThread(thread);
      }
      if (round === MAX_ROUNDS - 1) assistantText = 'I ran the available tools, but the API did not finish a final response within the tool limit.';
    }
    if (!assistantText) assistantText = '(The API returned no text.)';
    const latest = await getSession(sessionId);
    if (!latest || latest.conversationId !== conversationId) throw new Error('This API response belongs to a session that is no longer active.');
    await observe(conversationId, [
      { kind: 'assistant_message', time: now(), messageId: randomUUID(), text: assistantText, turnId, final: true, state: 'final', activeNow: true },
      { kind: 'turn_end', time: now(), turnId, outcome: 'completed', final: true }
    ]);
    logInfo(`API provider: session ${sessionId} completed turn ${turnId}`);
    return turnId;
  } catch (error) {
    const current = await getSession(sessionId).catch(() => null);
    if (!current || current.conversationId !== conversationId) {
      logWarn(`API provider: ignored stale response for session ${sessionId}`);
      return null;
    }
    const aborted = abort.signal.aborted || (error instanceof Error && error.name === 'AbortError');
    if (aborted) {
      await observe(conversationId, [{ kind: 'turn_end', time: now(), turnId, outcome: 'stopped', detail: 'Stop requested' }]).catch(() => undefined);
      return null;
    }
    const detail = (error as Error).message.slice(0, 500);
    logWarn(`API provider: session ${sessionId} failed: ${detail}`);
    await observe(conversationId, [
      { kind: 'chat_error', time: now(), turnId, text: detail, recoverable: false },
      { kind: 'turn_end', time: now(), turnId, outcome: 'failed', detail }
    ]).catch(() => undefined);
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (flights.get(sessionId)?.turnId === turnId) flights.delete(sessionId);
  }
}
