import path from 'node:path';
import os from 'node:os';
import { rawPromises as fs } from '../workspace/rawfs.js';
import { effectiveCapabilities, getConfig } from '../../infrastructure/settings/config.js';
import { isContained } from '../../infrastructure/settings/sandbox.js';
import { skillCatalogSnapshot, skillsDirectory } from './storage/catalog.js';
import { parseSkillConfiguration, type SkillConfiguration } from './skill-metadata.js';
import type { SkillLibraryScope, SkillCandidate, ClaudePluginCandidate } from './skill-library-types.js';
import type { SkillRoutingMetadata } from '../../../contracts/skill-routing.js';
import { approved, approvedDirectory, errorText, interfaceFor, readApproved, readOptionalApproved, samePath } from './skill-library-access.js';

export async function locations(scope: SkillLibraryScope): Promise<{
  roots: SkillCandidate[];
  configs: string[];
  claudeHome: string;
  projectReal: string | null;
}> {
  const home = path.resolve((process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME) || os.homedir());
  const neuraflok = path.resolve(process.env.NEURAFLOK_HOME?.trim() || path.join(home, '.neuraflok'));
  const legacyNeuralJam = path.resolve(path.join(home, '.neural-jam'));
  const claude = path.resolve(process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude'));
  let projectReal: string | null = null;
  const admin = process.platform === 'win32' ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'Neuraflok') : '/etc/neuraflok';
  const legacyAdmin = process.platform === 'win32' ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'NeuralJam') : '/etc/neural-jam';
  const distinct = (values: string[]) => values.filter((value, index) => values.findIndex(candidate => process.platform === 'win32'
    ? candidate.toLowerCase() === value.toLowerCase() : candidate === value) === index);
  const userHomes = distinct([legacyNeuralJam, neuraflok]);
  const adminHomes = distinct([legacyAdmin, admin]);
  const roots: SkillCandidate[] = [];
  const configs = [...adminHomes.map(directory => path.join(directory, 'config.toml')), ...userHomes.map(directory => path.join(directory, 'config.toml'))];
  if (scope.projectPath) {
    const project = await approved(scope.projectPath);
    projectReal = project.real;
    let directory = project.real;
    const ancestors = [directory];
    for (let count = 0; count < 24; count++) {
      try { await fs.lstat(path.join(directory, '.git')); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') break; }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      try { await approved(parent); } catch { break; }
      ancestors.push(parent);
      directory = parent;
    }
    let repository = false;
    try { await fs.lstat(path.join(directory, '.git')); repository = true; } catch { /* A non-repository project has only its explicit scope. */ }
    const scoped = repository ? ancestors.reverse() : [project.real];
    for (const folder of scoped) {
      roots.push({ file: path.join(folder, '.agents', 'skills'), scope: 'repo', source: 'repo-agents' });
      configs.push(path.join(folder, '.neural-jam', 'config.toml'), path.join(folder, '.neuraflok', 'config.toml'));
    }
    roots.push({ file: path.join(project.real, '.neural-jam', 'skills'), scope: 'repo', source: 'project-neuraflok' });
    roots.push({ file: path.join(project.real, '.neuraflok', 'skills'), scope: 'repo', source: 'project-neuraflok' });
    roots.push({ file: path.join(project.real, '.claude', 'skills'), scope: 'repo', source: 'project-claude' });
  }
  roots.push(
    { file: path.join(home, '.agents', 'skills'), scope: 'user', source: 'user-agents' },
    ...userHomes.map(directory => ({ file: path.join(directory, 'skills'), scope: 'user' as const, source: 'neuraflok-home' as const })),
    { file: path.join(claude, 'skills'), scope: 'user', source: 'claude-home', skipTop: 'synced' },
    ...userHomes.map(directory => ({ file: path.join(directory, 'skills', '.system'), scope: 'system' as const, source: 'bundled' as const })),
    ...adminHomes.map(directory => ({ file: path.join(directory, 'skills'), scope: 'admin' as const, source: 'admin' as const }))
  );
  const synced = await claudeSyncedSkills(claude);
  if (synced) roots.push({ file: synced, scope: 'user', source: 'claude-home' });
  return { roots, configs, claudeHome: claude, projectReal };
}

