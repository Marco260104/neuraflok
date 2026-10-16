// Parses bounded Goal responses from configured model endpoints.
import { logWarn } from '../../infrastructure/settings/logger.js';

export const MAX_MESSAGE_CHARS = 12_000;

const MAX_SSE_RECORD_CHARS = 64_000;

const MAX_ERROR_BODY_BYTES = 64 * 1024;

const MAX_GOAL_BODY_BYTES = 64 * 1024;

const NO_REPLY = /^no[\s_-]?reply[\s.!]*$/i;

const NO_REPLY_TOKEN = /(?:^|[^\p{L}\p{N}])no[\s_-]?reply[\s.!]*(?=$|[^\p{L}\p{N}])/iu;

const MODEL_CONTROL_TOKEN = /<\|[^|\r\n]{1,100}\|>|<\/?s>|\[\/?INST\]|<<\/?SYS>>/giu;

const UNSAFE_REASONING_TAG = /<\/?(?:think|analysis|reasoning)\b[^>]*>/iu;

export const GOAL_OUTPUT_PROTOCOL =
  'Return only the app decision described by the response schema. Use action "stop" when the editable instruction would say NO_REPLY. ' +
  'Use action "continue" only with the exact next user message in reply. Put no reasoning, counting, labels, tokenizer markers, or protocol words in reply.';

export const GOAL_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'goal_decision',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['stop', 'continue'],
          description:
            'stop only when the whole requested job is clearly complete; continue while concrete requested work or questions are not yet clearly completed or answered'
        },
        reply: {
          type: 'string',
          description: 'empty for stop; for continue, only the next message to send as the user'
        }
      },
      required: ['action', 'reply'],
      additionalProperties: false
    }
  }
} as const;

export const LOOP_OUTPUT_PROTOCOL =
  'Return only the app decision described by the response schema. Action is always "continue" — there is no stop, and no message may be skipped. ' +
  'Put the exact next user message in reply, and put no reasoning, counting, labels, tokenizer markers, or protocol words in it.';

export const LOOP_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'goal_decision',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['continue'],
          description: 'always continue; this mode never stops on its own'
        },
        reply: {
          type: 'string',
          description: 'the next message to send as the user; never empty'
        }
      },
      required: ['action', 'reply'],
      additionalProperties: false
    }
  }
} as const;

export async function httpFailure(response: Response): Promise<string> {
  let detail = '';
  try {
    const raw = await boundedResponseText(response, MAX_ERROR_BODY_BYTES);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    const message =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? (parsed as { error?: { message?: unknown } }).error?.message
        : null;
    detail = typeof message === 'string' ? message.slice(0, 200) : raw.slice(0, 200);
  } catch (error) {

    if (error instanceof Error && error.message === 'response_body_too_large') detail = 'response body too large';
  }
  if (response.status === 401 || response.status === 403) return `auth_rejected: ${detail || 'the OpenRouter key was refused'}`;
  if (response.status === 402) return `out_of_credit: ${detail || 'the OpenRouter account is out of credit'}`;
  if (response.status === 404) return `unknown_model: ${detail || 'OpenRouter does not know that model id'}`;
  if (response.status === 429) return `rate_limited: ${detail || 'OpenRouter is rate-limiting this key'}`;
  return `http_${response.status}${detail ? `: ${detail}` : ''}`;
}

export async function boundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('response_body_too_large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('response_body_too_large');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    try {
      await reader.cancel();
    } catch {

    }
    throw error;
  }
}

interface GoalCompletion {
  text: string;

  legacy: boolean;
}

export async function readGoalCompletion(
  response: Response,
  publish?: (text: string) => void
): Promise<GoalCompletion> {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/event-stream')) {

    if (!response.body) return { text: '', legacy: true };
    return { text: await readStream(response.body, publish), legacy: true };
  }

  const raw = await boundedResponseText(response, MAX_GOAL_BODY_BYTES);
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error('malformed_completion_response');
  }
  if (parsed && typeof parsed === 'object' && 'error' in parsed && (parsed as { error?: unknown }).error) {
    throw new Error('provider_completion_error');
  }
  const choices = parsed && typeof parsed === 'object' ? (parsed as { choices?: unknown }).choices : null;
  const choice = Array.isArray(choices) ? choices[0] : null;
  const message = choice && typeof choice === 'object' ? (choice as { message?: unknown }).message : null;
  const content = message && typeof message === 'object' ? (message as { content?: unknown }).content : null;
  if (typeof content !== 'string') throw new Error('malformed_completion_response');
  if (content.length > MAX_MESSAGE_CHARS + 2_048) throw new Error('reply_too_long');
  return { text: content, legacy: false };
}

export type GoalDecision =
  | { action: 'stop' }
  | { action: 'continue'; reply: string }
  | { action: 'invalid'; error: string };

function cleanGoalReply(value: string): { text: string; hadControl: boolean } {
  const normalized = value.normalize('NFKC');
  const withoutInvisible = normalized.replace(/[\u0000\u200B-\u200D\u2060\uFEFF]/g, '');
  const withoutControl = withoutInvisible.replace(MODEL_CONTROL_TOKEN, '');
  return { text: withoutControl.trim(), hadControl: withoutControl !== withoutInvisible };
}

const REASONING_BLOCK = /<(think|analysis|reasoning)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;
const CODE_FENCE = /^\s*```[a-z]*\s*([\s\S]*?)\s*```\s*$/iu;

