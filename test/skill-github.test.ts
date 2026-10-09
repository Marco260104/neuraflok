import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { githubSkillUrl, parseGitHubSkillUrl, validGitHubSkillOrigin } from '../contracts/skills.js';
import { checkGitHubSkillUpdates } from '../backend/domains/skills/github/updates.js';
import { importGitHubSkill, linkGitHubSkill, updateGitHubSkill } from '../backend/domains/skills/github/lifecycle.js';
import { initSkillsPath, listManagedSkills } from '../backend/domains/skills/storage/catalog.js';
import { importSkillPackage } from '../backend/domains/skills/storage/packages.js';
import { removeSkill } from '../backend/domains/skills/storage/local-files.js';

let userData = '';
const json = (data: unknown): Response => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
const blobSha = (bytes: Buffer): string => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

function githubFixture() {
  let version = 0;
  let blocked: (() => void) | null = null;
  let release: (() => void) | null = null;
  let blockTree: (() => void) | null = null;
  let releaseTree: (() => void) | null = null;
  let truncated = false;
  const review = Buffer.from('---\nname: Review\ndescription: Read the change.\n---\nReview carefully.\n');
  const contents = [
    { skill: Buffer.from('---\nname: Test Skill\ndescription: Version one.\n---\nUse guide.\n'), guide: Buffer.from('First guide') },
    { skill: Buffer.from('---\nname: Test Skill\ndescription: Version two.\n---\nUse updated guide.\n'), guide: Buffer.from('Second guide') },
    { skill: Buffer.from('---\nname: Test Skill\ndescription: Version one.\n---\nUse guide.\n'), guide: Buffer.from('Changed resource only') }
  ];
  const request = vi.fn(async (input: string) => {
    const url = new URL(input);
    expect(url.origin).toBe('https://api.github.com');
    const files = contents[version]!;
    if (url.pathname.endsWith('/commits/main')) {
      if (blocked) { blocked(); await new Promise<void>(resolve => { release = resolve; }); blocked = null; }
      return json({ sha: ['a', 'b', 'c'][version]!.repeat(40) });
    }
    if (url.pathname.endsWith('/git/trees/main')) {
      if (blockTree) { blockTree(); await new Promise<void>(resolve => { releaseTree = resolve; }); blockTree = null; }
      return json({ sha: 'd'.repeat(40), truncated, tree: [
        { path: 'sample-skill', type: 'tree', mode: '040000', sha: 'e'.repeat(40) },
        { path: 'sample-skill/SKILL.md', type: 'blob', mode: '100644', sha: blobSha(files.skill), size: files.skill.length },
        { path: 'sample-skill/references', type: 'tree', mode: '040000', sha: 'f'.repeat(40) },
        { path: 'sample-skill/references/guide.md', type: 'blob', mode: '100644', sha: blobSha(files.guide), size: files.guide.length },
        { path: 'review', type: 'tree', mode: '040000', sha: '1'.repeat(40) },
        { path: 'review/SKILL.md', type: 'blob', mode: '100644', sha: blobSha(review), size: review.length }
      ] });
    }
    if (url.pathname.endsWith('/contents/sample-skill')) return json([
      { name: 'SKILL.md', path: 'sample-skill/SKILL.md', type: 'file', sha: blobSha(files.skill), size: files.skill.length },
      { name: 'references', path: 'sample-skill/references', type: 'dir', sha: 'c'.repeat(40), size: 0 }
    ]);
    if (url.pathname.endsWith('/contents/sample-skill/references')) return json([
      { name: 'guide.md', path: 'sample-skill/references/guide.md', type: 'file', sha: blobSha(files.guide), size: files.guide.length }
    ]);
    if (url.pathname.endsWith('/contents/review')) return json([
      { name: 'SKILL.md', path: 'review/SKILL.md', type: 'file', sha: blobSha(review), size: review.length }
    ]);
    const sha = url.pathname.split('/').at(-1);
    for (const bytes of [files.skill, files.guide, review]) {
      if (sha === blobSha(bytes)) return json({ content: bytes.toString('base64'), encoding: 'base64', sha, size: bytes.length });
    }
    return new Response('Not found', { status: 404 });
  });
  return {
    request,
    next: () => { version = 1; },
    resourceOnly: () => { version = 2; },
    pauseCommit: () => new Promise<void>(resolve => { blocked = resolve; }),
    resume: () => { release?.(); release = null; },
    pauseTree: () => new Promise<void>(resolve => { blockTree = resolve; }),
    resumeTree: () => { releaseTree?.(); releaseTree = null; },
    truncateTree: () => { truncated = true; }
  };
}