const CLAUDE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function claudeSyncedSkills(claude: string): Promise<string | null> {
  const file = process.env.CLAUDE_CONFIG_DIR?.trim() ? path.join(claude, '.claude.json') : path.join(path.dirname(claude), '.claude.json');
  try {
    const text = await readOptionalApproved(file);
    if (!text) return null;
    const account = (JSON.parse(text) as { oauthAccount?: { organizationUuid?: unknown; accountUuid?: unknown } }).oauthAccount;
    const organization = account?.organizationUuid;
    const user = account?.accountUuid;
    if (typeof organization !== 'string' || typeof user !== 'string' || !CLAUDE_UUID.test(organization) || !CLAUDE_UUID.test(user)) return null;
    return path.join(claude, 'skills', 'synced', `${organization}_${user}`);
  } catch { return null; }
}

async function routingRules(scope: SkillLibraryScope): Promise<{
  valid: boolean;
  rules: SkillConfiguration['rules'];
  includeInstructions: boolean;
  maxContextTokens?: number;
}> {
  const rules: SkillConfiguration['rules'] = [];
  let includeInstructions = true;
  let maxContextTokens: number | undefined;
  if (!effectiveCapabilities(getConfig()).read) return { valid: true, rules, includeInstructions };
  const search = await locations(scope);
  for (const file of [...new Set(search.configs)]) {
    try { await approved(file, true); } catch { continue; }
    try {
      const candidate = await approved(file, true);
      if (!(await fs.lstat(candidate.real)).isFile()) throw new Error('Skills configuration must be a regular file');
      const layer = parseSkillConfiguration((await readApproved(file)).text);
      if (layer.includeInstructions !== undefined) includeInstructions = layer.includeInstructions;
      if (layer.maxContextTokens !== undefined) maxContextTokens = layer.maxContextTokens;
      rules.push(...layer.rules.map(rule => rule.path ? { ...rule, path: path.resolve(path.dirname(file), rule.path) } : rule));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { valid: false, rules: [], includeInstructions: false };
    }
  }
  return { valid: true, rules, includeInstructions, ...(maxContextTokens === undefined ? {} : { maxContextTokens }) };
}

export async function managedSkillRoutingMetadata(scope: SkillLibraryScope = {}): Promise<SkillRoutingMetadata[]> {
  const root = skillsDirectory();
  if (!root) return [];
  const configured = await routingRules(scope);
  if (!configured.valid) return [];
  const enabled = (name: string, file: string): boolean => {
    let value = true;
    for (const rule of configured.rules) if (rule.name === name || (rule.path && samePath(rule.path, file))) value = rule.enabled;
    return value;
  };
  const result: SkillRoutingMetadata[] = [];
  for (const summary of skillCatalogSnapshot()) {
    const directory = path.join(root, summary.id);
    const file = path.join(directory, 'SKILL.md');
    if (!enabled(summary.name, file)) continue;
    const errors: string[] = [];
    const metadata = await interfaceFor(directory, true, errors, summary.id);
    result.push({ id: summary.id, revision: summary.revision, name: summary.name, description: summary.description, ...metadata });
  }
  return result;
}

const CLAUDE_PLUGIN_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

async function claudeEnabledPlugins(file: string, into: Map<string, boolean>, addError: (message: string) => void): Promise<void> {
  let text: string | null;
  try { text = await readOptionalApproved(file); } catch { return; }
  if (!text) return;
  try {
    const enabled = (JSON.parse(text) as { enabledPlugins?: unknown }).enabledPlugins;
    if (!enabled || typeof enabled !== 'object' || Array.isArray(enabled)) return;
    for (const [id, value] of Object.entries(enabled)) if (typeof value === 'boolean') into.set(id, value);
  } catch (error) { addError(`Claude Code settings ${path.basename(file)}: ${errorText(error)}`); }
}

