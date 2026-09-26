import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { rawPromises as fs } from '../../workspace/rawfs.js';
import { githubSkillUrl, type GitHubSkillOrigin } from '../../../../contracts/skills.js';
import { githubJson, MAX_PACKAGE_BYTES, repositoryEndpoint, type GitHubFile, type GitHubSnapshot } from './api.js';

export async function downloadBlob(base: string, file: GitHubFile, signal: AbortSignal): Promise<Buffer> {
  const payload = await githubJson(`${base}/git/blobs/${file.sha}`, signal, Math.min(MAX_PACKAGE_BYTES * 2, Math.ceil(file.size * 4 / 3) + 4096)) as
    { content?: unknown; encoding?: unknown; sha?: unknown; size?: unknown };
  if (payload.encoding !== 'base64' || payload.sha !== file.sha || payload.size !== file.size || typeof payload.content !== 'string')
    throw new Error(`GitHub file changed during download: ${file.relative}`);
  const encoded = payload.content.replace(/\s/g, '');
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
    throw new Error(`GitHub returned invalid file content: ${file.relative}`);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== file.size) throw new Error(`GitHub file size changed: ${file.relative}`);
  const algorithm = file.sha.length === 40 ? 'sha1' : 'sha256';
  const actual = createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (actual !== file.sha) throw new Error(`GitHub file checksum failed: ${file.relative}`);
  return bytes;
}

export async function stageSkill(snapshot: GitHubSnapshot, signal: AbortSignal): Promise<{ folder: string; origin: GitHubSkillOrigin; cleanup: () => Promise<void> }> {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'neuraflok-github-skill-'));
  const folderName = snapshot.location.directory.split('/').filter(Boolean).at(-1) ?? snapshot.location.repository;
  const folder = path.join(temporary, folderName);
  const base = repositoryEndpoint(snapshot.location);
  let skillSha256 = '';
  try {
    await fs.mkdir(folder);
    for (const file of snapshot.files) {
      const destination = path.join(folder, ...file.relative.split('/'));
      const bytes = await downloadBlob(base, file, signal);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
      if (file.relative === 'SKILL.md') skillSha256 = createHash('sha256').update(bytes).digest('hex');
    }
    const origin: GitHubSkillOrigin = {
      kind: 'github', url: githubSkillUrl(snapshot.location), ref: snapshot.location.ref,
      directory: snapshot.location.directory, commit: snapshot.commit, revision: snapshot.revision, skillSha256
    };
    return { folder, origin, cleanup: () => fs.rm(temporary, { recursive: true, force: true }) };
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