function decisionObjectIn(text: string): unknown {
  const parse = (candidate: string): unknown => {
    try {
      return JSON.parse(candidate);
    } catch {
      return undefined;
    }
  };
  const direct = parse(text);
  if (direct !== undefined) return direct;
  const unwrapped = text.replace(REASONING_BLOCK, '').trim();
  const fenced = unwrapped.match(CODE_FENCE);
  const body = fenced?.[1] ?? unwrapped;
  const parsed = parse(body);
  if (parsed !== undefined) return parsed;
  const open = body.indexOf('{');
  const close = body.lastIndexOf('}');
  if (open === -1 || close <= open) return undefined;
  return parse(body.slice(open, close + 1));
}

function sample(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

export function normalizeGoalDecision(raw: string, legacy: boolean): GoalDecision {
  const trimmed = raw.trim();
  if (!trimmed) return { action: 'invalid', error: 'empty_reply' };

  if (legacy && !/^(?:[\[{]|```(?:json)?\s*[\[{])/i.test(trimmed)) {
    if (NO_REPLY_TOKEN.test(trimmed) || NO_REPLY.test(trimmed)) return { action: 'stop' };
    const cleaned = cleanGoalReply(trimmed);
    if (!cleaned.text) return { action: 'invalid', error: cleaned.hadControl ? 'control_tokens_only' : 'empty_reply' };
    if (cleaned.text.includes('<|') || cleaned.text.includes('|>') || UNSAFE_REASONING_TAG.test(cleaned.text)) {
      return { action: 'invalid', error: 'unsafe_control_tokens' };
    }
    return { action: 'continue', reply: cleaned.text };
  }

  const decision = decisionObjectIn(trimmed);
  if (decision === undefined) {
    logWarn(`goal: the structured decision was not JSON — ${sample(trimmed)}`);
    return { action: 'invalid', error: 'invalid_goal_decision_json' };
  }
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    return { action: 'invalid', error: 'invalid_goal_decision_schema' };
  }
  const object = decision as Record<string, unknown>;
  if (Object.keys(object).some((key) => key !== 'action' && key !== 'reply')) {
    return { action: 'invalid', error: 'invalid_goal_decision_schema' };
  }
  if ((object.action !== 'stop' && object.action !== 'continue') || typeof object.reply !== 'string') {
    return { action: 'invalid', error: 'invalid_goal_decision_schema' };
  }
  if (object.action === 'stop') return { action: 'stop' };

  if (NO_REPLY_TOKEN.test(object.reply) || NO_REPLY.test(object.reply)) return { action: 'stop' };
  const cleaned = cleanGoalReply(object.reply);
  if (!cleaned.text) return { action: 'invalid', error: cleaned.hadControl ? 'control_tokens_only' : 'empty_reply' };
  if (cleaned.text.includes('<|') || cleaned.text.includes('|>') || UNSAFE_REASONING_TAG.test(cleaned.text)) {
    return { action: 'invalid', error: 'unsafe_control_tokens' };
  }
  if (cleaned.text.length > MAX_MESSAGE_CHARS) return { action: 'invalid', error: 'reply_too_long' };
  return { action: 'continue', reply: cleaned.text };
}

async function readStream(
  body: ReadableStream<Uint8Array>,
  publish?: (text: string) => void
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let text = '';

  const consume = (rawLine: string): boolean => {
    if (rawLine.length > MAX_SSE_RECORD_CHARS) throw new Error('stream_record_too_long');
    const line = rawLine.trim();
    if (!line || line.startsWith(':') || !line.startsWith('data:')) return false;
    const payload = line.slice(5).trim();
    if (!payload) return false;
    if (payload === '[DONE]') return true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {

      throw new Error('malformed_stream_record');
    }
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const rawError = (parsed as { error?: unknown }).error;
      if (rawError) {
        const rawMessage =
          typeof rawError === 'string'
            ? rawError
            : rawError && typeof rawError === 'object' && 'message' in rawError
              ? (rawError as { message?: unknown }).message
              : null;
        const detail =
          typeof rawMessage === 'string'
            ? rawMessage.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200)
            : '';

        throw new Error(`provider_stream_error${detail ? `: ${detail}` : ''}`);
      }
    }
    const delta = deltaOf(parsed);
    if (!delta) return false;
    if (text.length + delta.length > MAX_MESSAGE_CHARS) throw new Error('reply_too_long');
    text += delta;

    publish?.(text);
    return false;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let cut = buffered.indexOf('\n');
      while (cut >= 0) {
        const line = buffered.slice(0, cut);
        buffered = buffered.slice(cut + 1);
        if (consume(line)) {

          await reader.cancel().catch(() => undefined);
          return text;
        }
        cut = buffered.indexOf('\n');
      }
      if (buffered.length > MAX_SSE_RECORD_CHARS) throw new Error('stream_record_too_long');
    }

    buffered += decoder.decode();
    if (buffered.length > MAX_SSE_RECORD_CHARS) throw new Error('stream_record_too_long');
    if (buffered) consume(buffered);
    return text;
  } catch (error) {

    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function deltaOf(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const choice = choices[0] as { delta?: { content?: unknown }; message?: { content?: unknown } };
  const content = choice?.delta?.content ?? choice?.message?.content;
  return typeof content === 'string' ? content : '';
}
