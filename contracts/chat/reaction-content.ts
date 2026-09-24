const MAX_REACTION_LENGTH = 32;
const START_MARKER = '\uE200message_reaction\uE202';
const END_MARKER = '\uE201';
const REACTION_CODE_POINT = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\u200d|\ufe0f|\u20e3|[0-9#*]|[\u{e0020}-\u{e007f}])$/u;
const REACTION_INDICATOR = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function messageReaction(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REACTION_LENGTH) return undefined;
  if (!REACTION_INDICATOR.test(value) || ![...value].every(character => REACTION_CODE_POINT.test(character))) return undefined;
  const segments = GRAPHEME_SEGMENTER.segment(value)[Symbol.iterator]();
  return !segments.next().done && segments.next().done ? value : undefined;
}

function removeReactionPrefix(text: string): string {
  if (text.length > 0 && START_MARKER.startsWith(text)) return '';
  if (!text.startsWith(START_MARKER)) return text;
  const end = text.indexOf(END_MARKER, START_MARKER.length);
  if (end < 0) return text.length <= START_MARKER.length + MAX_REACTION_LENGTH ? '' : text;
  const reaction = text.slice(START_MARKER.length, end);
  if (!messageReaction(reaction)) return text;
  return text.slice(end + END_MARKER.length).replace(/^[\t ]*(?:\r?\n)?/, '');
}

export function withoutMessageReaction(source: string): string {
  return removeReactionPrefix(source.trimStart());
}
