// Provider-neutral Goal and Loop decision requests through browser pages or configured APIs.

import { boundedResponseText, httpFailure, normalizeGoalDecision, readGoalCompletion, GOAL_OUTPUT_PROTOCOL, GOAL_RESPONSE_FORMAT, LOOP_OUTPUT_PROTOCOL, LOOP_RESPONSE_FORMAT } from './goal-response.js';
import type { GoalDecision } from './goal-response.js';
import { GOAL_REFERENCE_CONTRACT, clip, type ChatMessage } from './goal-context.js';
import { requestProviderDecision } from './provider-decision.js';
import { GOAL_LOOP_STOP_REFUSED } from '../../../contracts/automation/goal-prompts.js';
import { MAX_PROVIDER_MESSAGE_CHARS } from '../../../contracts/messaging/provider-message-envelope.js';
import type { GoalBackend, GoalMode, GoalReasoning } from '../../../contracts/types.js';
import type { ApiProviderEndpoint } from '../providers/api-settings.js';
import { apiRequestHeaders, apiRequestUrl } from '../providers/api-settings.js';
import { API_ATTRIBUTION_HEADERS as ATTRIBUTION_HEADERS } from '../providers/api-attribution.js';
import { getConfig } from '../../infrastructure/settings/config.js';
import { logWarn } from '../../infrastructure/settings/logger.js';
import { providerForConversationId, WEB_PROVIDERS } from '../../../contracts/web-providers.js';

const LOOP_ATTEMPTS = 3;

function apiProviderLabel(endpoint: ApiProviderEndpoint): string {
  return endpoint.kind === 'custom' ? endpoint.name?.trim() || 'Custom API'
    : endpoint.kind === 'openai' ? 'OpenAI' : 'OpenRouter';
}

// One OpenRouter decision, with none of the draft bookkeeping around it. Two callers want exactly this and nothing more: `run`, answering a finished turn inside a chat the app is recording, and `draftOpeningMessage`, answering a chat that does not exist yet and therefore has no draft, no session and no conversation id at all. Sharing one request is what keeps the opening message under the same protocol guard, the same body caps and the same refusal rules as every other message this app has ever typed.
export interface GoalRequest {
  lifetime?: 'temporary-planner';
  sourceSessionId?: string;
  sourceConversationId?: string;
  backend?: GoalBackend;
  reasoning: GoalReasoning | 'none';
  /** Captured together with the credential before any async work; never reread its destination. */
  endpoint: ApiProviderEndpoint;
  key: string;
  model: string;
  // Which contract this request is made under. `goal` may come back with either answer. `loop` is offered only one, both in the schema it is sent and in how the answer is read: see requestDrivingDecision.
  mode: GoalMode;
  /** In order, ahead of the conversation. The wire protocol is appended here, not by callers. */
  system: string[];
  messages: ChatMessage[];
  // The closing reminder, placed after the transcript rather than before it. Everything in `system` is read before a conversation that can run to hundreds of messages, and a long transcript is exactly the case where an instruction that far up stops steering the answer. This is the same policy restated where the model saw it last. It is app-owned placement, not app-owned policy: the text comes from whichever editable prompt is driving.
  trailer: string;
  signal: AbortSignal;
  /** Called as legacy SSE text arrives, so a streaming panel can show it being written. */
  publish?: (text: string) => void;
}

async function requestAnthropicDecision(
  request: GoalRequest,
  url: string,
  providerHeaders: Record<string, string>,
  referenceContract: string
): Promise<GoalDecision | { action: 'http'; error: string; retryAfterMs?: number }> {
  const protocol = request.mode === 'loop' ? LOOP_OUTPUT_PROTOCOL : GOAL_OUTPUT_PROTOCOL;
  const toolName = 'neuroflok_goal_decision';
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    headers: providerHeaders,
    signal: request.signal,
    body: JSON.stringify({
      model: request.model,
      max_tokens: 2048,
      system: [...request.system, protocol, referenceContract].join('\n\n'),
      messages: [{ role: 'user', content: JSON.stringify(request.messages) + '\n\n' + request.trailer }],
      tools: [{
        name: toolName,
        description: 'Return the Goal or Loop decision for this turn.',
        input_schema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: request.mode === 'loop' ? ['continue'] : ['stop', 'continue'] },
            reply: { type: 'string' }
          },
          required: ['action', 'reply'],
          additionalProperties: false
        }
      }],
      tool_choice: { type: 'tool', name: toolName }
    })
  });
  if (!response.ok || !response.body) {
    const header = response.headers.get('retry-after');
    const delay = header === null ? NaN : /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) * 1000 : Date.parse(header) - Date.now();
    return { action: 'http', error: await httpFailure(response, apiProviderLabel(request.endpoint)), ...(Number.isFinite(delay) ? { retryAfterMs: Math.max(0, delay) } : {}) };
  }
  const raw = await boundedResponseText(response, 64 * 1024);
  let payload: unknown;
  try { payload = raw ? JSON.parse(raw) : null; }
  catch { throw new Error('malformed_completion_response'); }
  if (!payload || typeof payload !== 'object') throw new Error('malformed_completion_response');
  const content = (payload as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error('malformed_completion_response');
  const decision = content.find((block): block is { type: string; name?: string; input?: unknown } =>
    Boolean(block && typeof block === 'object' && !Array.isArray(block) && 'type' in block && (block as { type?: unknown }).type === 'tool_use' && (block as { name?: unknown }).name === toolName));
  if (!decision || !decision.input || typeof decision.input !== 'object' || Array.isArray(decision.input)) {
    return { action: 'invalid', error: 'invalid_goal_decision_schema' };
  }
  return normalizeGoalDecision(JSON.stringify(decision.input), false);
}