export async function claudePluginCandidates(claudeHome: string, projectReal: string | null, addError: (message: string) => void): Promise<SkillCandidate[]> {
  let installed: string | null;
  try { installed = await readOptionalApproved(path.join(claudeHome, 'plugins', 'installed_plugins.json')); }
  catch { return []; }
  if (!installed) return [];
  let plugins: Record<string, unknown>;
  try {
    const parsed = JSON.parse(installed) as { plugins?: unknown };
    if (!parsed.plugins || typeof parsed.plugins !== 'object' || Array.isArray(parsed.plugins)) throw new Error('installed_plugins.json has no plugins list');
    plugins = parsed.plugins as Record<string, unknown>;
  } catch (error) { addError(`Claude Code plugins: ${errorText(error)}`); return []; }
  const enabled = new Map<string, boolean>();
  await claudeEnabledPlugins(path.join(claudeHome, 'settings.json'), enabled, addError);
  if (projectReal) for (const name of ['settings.json', 'settings.local.json']) {
    await claudeEnabledPlugins(path.join(projectReal, '.claude', name), enabled, addError);
  }
  let cache: Awaited<ReturnType<typeof approvedDirectory>>;
  try { cache = await approvedDirectory(path.join(claudeHome, 'plugins', 'cache')); } catch { return []; }
  if (!cache) return [];
  const result: SkillCandidate[] = [];
  for (const [pluginId, entries] of Object.entries(plugins).slice(0, 128)) {
    if (enabled.get(pluginId) !== true || !Array.isArray(entries)) continue;
    const [pluginName, marketplaceName, extra] = pluginId.split('@');
    if (extra !== undefined || !pluginName || !marketplaceName || !CLAUDE_PLUGIN_SEGMENT.test(pluginName) || !CLAUDE_PLUGIN_SEGMENT.test(marketplaceName)) continue;
    const entry = (entries as Array<Record<string, unknown>>).find(row => row && typeof row === 'object' && typeof row.installPath === 'string' &&
      (row.scope === 'user' || ((row.scope === 'project' || row.scope === 'local') && typeof row.projectPath === 'string' &&
        projectReal !== null && samePath(row.projectPath, projectReal))));
    if (!entry) continue;
    try {
      const packageDirectory = path.resolve(entry.installPath as string);
      const checked = await approvedDirectory(packageDirectory);
      if (!checked || !samePath(checked.real, packageDirectory) || !isContained(cache.real, checked.real)) throw new Error('installed package is not in Claude Code\'s plugin cache');
      const skills = path.join(checked.real, 'skills');
      const checkedSkills = await approvedDirectory(skills);
      if (!checkedSkills || !samePath(checkedSkills.real, skills)) continue;
      const version = typeof entry.version === 'string' && entry.version.length <= 160 ? entry.version : path.basename(checked.real);
      result.push({ file: checkedSkills.real, scope: 'user', source: 'claude-plugin', claudePlugin: { pluginId, pluginName, marketplaceName, version } });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') addError(`Claude Code plugin ${pluginId}: ${errorText(error)}`);
    }
  }
  return result;
}

export function claudePluginSkillIdentity(plugin: ClaudePluginCandidate, skillPath: string): string {
  return `claude\0${plugin.marketplaceName}\0${plugin.pluginName}\0${skillPath.replaceAll('\\', '/')}`;
}

export async function linkIntoDiscoveryRoot(link: string, roots: SkillCandidate[]): Promise<boolean> {
  try {
    const target = await fs.realpath(link);
    const here = await fs.realpath(path.dirname(link));
    for (const root of roots) {
      let real: string;
      try { real = (await approved(root.file)).real; } catch { continue; }
      if (isContained(real, target) && !isContained(real, here)) return true;
    }
  } catch { /* A dangling link is reported like any other. */ }
  return false;
}
