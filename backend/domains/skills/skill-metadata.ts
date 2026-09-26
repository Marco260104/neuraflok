import { load, JSON_SCHEMA } from 'js-yaml';
import { parse as parseToml } from 'smol-toml';
import type { SkillMetadata } from '../../../contracts/skills.js';

type PlainRecord = Record<string, unknown>;

function asRecord(value: unknown): PlainRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as PlainRecord : null;
}

function readText(value: unknown, limit: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error('Skill metadata must contain plain text');
  }
  const result = value.trim();
  if (result.length > limit) throw new Error(`Skill metadata exceeds ${limit} characters`);
  return result || undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error('Skill policy values must be true or false');
  return value;
}

function parseYamlMapping(text: string, maxBytes: number): PlainRecord {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Skill metadata exceeds its size limit');
  let depth = 0;
  let nodes = 0;
  const value = load(text, {
    schema: JSON_SCHEMA,
    listener(event) {
      if (event === 'open') {
        depth += 1;
        nodes += 1;
        if (depth > 24 || nodes > 4096) throw new Error('Skill metadata is too deeply nested or contains too many values');
      } else {
        depth -= 1;
      }
    }
  });
  const mapping = asRecord(value);
  if (!mapping) throw new Error('Skill metadata must be a mapping');
  return mapping;
}

export function parseSkillFrontmatter(text: string): { name: string; description: string; shortDescription?: string } {
  const header = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/.exec(text);
  if (!header) throw new Error('Discovered skills require YAML frontmatter with name and description');
  const metadata = parseYamlMapping(header[1]!, 64 * 1024);
  const name = readText(metadata.name, 160);
  const description = readText(metadata.description, 1024);
  if (!name || !description) throw new Error('Discovered skills need a name and description');
  const shortDescription = readText(asRecord(metadata.metadata)?.['short-description'], 240);
  return { name: name.replace(/\s+/g, ' '), description, ...(shortDescription ? { shortDescription } : {}) };
}

export function parseSkillInterface(text: string): SkillMetadata {
  const metadata = parseYamlMapping(text, 64 * 1024);
  const presentation = asRecord(metadata.interface);
  const policy = asRecord(metadata.policy);
  if (metadata.policy !== undefined && !policy) throw new Error('Skill policy must be a mapping');
  const displayName = readText(presentation?.display_name, 160);
  const shortDescription = readText(presentation?.short_description, 240);
  const defaultPrompt = readText(presentation?.default_prompt, 4000);
  const tools = asRecord(metadata.dependencies)?.tools;
  if (tools !== undefined && (!Array.isArray(tools) || tools.length > 32)) {
    throw new Error('A skill supports at most 32 dependency descriptions');
  }
  const result: SkillMetadata = { allowImplicitInvocation: readBoolean(policy?.allow_implicit_invocation) ?? true };
  if (displayName) result.displayName = displayName;
  if (shortDescription) result.shortDescription = shortDescription;
  if (defaultPrompt) result.defaultPrompt = defaultPrompt;
  if (Array.isArray(tools)) {
    result.dependencies = tools.map(value => {
      const item = asRecord(value);
      const type = readText(item?.type, 80);
      const name = readText(item?.value, 200);
      const description = readText(item?.description, 500);
      if (!type || !name) throw new Error('Skill dependency metadata needs type and value');
      return { type, value: name, ...(description ? { description } : {}) };
    });
  }
  return result;
}

export interface SkillConfiguration {
  includeInstructions?: boolean;
  bundledEnabled?: boolean;
  maxContextTokens?: number;
  rules: Array<{ name?: string; path?: string; enabled: boolean }>;
}

export function parseSkillConfiguration(text: string): SkillConfiguration {
  if (Buffer.byteLength(text, 'utf8') > 128_000) throw new Error('Skills configuration exceeds 128,000 bytes');
  const root = parseToml(text);
  const skills = asRecord(root.skills);
  if (root.skills === undefined) return { rules: [] };
  if (!skills) throw new Error('Skills configuration must be a table');
  const result: SkillConfiguration = { rules: [] };
  const include = readBoolean(skills.include_instructions);
  const bundled = readBoolean(asRecord(skills.bundled)?.enabled);
  if (include !== undefined) result.includeInstructions = include;
  if (bundled !== undefined) result.bundledEnabled = bundled;
  if (skills.max_context_tokens !== undefined) {
    const count = skills.max_context_tokens;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) {
      throw new Error('Skills max_context_tokens must be a positive integer');
    }
    result.maxContextTokens = Math.min(count, 10_000);
  }
  if (skills.config !== undefined) {
    if (!Array.isArray(skills.config) || skills.config.length > 256) throw new Error('Skills configuration supports at most 256 rules');
    result.rules = skills.config.map(value => {
      const rule = asRecord(value);
      const name = readText(rule?.name, 160);
      const file = readText(rule?.path, 4096);
      const enabled = readBoolean(rule?.enabled);
      if (Number(Boolean(name)) + Number(Boolean(file)) !== 1 || enabled === undefined) {
        throw new Error('Each Skills rule needs one name or path and an enabled flag');
      }
      return { ...(name ? { name } : { path: file! }), enabled };
    });
  }
  return result;
}
