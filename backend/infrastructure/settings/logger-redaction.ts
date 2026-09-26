const MAX_LINE_BYTES = 16 * 1024;

export function redact(message: string): string {
  return message
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/\b(ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, '***jwt***')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, (match) =>
      /^[A-Za-z0-9_-]+$/.test(match) ? '***' : match
    );
}

export function boundedLogText(text: string): string {
  const prefix = text.slice(0, MAX_LINE_BYTES);
  if (prefix.length === text.length && Buffer.byteLength(prefix, 'utf8') <= MAX_LINE_BYTES) return text;
  return Buffer.from(prefix, 'utf8').subarray(0, MAX_LINE_BYTES - 64).toString('utf8') + ' [log text truncated]';
}
