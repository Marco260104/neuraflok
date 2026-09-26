// Scoped Skill discovery stays within NEURAFLOK's workspace boundaries.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { rawPromises as fs } from '../workspace/rawfs.js';
import { effectiveCapabilities, getConfig } from '../../infrastructure/settings/config.js';
import { isContained } from '../../infrastructure/settings/sandbox.js';
import { listSkills, readSkill, skillCatalogSnapshot, skillsDirectory } from './storage/catalog.js';
import type { SkillDocument } from './storage/core.js';
import { approvedManagedSkillLink } from './access/managed-links.js';
import { parseSkillConfiguration, parseSkillFrontmatter, type SkillConfiguration } from './skill-metadata.js';
import type { SkillLibrary } from '../../../contracts/skills.js';
import { approved, errorText, identity, interfaceFor, readApproved, samePath } from './skill-library-access.js';
import { claudePluginCandidates, claudePluginSkillIdentity, linkIntoDiscoveryRoot, locations } from './skill-library-sources.js';
export { skillLibraryInstructions } from './skill-library-instructions.js';
import type { SkillLibraryScope } from './skill-library-types.js';
export { managedSkillRoutingMetadata } from './skill-library-sources.js';
export type { SkillLibraryScope } from './skill-library-types.js';

export async function listSkillLibrary(scope: SkillLibraryScope = {}): Promise<SkillLibrary> {
  const managed = scope.managedFromCatalog
    ? skillCatalogSnapshot().map(({ revision: _revision, ...summary }) => summary)
    : await listSkills();
  const library: SkillLibrary = { skills: [], roots: [], errors: [], includeInstructions: true };
  const root = skillsDirectory();
  if (!root) return library;
  library.roots.push({ path: '/skills', scope: 'managed', source: 'managed' });
  const addError = (message: string): void => { if (library.errors.length < 64) library.errors.push(message.slice(0, 600)); };
  const config: SkillConfiguration = { rules: [] };
  let invalidConfiguration = false;
  const search = effectiveCapabilities(getConfig()).read ? await locations(scope) : { roots: [], configs: [], claudeHome: '', projectReal: null };
  for (const file of [...new Set(search.configs)]) {
    try { await approved(file, true); } catch { continue; }
    try {
      // Resolve a missing optional path only to its approved ancestor before stat; sandbox's public missing-file diagnostic deliberately does not expose ENOENT.
      const candidate = await approved(file, true);
      if (!(await fs.lstat(candidate.real)).isFile()) throw new Error('Skills configuration must be a regular file');
      const text = (await readApproved(file)).text;
      const layer = parseSkillConfiguration(text);
      if (layer.includeInstructions !== undefined) config.includeInstructions = layer.includeInstructions;
      if (layer.bundledEnabled !== undefined) config.bundledEnabled = layer.bundledEnabled;
      if (layer.maxContextTokens !== undefined) config.maxContextTokens = layer.maxContextTokens;
      config.rules.push(...layer.rules.map(rule => rule.path ? { ...rule, path: path.resolve(path.dirname(file), rule.path) } : rule));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        addError(`Skills configuration: ${errorText(error)}`);
        invalidConfiguration = true;
      }
    }
  }
  if (search.claudeHome) search.roots.push(...await claudePluginCandidates(search.claudeHome, search.projectReal, addError));
  library.includeInstructions = !invalidConfiguration && (config.includeInstructions ?? true);
  if (config.maxContextTokens !== undefined) library.maxContextTokens = config.maxContextTokens;
  const enabled = (name: string, file: string): boolean => {
    let value = true;
    for (const rule of config.rules) if (rule.name === name || (rule.path && samePath(rule.path, file))) value = rule.enabled;
    return value;
  };
  const seen = new Set<string>();
  for (const summary of managed) {
    const directory = path.join(root, summary.id), file = path.join(directory, 'SKILL.md');
    const document = scope.managedFromCatalog ? null : await readSkill(summary.id);
    let seenFile = file;
    try {
      const directoryStat = await fs.lstat(directory);
      if (directoryStat.isSymbolicLink()) {
        const currentConfig = getConfig();
        const linked = effectiveCapabilities(currentConfig).read
          ? await approvedManagedSkillLink(root, summary.id, currentConfig.roots)
          : null;
        if (linked) seenFile = path.join(linked.real, 'SKILL.md');
      }
    } catch { /* readSkill already owns validity; dedupe must not widen filesystem authority. */ }
    let metadata = { name: summary.name, description: summary.description };
    if (document) try { metadata = { ...metadata, ...parseSkillFrontmatter(document.text) }; } catch { /* Existing plain Markdown remains supported. */ }
    if (!enabled(metadata.name, file)) continue;
    const extra = await interfaceFor(directory, true, library.errors, summary.id);
    library.skills.push({ ...summary, ...metadata, ...extra, scope: 'managed', source: 'managed', managed: true });
    seen.add(identity(seenFile));
  }
  let entries = 0, directories = 0;
  const seenDirectories = new Set<string>();
  for (const candidate of search.roots) {
    if (candidate.scope === 'system' && config.bundledEnabled === false) continue;
    let resolved: Awaited<ReturnType<typeof approved>>;
    try {
      resolved = await approved(candidate.file);
      if (!(await fs.lstat(resolved.real)).isDirectory()) continue;
    } catch { continue; }
    library.roots.push({ path: resolved.virtual, scope: candidate.scope, source: candidate.source });
    const queue = [{ directory: resolved.real, depth: 0 }];
    while (queue.length) {
      const current = queue.shift()!;
      if (seenDirectories.has(identity(current.directory))) continue;
      seenDirectories.add(identity(current.directory));
      if (++directories > 512 || entries > 4096 || library.skills.length >= 512) { addError('Skill discovery reached its bounded catalog limit; remaining paths were not scanned'); return library; }
      try {
        let checked: Awaited<ReturnType<typeof approved>>;
        try { checked = await approved(current.directory); }
        catch (error) {
          if (await linkIntoDiscoveryRoot(current.directory, search.roots)) continue;
          throw error;
        }
        if (!isContained(resolved.real, checked.real) || !samePath(checked.real, current.directory)) {
          if (await linkIntoDiscoveryRoot(current.directory, search.roots)) continue;
          throw new Error('Linked Skill folder leaves its discovery root');
        }
        const file = path.join(current.directory, 'SKILL.md');
        let hasSkill = false;
        try {
          const stat = await fs.lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('SKILL.md must be a regular file');
          hasSkill = true;
          const document = await readApproved(file);
          if (!isContained(resolved.real, document.real)) throw new Error('Skill file leaves its discovery root');
          if (!seen.has(identity(document.real))) {
            const metadata = parseSkillFrontmatter(document.text);
            if (enabled(metadata.name, document.real)) {
              const skillPath = path.relative(resolved.real, current.directory).split(path.sep).join('/');
              const claudePlugin = candidate.claudePlugin ? { ...candidate.claudePlugin, skillPath } : undefined;
              const hash = createHash('sha256').update(claudePlugin ? claudePluginSkillIdentity(candidate.claudePlugin!, skillPath) : identity(document.real)).digest('hex').slice(0, 12);
              const stem = path.basename(current.directory).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 35) || 'skill';
              const id = `${stem}--${claudePlugin ? 'claude' : candidate.scope}-${hash}`;
              library.skills.push({ id, ...metadata, path: document.virtual, ...await interfaceFor(current.directory, false, library.errors),
                scope: candidate.scope, source: candidate.source, managed: false, ...(claudePlugin ? { claudePlugin } : {}) });
              seen.add(identity(document.real));
            }
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') addError(`${candidate.source}: ${errorText(error)}`); }
        if (hasSkill) continue; // Package references are resources, not a second catalog.
        for await (const entry of await fs.opendir(current.directory)) {
          if (++entries > 4096) break;
          if (entry.name.startsWith('.') || current.depth >= 6) continue;
          if (current.depth === 0 && candidate.skipTop === entry.name) continue;
          if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
          else if (entry.isSymbolicLink() && !await linkIntoDiscoveryRoot(path.join(current.directory, entry.name), search.roots)) addError(`${candidate.source}: linked entry ignored`);
        }
      } catch (error) { addError(`${candidate.source}: ${errorText(error)}`); }
    }
  }
  if (scope.projectPath) await approved(scope.projectPath);
  return library;
}

export async function readLibrarySkill(id: string, scope: SkillLibraryScope = {}, library?: SkillLibrary): Promise<SkillDocument> {
  const current = library ?? await listSkillLibrary(scope);
  const selected = current.skills.find(skill => skill.id === id);
  if (!selected) throw new Error(`Skill "${id}" is unavailable in this project. Select it again or remove its command.`);
  if (selected.managed) {
    const document = await readSkill(id);
    return { summary: selected, text: document.text };
  }
  const document = await readApproved(selected.path);
  // Commands are derived from canonical paths, not catalog ordering or mutable names.
  const hash = createHash('sha256').update(selected.claudePlugin
    ? claudePluginSkillIdentity(selected.claudePlugin, selected.claudePlugin.skillPath)
    : identity(document.real)).digest('hex').slice(0, 12);
  if (!id.endsWith(`-${hash}`)) throw new Error('The selected Skill changed location');
  return { summary: selected, text: document.text };
}

