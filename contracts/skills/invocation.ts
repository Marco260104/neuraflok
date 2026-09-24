export interface SkillDirectiveResult {
  ids: string[];
  prefix: string;
  body: string;
}

const DIRECTIVE_TOKEN = /^\/([a-z0-9][a-z0-9._-]*)(?=\s|$)/i;
const SKILL_ARGUMENT = /^([a-z0-9][a-z0-9._-]*)(?=\s|$)/i;
const VALID_SKILL_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i;
const MAX_SELECTED_SKILLS = 64;

function skipWhitespace(text: string, offset: number): number {
  const remaining = text.slice(offset);
  return offset + remaining.length - remaining.trimStart().length;
}

function matchedToken(text: string, offset: number, pattern: RegExp): RegExpExecArray | null {
  return pattern.exec(text.slice(offset));
}

function skillIdAfterDirective(text: string, offset: number, directive: string): { id: string; next: number } {
  let id = directive;
  let next = skipWhitespace(text, offset);
  if (id === 'prompt') {
    const argument = matchedToken(text, next, SKILL_ARGUMENT);
    if (!argument) throw new Error('Choose a skill after /prompt.');
    id = argument[1]!;
    next += argument[0].length;
    next = skipWhitespace(text, next);
  }
  if (!VALID_SKILL_ID.test(id)) throw new Error('Invalid skill command. Choose a skill from the list.');
  return { id, next };
}

export function skillDirectives(text: string): SkillDirectiveResult {
  const ids: string[] = [];
  let cursor = skipWhitespace(text, 0);
  let prefixEnd = 0;

  while (cursor < text.length) {
    const command = matchedToken(text, cursor, DIRECTIVE_TOKEN);
    if (!command) break;

    cursor += command[0].length;
    const parsed = skillIdAfterDirective(text, cursor, command[1]!);
    cursor = parsed.next;
    if (!ids.includes(parsed.id)) ids.push(parsed.id);
    if (ids.length > MAX_SELECTED_SKILLS) throw new Error('Too many selected skills.');
    prefixEnd = cursor;
  }

  return { ids, prefix: text.slice(0, prefixEnd), body: text.slice(prefixEnd) };
}

export function invokedSkills(text: string): string[] {
  return skillDirectives(text).ids;
}