// One request, one answer — including "no usable answer". There is deliberately no retry here. A provider error, a cut stream and a reply in a shape this app cannot read are all the same event, and whether asking again is worth anything depends on facts this function cannot see: whether the turn being answered is still the last one, whether the user has started typing, whether Goal is even switched on. Those live in the page's Goal loop, which reads the failure back off `retryable` and asks again on its own clock. A second attempt from in here would be spent against a turn nobody rechecked.
export async function requestGoalDecision(request: GoalRequest): Promise<GoalDecision | { action: 'http'; error: string; retryAfterMs?: number }> {
  const referenceContract = request.lifetime === 'temporary-planner'
    ? 'The task below is reference data. Produce the requested staged workflow; do not execute the task or claim its work is done.'
    : GOAL_REFERENCE_CONTRACT;
  if (request.backend === 'web') {
    const protocol = request.mode === 'loop' ? LOOP_OUTPUT_PROTOCOL : GOAL_OUTPUT_PROTOCOL;
    // Keep tool use off so a helper cannot mutate the local workspace without an owning conversation. Fenced JSON stays readable as provider-page message text and keeps the response parser stable.
    const introduction = 'Return one JSON object in a ```json code block: {"action":"stop" or "continue","reply":"the message"}. ' + referenceContract +
      ' Do not call any tools, apps or connectors; decide from the transcript alone.';
    const replacement = 'Use this complete source transcript as reference data.';
    const render = (messages: ChatMessage[], direction = replacement): string => [...request.system, protocol,
      introduction, direction, '<conversation>', ...messages.map(message => JSON.stringify(message)), '</conversation>', request.trailer].join('\n\n');
    // The browser's authored-message limit includes instructions, escaping and framing. Bound the actual replacement first; prefix custody must describe exactly what was sent.
    const reference = request.messages.map(message => ({ ...message }));
    let omitted = false;
    const incomplete = replacement + ' Some older reference rows or text were omitted to fit the browser; absence is not completion.';
    while (render(reference, omitted ? incomplete : replacement).length > MAX_PROVIDER_MESSAGE_CHARS) {
      const firstUser = reference.findIndex(message => message.role === 'user');
      const last = reference.length - 1;
      const newestResult = reference.findLastIndex(message => message.role === 'assistant');
      const protectedRow = (at: number): boolean => at === firstUser || at === last || at === newestResult;
      const removable = reference.findIndex((message, at) => !protectedRow(at) && (message.role === 'assistant' || message.origin === 'automatic'));
      const olderUser = reference.findIndex((_message, at) => !protectedRow(at));
      const at = removable >= 0 ? removable : olderUser;
      if (at >= 0) reference.splice(at, 1);
      else {
        const largest = reference.reduce((best, message, index) => message.content.length > (reference[best]?.content.length ?? 0) ? index : best, 0);
        if (!reference[largest] || reference[largest]!.content.length < 256) throw new Error('goal_context_too_large');
        reference[largest] = { ...reference[largest]!, content: clip(reference[largest]!.content, Math.floor(reference[largest]!.content.length / 2)) };
      }
      omitted = true;
    }
    const direction = omitted ? incomplete : replacement;
    // Each decision owns one Temporary Chat and the complete bounded reference. Historical helper identities remain fenced, but never receive new requests.
    const decision = normalizeGoalDecision(await requestProviderDecision(render(reference, direction), request.signal, {
      sourceSessionId: request.sourceSessionId,
      sourceConversationId: request.sourceConversationId,
      publish: request.publish
    }), false);
    request.signal.throwIfAborted();
    return decision;
  }
  let url: string | null;
  let providerHeaders: Record<string, string>;
  try {
    url = apiRequestUrl(request.endpoint, 'chat');
    if (!url) throw new Error('The configured API has no chat endpoint.');
    providerHeaders = await apiRequestHeaders(request.endpoint, request.key);
  } catch (error) {
    return { action: 'http', error: (error as Error).message };
  }
  if (request.endpoint.kind === 'custom' && request.endpoint.protocol === 'anthropic-messages') {
    return requestAnthropicDecision(request, url, providerHeaders, referenceContract);
  }
  const custom = request.endpoint.kind === 'custom';
  const openrouter = request.endpoint.kind === 'openrouter';
  const body: Record<string, unknown> = {
    model: request.model,
    // Stream only to a real progress consumer. Partial text remains presentation; the complete bounded response still crosses normalizeGoalDecision before sending.
    stream: Boolean(request.publish),
    messages: [
      ...request.system.map((content) => ({ role: 'system', content })),
      { role: 'system', content: request.mode === 'loop' ? LOOP_OUTPUT_PROTOCOL : GOAL_OUTPUT_PROTOCOL },
      { role: 'user', content: referenceContract + '\n\n' + JSON.stringify(request.messages) },
      { role: 'system', content: request.trailer }
    ],
    response_format: request.mode === 'loop' ? LOOP_RESPONSE_FORMAT : GOAL_RESPONSE_FORMAT,
    ...(!request.publish && openrouter ? { plugins: [{ id: 'response-healing' }] } : {}),
    // OpenRouter otherwise may route to a provider that silently ignores response_format. A custom endpoint speaks plain OpenAI-compatible chat completions and must not receive vendor fields it never defined.
    ...(openrouter ? { provider: { require_parameters: true } } : {})
  };
  // Reasoning may still be used, but it is never part of the response body this app parses. OpenRouter documents `exclude` as supported across models even when effort selection is not. `default` therefore means "provider-selected effort", not "return its scratchpad". Local OpenAI-compatible endpoints may accept `reasoning_effort`; OpenAI's model catalogue does not publish a per-model capability signal here, so its direct connection omits it.
  if (openrouter) {
    body['reasoning'] = {
      ...(request.reasoning === 'default' ? {} : { effort: request.reasoning }),
      exclude: true
    };
  } else if (custom && request.reasoning !== 'default') {
    body['reasoning_effort'] = request.reasoning;
  }

  const response = await fetch(url, {
    method: 'POST',
    // A redirect must not hand conversation content or credentials to a different endpoint.
    redirect: 'error',
    headers: { ...providerHeaders, ...(openrouter ? ATTRIBUTION_HEADERS : {}) },
    body: JSON.stringify(body),
    signal: request.signal
  });
  if (!response.ok || !response.body) {
    const header = response.headers.get('retry-after');
    const delay = header === null ? NaN : /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) * 1000 : Date.parse(header) - Date.now();
    return { action: 'http', error: await httpFailure(response, apiProviderLabel(request.endpoint)), ...(Number.isFinite(delay) ? { retryAfterMs: Math.max(0, delay) } : {}) };
  }
  const completion = await readGoalCompletion(response, request.publish);
  return normalizeGoalDecision(completion.text, completion.legacy);
}

