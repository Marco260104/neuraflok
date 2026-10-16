import { unescapeMarkdown } from '../session.js';
import { continuationIdentityPrefix } from '../sessions/continuation-marker.js';

export const MAX_PROVIDER_MESSAGE_CHARS = 96_000;

const currentFormat = 'NEURAFLOK_MESSAGE_V1';
const compatibleFormats = new Set([currentFormat, 'NEURAFLOK_CONTEXT', 'NEURAL_JAM_CONTEXT']);

function normalizedLines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function parseHeader(value: string, offset: number): { name: string; length: number; bodyStart: number } | null {
  if (!value.startsWith('[[', offset)) return null;
  const headerEnd = value.indexOf(']]', offset + 2);
  if (headerEnd < 0 || value[headerEnd + 2] !== '\n') return null;
  const header = value.slice(offset + 2, headerEnd);
  const separator = header.lastIndexOf(':');
  if (separator < 0) return null;
  const name = header.slice(0, separator);
  const digits = header.slice(separator + 1);
  if (!compatibleFormats.has(name) || digits.length === 0 || digits.length > 6) return null;
  for (const digit of digits) if (digit < '0' || digit > '9') return null;
  return { name, length: Number(digits), bodyStart: headerEnd + 3 };
}

function unwrapFrame(value: string): string | null {
  const identity = continuationIdentityPrefix(value);
  const header = parseHeader(value, identity.length);
  if (!header) return null;
  const closing = `\n[[/${header.name}]]\n\n`;
  const closingOffset = header.bodyStart + header.length;
  if (!value.startsWith(closing, closingOffset)) return null;
  return identity + value.slice(closingOffset + closing.length);
}

export function userPromptText(value: string): string | null {
  const exact = normalizedLines(value);
  const direct = unwrapFrame(exact);
  if (direct !== null) return direct;
  const restored = unescapeMarkdown(exact);
  return restored === exact ? null : unwrapFrame(restored);
}

export function prependUserPrompt(value: string, instructions: string): string {
  const message = normalizedLines(value);
  const context = normalizedLines(instructions);
  const authored = userPromptText(message) ?? message;
  const identity = continuationIdentityPrefix(authored);
  return `${identity}[[${currentFormat}:${context.length}]]\n${context}\n[[/${currentFormat}]]\n\n${authored.slice(identity.length)}`;
}
