import { MAX_SKILL_DESCRIPTION_CHARS, MAX_SKILL_NAME_CHARS } from '../../../contracts/skills.js';
import { parseSkillFrontmatter } from './skill-metadata.js';

const SIMPLE_SCALAR_UNSAFE = /^(?:[\[\]{}|>&*!%@`]|[-?:]\s)|:\s/;

function cutUnits(value: string, limit: number): string {
  let result = value.slice(0, limit);
  if (result && /[\uD800-\uDBFF]/.test(result[result.length - 1]!)) result = result.slice(0, -1);
  return result;
}

function oneLine(value: string, limit: number): string {
  return cutUnits(value.replace(/\s+/g, ' ').trim(), limit);
}

function simpleScalar(value: string): string | null {
  value = value.trim();
  if (!value) return null;
  // Quoted values can contain a colon-space pair without starting a nested mapping.
  if (value.startsWith('"') || value.endsWith('"')) {
    if (!(value.startsWith('"') && value.endsWith('"'))) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'string' && !/[\r\n]/.test(parsed) ? parsed : null;
    } catch { return null; }
  }
  if (value.startsWith("'") || value.endsWith("'")) {
    if (!(value.startsWith("'") && value.endsWith("'"))) return null;
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return SIMPLE_SCALAR_UNSAFE.test(value) ? null : value;
}

function markdownBodyAndMetadata(text: string): { lines: string[]; name: string | null; description: string | null } {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return { lines, name: null, description: null };
  const end = lines.findIndex((line, index) => index > 0 && ['---', '...'].includes(line.trim()));
  if (end < 0) return { lines, name: null, description: null };
  let name: string | null = null, description: string | null = null;
  let nameSeen = false, descriptionSeen = false;
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    if (key !== 'name' && key !== 'description') continue;
    const value = simpleScalar(match[2]!);
    if (key === 'name') {
      if (nameSeen) name = null;
      else name = value;
      nameSeen = true;
    } else {
      if (descriptionSeen) description = null;
      else description = value;
      descriptionSeen = true;
    }
  }
  return { lines: lines.slice(end + 1), name, description };
}

function fallbackMetadata(lines: string[], id: string): { name: string; description: string } {
  const headingIndex = lines.findIndex(line => /^#\s+\S/.test(line.trim()));
  const heading = headingIndex >= 0 ? lines[headingIndex]!.trim().replace(/^#\s+/, '') : id;
  const start = headingIndex >= 0 ? headingIndex + 1 : 0;
  let description = '';
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!line || /^(?:#{1,6}\s|```|~~~|>|[-*+]\s|\d+[.)]\s|<)/.test(line)) continue;
    const paragraph = [line];
    for (let next = index + 1; next < lines.length; next++) {
      const continuation = lines[next]!.trim();
      if (!continuation || /^(?:#{1,6}\s|```|~~~)/.test(continuation)) break;
      paragraph.push(continuation);
    }
    description = paragraph.join(' ');
    break;
  }
  return {
    name: oneLine(heading, MAX_SKILL_NAME_CHARS) || id,
    description: oneLine(description, MAX_SKILL_DESCRIPTION_CHARS)
  };
}

export function metadataFor(text: string, id: string): { name: string; description: string } {
  try {
    const metadata = parseSkillFrontmatter(text);
    return {
      name: oneLine(metadata.name, MAX_SKILL_NAME_CHARS),
      description: oneLine(metadata.description, MAX_SKILL_DESCRIPTION_CHARS)
    };
  } catch { /* Legacy Markdown keeps its safe heading and prose fallback. */ }
  const parsed = markdownBodyAndMetadata(text);
  const fallback = fallbackMetadata(parsed.lines, id);
  const name = parsed.name === null ? fallback.name : oneLine(parsed.name, MAX_SKILL_NAME_CHARS);
  const description = parsed.description === null
    ? fallback.description
    : oneLine(parsed.description, MAX_SKILL_DESCRIPTION_CHARS);
  return { name: name || fallback.name, description };
}
