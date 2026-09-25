export type TruncationPolicy =
  | { kind: 'bytes'; bytes: number }
  | { kind: 'tokens'; tokens: number };

export interface TokenBoundedText {
  text: string;
  originalTokenCount: number;
}

const UTF8_BYTES_PER_TOKEN = 4;

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function approxTokensFromByteCount(bytes: number): number {
  if (!Number.isFinite(bytes)) return bytes === Number.POSITIVE_INFINITY ? Infinity : 0;
  return Math.ceil(Math.max(0, bytes) / UTF8_BYTES_PER_TOKEN);
}

export function approxTokenCount(text: string): number {
  return approxTokensFromByteCount(byteLength(text));
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split(/\r\n|\n|\r/);
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

function normalizedLimit(value: number): number {
  if (value === Number.POSITIVE_INFINITY) return value;
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function takePrefix(characters: string[], byteLimit: number): number {
  let usedBytes = 0;
  let end = 0;
  while (end < characters.length) {
    const nextBytes = byteLength(characters[end]!);
    if (usedBytes + nextBytes > byteLimit) break;
    usedBytes += nextBytes;
    end += 1;
  }
  return end;
}

function takeSuffix(characters: string[], byteLimit: number): number {
  let usedBytes = 0;
  let start = characters.length;
  while (start > 0) {
    const nextBytes = byteLength(characters[start - 1]!);
    if (usedBytes + nextBytes > byteLimit) break;
    usedBytes += nextBytes;
    start -= 1;
  }
  return start;
}

function middlePreview(text: string, prefixBytes: number, suffixBytes: number, unit: 'chars' | 'tokens', removed: number): string {
  const characters = Array.from(text);
  const prefixEnd = takePrefix(characters, prefixBytes);
  const suffixStart = Math.max(prefixEnd, takeSuffix(characters, suffixBytes));
  const prefix = characters.slice(0, prefixEnd).join('');
  const suffix = characters.slice(suffixStart).join('');
  return `${prefix}…${removed} ${unit} truncated…${suffix}`;
}

export function truncateMiddleChars(text: string, maxBytes: number): string {
  const byteLimit = normalizedLimit(maxBytes);
  if (byteLength(text) <= byteLimit) return text;
  const characters = Array.from(text);
  const prefixBytes = Math.floor(byteLimit / 2);
  const suffixBytes = Math.ceil(byteLimit / 2);
  const prefixEnd = takePrefix(characters, prefixBytes);
  const suffixStart = Math.max(prefixEnd, takeSuffix(characters, suffixBytes));
  const removed = characters.length - prefixEnd - (characters.length - suffixStart);
  return middlePreview(text, prefixBytes, suffixBytes, 'chars', removed);
}

export function truncateMiddleWithTokenBudget(text: string, maxTokens: number): TokenBoundedText {
  const originalTokenCount = approxTokenCount(text);
  const tokenLimit = normalizedLimit(maxTokens);
  if (originalTokenCount <= tokenLimit) return { text, originalTokenCount };

  const byteBudget = tokenLimit * UTF8_BYTES_PER_TOKEN;
  const removedTokens = originalTokenCount - tokenLimit;
  const preview = middlePreview(
    text,
    Math.floor(byteBudget / 2),
    Math.ceil(byteBudget / 2),
    'tokens',
    removedTokens
  );
  return { text: preview, originalTokenCount };
}

export function policyTokenBudget(policy: TruncationPolicy): number {
  return policy.kind === 'tokens'
    ? normalizedLimit(policy.tokens)
    : approxTokensFromByteCount(policy.bytes);
}

export function truncateText(text: string, policy: TruncationPolicy): string {
  return policy.kind === 'bytes'
    ? truncateMiddleChars(text, policy.bytes)
    : truncateMiddleWithTokenBudget(text, policy.tokens).text;
}

export function formattedTruncateText(text: string, policy: TruncationPolicy): string {
  const isOverLimit = policy.kind === 'bytes'
    ? byteLength(text) > normalizedLimit(policy.bytes)
    : approxTokenCount(text) > normalizedLimit(policy.tokens);
  if (!isOverLimit) return text;

  return [
    `Warning: truncated output (original token count: ${approxTokenCount(text)})`,
    `Total output lines: ${countLines(text)}`,
    '',
    truncateText(text, policy)
  ].join('\n');
}
