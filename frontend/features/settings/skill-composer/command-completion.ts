import { skillDirectives } from '../../../../contracts/skills/invocation.js';

export const COMPOSER_COMMAND_PROJECTION = Symbol('composer-command-projection');

export function splitSkillDraft(text: string): ReturnType<typeof skillDirectives> {
  try { return skillDirectives(text); }
  catch { return { ids: [], prefix: '', body: text }; }
}

export function skillCompletion(text: string, start: number, end = start): { start: number; end: number; query: string } | null {
  if (start !== end || /\S/.test(text.slice(end).split(/\s/, 1)[0] ?? '')) return null;
  const before = text.slice(0, start);
  const match = /(?:^|\s)(\/(?:prompt(?:\s+[a-z0-9._-]*)?|[a-z0-9._-]*))$/i.exec(before);
  if (!match) return null;
  const at = start - match[1]!.length;
  const preceding = text.slice(0, at).trim();
  if (preceding && !/^(?:\/(?!prompt(?:\s|$))[a-z0-9._-]+|\/prompt\s+[a-z0-9._-]+)(?:\s+(?:\/(?!prompt(?:\s|$))[a-z0-9._-]+|\/prompt\s+[a-z0-9._-]+))*$/i.test(preceding)) return null;
  const token = match[1]!;
  return { start: at, end, query: token === '/prompt' ? '' : token.replace(/^\/prompt\s+|^\//, '').toLowerCase() };
}