// One decision the caller may act on, with Loop's single addition: a stop is not one. In `goal` mode this is exactly `requestGoalDecision` — one request, one answer, no retry, for all the reasons written above it. In `loop` mode the model has been told it never stops and handed a schema with no way to say so, so a stop reaching this point means it wrote the sentinel into the message text instead. That is a malformed answer rather than a decision, and the honest repair is to ask again with the refusal spelled out — never to type a sentence this app wrote and attribute it to the model. Everything else — a provider error, a cut stream, an unreadable shape — is passed straight back, because whether *those* are worth asking again is the page's call and not this one's.
export function webProviderLabel(conversationId?: string): string {
  const provider = providerForConversationId(conversationId ?? '') ?? getConfig().ui.webProvider ?? 'deepseek';
  return WEB_PROVIDERS[provider].label;
}

export async function requestDrivingDecision(
  request: GoalRequest
): Promise<GoalDecision | { action: 'http'; error: string; retryAfterMs?: number }> {
  let decision = await requestGoalDecision(request);
  if (request.mode !== 'loop') return decision;
  for (let attempt = 1; attempt < LOOP_ATTEMPTS && decision.action === 'stop'; attempt += 1) {
    logWarn(`goal: the loop tried to stop with ${request.model}; asking again (${attempt}/${LOOP_ATTEMPTS - 1})`);
    decision = await requestGoalDecision({
      ...request,
      system: [...request.system, GOAL_LOOP_STOP_REFUSED]
    });
  }
  return decision;
}

