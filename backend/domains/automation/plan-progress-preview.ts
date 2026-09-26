const MAX_INPUT_LENGTH = 64_000;
const MAX_STAGE_COUNT = 12;
const MAX_PREVIEW_LENGTH = 8_000;

interface StringPrefix {
  value: string;
  nextIndex: number;
  complete: boolean;
}

function skipWhitespace(source: string, index: number): number {
  while (index < source.length && /\s/.test(source[index]!)) index++;
  return index;
}

function readStringPrefix(source: string, start: number): StringPrefix | null {
  if (source[start] !== '"') return null;

  let value = '';
  let index = start + 1;
  while (index < source.length) {
    const character = source[index]!;
    if (character === '"') return { value, nextIndex: index + 1, complete: true };
    if (character.charCodeAt(0) < 32) return null;

    if (character !== '\\') {
      value += character;
      index++;
      continue;
    }

    const escapeIndex = index + 1;
    if (escapeIndex >= source.length) break;
    const escaped = source[escapeIndex]!;
    if (escaped === 'u') {
      const digits = source.slice(escapeIndex + 1, escapeIndex + 5);
      if (!/^[0-9a-f]*$/i.test(digits)) return null;
      if (digits.length < 4) break;
      value += String.fromCharCode(Number.parseInt(digits, 16));
      index = escapeIndex + 5;
      continue;
    }

    const decoded: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    if (!(escaped in decoded)) return null;
    value += decoded[escaped]!;
    index = escapeIndex + 1;
  }

  return { value, nextIndex: source.length, complete: false };
}

function extractReplyPrefix(raw: string): string | null {
  if (raw.length > MAX_INPUT_LENGTH) return null;
  const source = raw.trimStart();
  if (source[0] !== '{') return null;

  const seenKeys = new Set<string>();
  let index = 1;
  while (index < source.length) {
    const keyStart = skipWhitespace(source, index);
    const key = readStringPrefix(source, keyStart);
    if (!key?.complete || !['action', 'reply'].includes(key.value) || seenKeys.has(key.value)) return null;
    seenKeys.add(key.value);

    index = skipWhitespace(source, key.nextIndex);
    if (source[index++] !== ':') return null;
    const value = readStringPrefix(source, skipWhitespace(source, index));
    if (!value) return null;
    if (key.value === 'reply') return value.value;

    if (!value.complete || value.value !== 'continue') return null;
    index = skipWhitespace(source, value.nextIndex);
    if (source[index++] !== ',') return null;
  }

  return null;
}

function readStagePreview(reply: string): string {
  const source = reply.trimStart();
  if (source[0] !== '{') return '';

  const stagesKey = readStringPrefix(source, skipWhitespace(source, 1));
  if (!stagesKey?.complete || stagesKey.value !== 'stages') return '';
  let index = skipWhitespace(source, stagesKey.nextIndex);
  if (source[index++] !== ':') return '';
  index = skipWhitespace(source, index);
  if (source[index++] !== '[') return '';

  const stages: string[] = [];
  while (stages.length < MAX_STAGE_COUNT) {
    index = skipWhitespace(source, index);
    if (index >= source.length || source[index] === ']') break;

    const stage = readStringPrefix(source, index);
    if (!stage) return '';
    if (stage.value.trim()) stages.push(stage.value);
    if (!stage.complete) break;

    index = skipWhitespace(source, stage.nextIndex);
    if (index >= source.length || source[index] === ']') break;
    if (source[index++] !== ',') return '';
  }

  return stages.map((stage, offset) => `${offset + 1}. ${stage}`).join('\n\n').slice(0, MAX_PREVIEW_LENGTH);
}

export function planProgressText(raw: string): string {
  const reply = extractReplyPrefix(raw);
  return reply === null ? '' : readStagePreview(reply);
}
