import { normalizedToolOutcome, type StoredText, type ToolCallRecord } from '../../../../contracts/session.js';

export const MAX_ACTIVITY_CALL_ID_CHARS = 200;
const MAX_ACTIVITY_DETAIL_TEXT_CHARS = 8_000;
const BINARY_OMISSION = (chars: number): string => `<binary payload omitted: ${chars} characters>`;

export function activityDisplayOutcome(call: ToolCallRecord): { code: string; label: string; exitCode?: number | null } {
  const process = call.process;
  if (process) {
    if (process.completedAt === undefined) return { code: 'started', label: 'started' };
    if (typeof process.exitCode !== 'number' || !Number.isFinite(process.exitCode)) {
      return { code: 'finished', label: 'finished · exit unknown', exitCode: null };
    }
    if (process.exitCode !== 0) return { code: 'failed', label: `failed · exit ${process.exitCode}`, exitCode: process.exitCode };
    return { code: 'completed', label: 'completed', exitCode: 0 };
  }
  const normalized = normalizedToolOutcome(call);
  if (normalized === 'ok') return { code: 'completed', label: 'completed' };
  if (normalized === 'tool_rejected') return { code: 'refused', label: 'refused' };
  if (normalized === 'tool_internal_error') return { code: 'internal_error', label: 'internal error' };
  if (normalized === 'tool_execution_error') return { code: 'failed', label: 'failed' };
  if (normalized === 'process_exit_nonzero') {
    const exit = /^✕ exit (-?\d+)$/.exec(call.summary.metric ?? '');
    return exit ? { code: 'failed', label: `failed · exit ${exit[1]}`, exitCode: Number(exit[1]) }
      : { code: 'failed', label: 'failed' };
  }
  return { code: 'unknown', label: 'unknown' };
}

export function activityDurationMs(call: ToolCallRecord): number | null {
  const duration = call.process?.completedAt !== undefined ? call.process.durationMs : call.durationMs;
  return typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function scrubActivityDetailBinary(text: string): string {
  const replace = (value: string): string => BINARY_OMISSION(value.length);
  return text
    .replace(/data:[^;,\s"']{1,100};base64,[a-z0-9+/=\r\n]+/gi, replace)
    .replace(/(["'](?:data|blob|dataBase64)["']\s*:\s*)(["'])([\s\S]*?)(\2|$)/gi,
      (_all, head: string, quote: string, payload: string, tail: string) =>
        `${head}${quote}${BINARY_OMISSION(payload.length)}${tail}`)
    .replace(/(?=[a-z0-9+/=]{256,})(?=[a-z0-9+/=]*[+/=])[a-z0-9+/]{256,}={0,2}/gi, replace);
}

function readableActivityResult(text: string): string {
  const scrubbed = scrubActivityDetailBinary(text);
  try {
    const value = JSON.parse(scrubbed) as { content?: unknown[]; structuredContent?: unknown };
    if (value && Array.isArray(value.content)) {
      const readable: string[] = [];
      const scrubbedMarker = /<binary payload omitted: \d+ characters>/.exec(scrubbed)?.[0] ?? null;
      let omittedBinary = scrubbedMarker !== null;
      for (const block of value.content as Array<Record<string, unknown>>) {
        if (block?.type === 'text' && typeof block.text === 'string') readable.push(block.text);
        else if (block?.type === 'resource' && block.resource && typeof block.resource === 'object' &&
            typeof (block.resource as { text?: unknown }).text === 'string') {
          readable.push((block.resource as { text: string }).text);
        } else if (block && ['image', 'audio', 'resource'].includes(String(block.type ?? ''))) omittedBinary = true;
      }
      if (readable.length || omittedBinary) {
        if (omittedBinary) readable.push(scrubbedMarker ?? '<binary payload omitted>');
        return readable.join('\n\n');
      }
      if (value.structuredContent !== undefined) return scrubActivityDetailBinary(JSON.stringify(value.structuredContent, null, 2));
    }
  } catch {
    // A bounded preview may end mid-JSON, so the binary scrub remains authoritative.
  }
  return scrubbed;
}

export function activityStoredPreview(stored: StoredText, result = false): { text: string; truncated: boolean; chars: number } {
  const chars = Number.isFinite(stored.chars) && stored.chars >= 0 ? Math.floor(stored.chars) : stored.text.length;
  const inline = stored.text.slice(0, MAX_ACTIVITY_DETAIL_TEXT_CHARS);
  const readable = result ? readableActivityResult(inline) : scrubActivityDetailBinary(inline);
  return {
    text: readable.slice(0, MAX_ACTIVITY_DETAIL_TEXT_CHARS),
    truncated: stored.truncated === true || stored.text.length > MAX_ACTIVITY_DETAIL_TEXT_CHARS || readable.length > MAX_ACTIVITY_DETAIL_TEXT_CHARS,
    chars
  };
}
