import type { GitHubSkillLocation } from '../../../../contracts/skills.js';

export const MAX_FILES = 40;
export const MAX_DIRECTORIES = 12;
export const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
export const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9]|lpt[0-9])(?:\.|$)/i;

export type GitHubFile = { relative: string; sha: string; size: number };
export type GitHubSnapshot = {
  location: GitHubSkillLocation & { ref: string };
  commit: string;
  revision: string;
  files: GitHubFile[];
};
export type GitHubTreeEntry = { path: string; type: string; mode: string; sha: string; size?: number };

export function safeName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && name !== '.' && name !== '..' &&
    !/[\\/:*?"<>|\u0000-\u001f]/.test(name) && !/[. ]$/.test(name) && !WINDOWS_DEVICE.test(name);
}

export async function githubJson(endpoint: string, signal: AbortSignal, limit = 1024 * 1024): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${endpoint}`, {
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'NEURAFLOK-Skills' }
    });
  } catch {
    throw new Error(signal.aborted ? 'GitHub download timed out. Try again.' : 'Could not reach GitHub. Try again.');
  }
  if (!response.ok) {
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
      throw new Error('GitHub API rate limit reached. Try again later.');
    if (response.status === 404) throw new Error('GitHub skill folder was not found or is private.');
    throw new Error(`GitHub request failed (${response.status}). Try again later.`);
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) throw new Error('GitHub response is too large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('GitHub returned an empty response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error('GitHub response is too large'); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown; }
  catch { throw new Error('GitHub returned invalid package metadata'); }
}

export function repositoryEndpoint(location: GitHubSkillLocation): string {
  return `/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repository)}`;
}