beforeEach(async () => {
  userData = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neuraflok-github-skills-test-')));
  await initSkillsPath(userData);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  if (userData) await fs.rm(userData, { recursive: true, force: true });
});

it('accepts only explicit GitHub skill folders or SKILL.md links', () => {
  expect(parseGitHubSkillUrl('https://github.com/openai/skills/tree/main/skills/.curated/sample-skill')).toEqual({
    owner: 'openai', repository: 'skills', ref: 'main', directory: 'skills/.curated/sample-skill'
  });
  expect(parseGitHubSkillUrl('https://github.com/openai/skills/blob/main/skills/.curated/sample-skill/SKILL.md').directory)
    .toBe('skills/.curated/sample-skill');
  for (const url of [
    'http://github.com/acme/skills/tree/main/sample-skill',
    'https://github.com.evil.test/acme/skills/tree/main/sample-skill',
    'https://github.com/acme/skills/tree/main/%2e%2e/sample-skill',
    'https://github.com/acme/skills/tree/main/sample-skill?raw=1',
    'https://github.com/acme/skills/blob/main/sample-skill/README.md'
  ]) expect(() => parseGitHubSkillUrl(url)).toThrow();
});

it('round-trips canonical package origins and rejects altered metadata', () => {
  const location = parseGitHubSkillUrl('https://github.com/acme/skills/tree/main/sample-skill');
  expect(location.ref).toBe('main');
  expect(githubSkillUrl({ ...location, ref: location.ref! })).toBe('https://github.com/acme/skills/tree/main/sample-skill');
  const origin = {
    kind: 'github' as const,
    url: 'https://github.com/acme/skills/tree/main/sample-skill',
    ref: 'main',
    directory: 'sample-skill',
    commit: 'a'.repeat(40),
    revision: 'b'.repeat(64),
    skillSha256: 'c'.repeat(64)
  };
  expect(validGitHubSkillOrigin(origin)).toBe(true);
  expect(validGitHubSkillOrigin({ ...origin, directory: 'sample-skill/other' })).toBe(false);
  expect(validGitHubSkillOrigin({ ...origin, revision: 'not-a-hash' })).toBe(false);
});

it('rejects encoded separators and malformed path escapes', () => {
  for (const url of [
    'https://github.com/acme/skills/tree/main/sample%2f..%2fskill',
    'https://github.com/acme/skills/tree/main/sample%5c..%5cskill',
    'https://github.com/acme/skills/tree/main/%E0%A4%A'
  ]) expect(() => parseGitHubSkillUrl(url)).toThrow();
});

it('installs a complete public package, skips unchanged content and replaces changed content recoverably', async () => {
  const github = githubFixture(); vi.stubGlobal('fetch', github.request);
  const installed = await importGitHubSkill('https://github.com/acme/skills/tree/main/sample-skill');
  expect(installed).toHaveLength(1);
  expect(installed[0]).toMatchObject({ id: 'sample-skill', origin: { kind: 'github', ref: 'main', url: 'https://github.com/acme/skills/tree/main/sample-skill' } });
  expect(await fs.readFile(path.join(userData, 'skills/sample-skill/references/guide.md'), 'utf8')).toBe('First guide');
  expect((await updateGitHubSkill('sample-skill', async () => { throw new Error('unchanged skill should not be moved'); })).status).toBe('current');
  github.next();
  const moved: string[] = [];
  const result = await updateGitHubSkill('sample-skill', async directory => {
    moved.push(directory);
    await fs.rename(directory, path.join(userData, 'previous-sample-skill'));
  });
  expect(result.status).toBe('updated');
  expect(moved).toHaveLength(1);
  expect(await fs.readFile(path.join(userData, 'skills/sample-skill/references/guide.md'), 'utf8')).toBe('Second guide');
  expect(await fs.readFile(path.join(userData, 'previous-sample-skill/references/guide.md'), 'utf8')).toBe('First guide');
  expect((await listManagedSkills())[0]!.origin!.revision).not.toBe(installed[0]!.origin!.revision);
});

it('checks all skills from one repository with one metadata request and no downloads', async () => {
  const github = githubFixture(); vi.stubGlobal('fetch', github.request);
  const installedSkill = (await importGitHubSkill('https://github.com/acme/skills/tree/main/sample-skill'))[0]!;
  await importGitHubSkill('https://github.com/acme/skills/tree/main/review');
  github.request.mockClear();
  expect(await checkGitHubSkillUpdates('sample-skill')).toMatchObject([
    { id: 'review', state: 'current' },
    { id: 'sample-skill', originRevision: installedSkill.origin!.revision, state: 'current' }
  ]);
  expect(github.request).toHaveBeenCalledTimes(1);
  expect(new URL(github.request.mock.calls[0]![0]).pathname).toContain('/git/trees/main');
  github.next();
  expect((await checkGitHubSkillUpdates('review')).map(check => [check.id, check.state])).toEqual([
    ['review', 'current'], ['sample-skill', 'available']
  ]);
  expect(await fs.readFile(path.join(userData, 'skills/sample-skill/references/guide.md'), 'utf8')).toBe('First guide');
});

it('detects a changed resource even when SKILL.md has not changed', async () => {
  const github = githubFixture(); vi.stubGlobal('fetch', github.request);
  const installed = (await importGitHubSkill('https://github.com/acme/skills/tree/main/sample-skill'))[0]!;
  github.resourceOnly();
  expect(await checkGitHubSkillUpdates('sample-skill')).toMatchObject([
    { id: 'sample-skill', originRevision: installed.origin!.revision, state: 'available' }
  ]);
  expect(await fs.readFile(path.join(userData, 'skills/sample-skill/references/guide.md'), 'utf8')).toBe('First guide');
});

it('links an older local copy without replacing files, then offers its missing GitHub resources', async () => {
  const github = githubFixture(); vi.stubGlobal('fetch', github.request);
  const source = path.join(userData, 'sources/sample-skill');
  await fs.mkdir(source, { recursive: true });
  const skill = Buffer.from('---\nname: Test Skill\ndescription: Version one.\n---\nUse guide.\n');
  await fs.writeFile(path.join(source, 'SKILL.md'), skill);
  await importSkillPackage(source);
  expect((await listManagedSkills())[0]!.origin).toBeNull();
  const linked = (await linkGitHubSkill('sample-skill', 'https://github.com/acme/skills/tree/main/sample-skill'))[0]!;
  expect(linked.origin?.url).toBe('https://github.com/acme/skills/tree/main/sample-skill');
  expect(await fs.readFile(path.join(userData, 'skills/sample-skill/SKILL.md'))).toEqual(skill);
  await expect(fs.stat(path.join(userData, 'skills/sample-skill/references/guide.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await checkGitHubSkillUpdates('sample-skill')).toMatchObject([{ id: 'sample-skill', state: 'available' }]);
  const updated = await updateGitHubSkill('sample-skill', directory => fs.rename(directory, path.join(userData, 'previous-sample-skill')));
  expect(updated.status).toBe('updated');
  expect(await fs.readFile(path.join(userData, 'skills/sample-skill/references/guide.md'), 'utf8')).toBe('First guide');
  expect(await checkGitHubSkillUpdates('sample-skill')).toMatchObject([{ id: 'sample-skill', state: 'current' }]);
});

it('marks a complete matching local package current immediately after linking', async () => {
  const github = githubFixture(); vi.stubGlobal('fetch', github.request);
  const source = path.join(userData, 'sources/review');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: Review\ndescription: Read the change.\n---\nReview carefully.\n');
  await importSkillPackage(source);
  await linkGitHubSkill('review', 'https://github.com/acme/skills/tree/main/review');
  expect(await checkGitHubSkillUpdates('review')).toMatchObject([{ id: 'review', state: 'current' }]);
  await expect(linkGitHubSkill('review', 'https://github.com/acme/skills/tree/main/review')).rejects.toThrow('Only local skills');
});

it('refuses a source with a different SKILL.md and does not attach metadata after removal', async () => {
  const github = githubFixture(); vi.stubGlobal('fetch', github.request);
  const source = path.join(userData, 'sources/sample-skill');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: Other\ndescription: Different instructions.\n---\nDifferent instructions.\n');
  await importSkillPackage(source);
  await expect(linkGitHubSkill('sample-skill', 'https://github.com/acme/skills/tree/main/sample-skill')).rejects.toThrow('does not match');
  expect((await listManagedSkills())[0]!.origin).toBeNull();
  await fs.writeFile(path.join(userData, 'skills/sample-skill/SKILL.md'), '---\nname: Test Skill\ndescription: Version one.\n---\nUse guide.\n');
  const reached = github.pauseCommit();
  const pending = linkGitHubSkill('sample-skill', 'https://github.com/acme/skills/tree/main/sample-skill');
  await reached;
  await removeSkill('sample-skill', directory => fs.rename(directory, path.join(userData, 'removed-sample-skill')));
  github.resume();
  await expect(pending).rejects.toThrow('removed or changed');
  expect(await listManagedSkills()).toEqual([]);
});

it('does not publish a stale check after removal and fails closed on a truncated tree', async () => {
  const github = githubFixture(); vi.stubGlobal('fetch', github.request);
  await importGitHubSkill('https://github.com/acme/skills/tree/main/sample-skill');
  const reached = github.pauseTree();
  const pending = checkGitHubSkillUpdates('sample-skill');
  await reached;
  await removeSkill('sample-skill', directory => fs.rename(directory, path.join(userData, 'removed-sample-skill')));
  github.resumeTree();
  expect(await pending).toEqual([]);
  await importGitHubSkill('https://github.com/acme/skills/tree/main/review');
  github.truncateTree();
  expect(await checkGitHubSkillUpdates('review')).toMatchObject([{ id: 'review', state: 'error' }]);
});

it('does not resurrect a skill removed while the GitHub check is in flight', async () => {
  const github = githubFixture(); vi.stubGlobal('fetch', github.request);
  await importGitHubSkill('https://github.com/acme/skills/tree/main/sample-skill');
  github.next();
  const reached = github.pauseCommit();
  const pending = updateGitHubSkill('sample-skill', async () => { throw new Error('must not replace a removed skill'); });
  await reached;
  await removeSkill('sample-skill', directory => fs.rename(directory, path.join(userData, 'removed-sample-skill')));
  github.resume();
  await expect(pending).rejects.toThrow('changed while checking for updates');
  expect(await listManagedSkills()).toEqual([]);
});

it('keeps local edits and rejects untrusted origins or unsupported repository links', async () => {
  const github = githubFixture(); vi.stubGlobal('fetch', github.request);
  await importGitHubSkill('https://github.com/acme/skills/tree/main/sample-skill');
  await fs.appendFile(path.join(userData, 'skills/sample-skill/SKILL.md'), '\nLocal note.\n');
  github.next();
  await expect(updateGitHubSkill('sample-skill', async () => {})).rejects.toThrow('local edits');
  expect(await fs.readFile(path.join(userData, 'skills/sample-skill/references/guide.md'), 'utf8')).toBe('First guide');
  await expect(importGitHubSkill('https://github.com.evil.test/acme/skills/tree/main/sample-skill')).rejects.toThrow();
});

it('restores the previous GitHub package after an interrupted directory swap', async () => {
  const github = githubFixture(); vi.stubGlobal('fetch', github.request);
  await importGitHubSkill('https://github.com/acme/skills/tree/main/sample-skill');
  const backup = path.join(userData, 'skills', `.backup-sample-skill-${randomUUID()}`);
  await fs.rename(path.join(userData, 'skills/sample-skill'), backup);
  await initSkillsPath(userData);
  expect((await listManagedSkills())[0]).toMatchObject({ id: 'sample-skill', origin: { kind: 'github' } });
  expect(await fs.readFile(path.join(userData, 'skills/sample-skill/references/guide.md'), 'utf8')).toBe('First guide');
  await expect(fs.stat(backup)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not let a local package forge NEURAFLOK GitHub origin metadata', async () => {
  const source = path.join(userData, 'sources', 'forged');
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: Forged\ndescription: Local skill.\n---\nHello.');
  await fs.writeFile(path.join(source, '.neuraflok-github.json'), '{"kind":"github"}');
  await expect(importSkillPackage(source)).rejects.toThrow('cannot supply NEURAFLOK origin metadata');
  expect(await listManagedSkills()).toEqual([]);
});
