import type { GitHubSkillLocation, GitHubSkillOrigin } from './types.js';

const GITHUB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const INVALID_PATH_CHARACTER = /[\\/:*?"<>|\u0000-\u001f]/;

function inputPathSegments(input: string): string[] | null {
  const authority = /^https:\/\/[^/?#]+/i.exec(input)?.[0];
  if (!authority) return null;
  const remainder = input.slice(authority.length);
  const path = remainder.split(/[?#]/, 1)[0] ?? '';
  try {
    return path.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
  } catch {
    throw new Error('GitHub skill URL has invalid encoding');
  }
}

function assertSafeSegments(segments: readonly string[]): void {
  if (segments.some(segment =>
    segment === '.' || segment === '..' ||
    INVALID_PATH_CHARACTER.test(segment) || /[. ]$/.test(segment)
  )) {
    throw new Error('GitHub skill URL contains an unsafe path');
  }
}

export function parseGitHubSkillUrl(input: string): GitHubSkillLocation {
  if (input.length > 2048) throw new Error('GitHub skill URL is too long');
  const value = input.trim();
  const parts = inputPathSegments(value);
  if (parts) assertSafeSegments(parts);

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a GitHub skill folder or SKILL.md link');
  }
  if (
    url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port ||
    url.username || url.password || url.search || url.hash
  ) {
    throw new Error('Use a public https://github.com skill link without query parameters');
  }
  if (!parts) throw new Error('Use a public https://github.com skill link without query parameters');
  if (parts.length < 2 || !GITHUB_NAME_PATTERN.test(parts[0]!) || !GITHUB_NAME_PATTERN.test(parts[1]!)) {
    throw new Error('GitHub skill URL needs an owner and repository');
  }

  const [owner, repository, kind, ref, ...directoryParts] = parts;
  if (kind === undefined) return { owner: owner!, repository: repository!, ref: null, directory: '' };
  if ((kind !== 'tree' && kind !== 'blob') || !ref) throw new Error('Use a GitHub folder or SKILL.md link');
  if (kind === 'blob') {
    if (directoryParts.at(-1) !== 'SKILL.md') throw new Error('The GitHub file link must point to SKILL.md');
    directoryParts.pop();
  }

  return { owner: owner!, repository: repository!, ref, directory: directoryParts.join('/') };
}

export function githubSkillUrl(location: GitHubSkillLocation & { ref: string }): string {
  const directory = location.directory
    ? `/${location.directory.split('/').map(encodeURIComponent).join('/')}`
    : '';
  return `https://github.com/${location.owner}/${location.repository}/tree/${encodeURIComponent(location.ref)}${directory}`;
}

export function validGitHubSkillOrigin(value: unknown): value is GitHubSkillOrigin {
  if (value === null || typeof value !== 'object') return false;
  const source = value as Partial<GitHubSkillOrigin>;
  if (
    source.kind !== 'github' || typeof source.url !== 'string' || typeof source.ref !== 'string' ||
    typeof source.directory !== 'string' || !/^[a-f0-9]{40,64}$/.test(source.commit ?? '') ||
    !/^[a-f0-9]{64}$/.test(source.revision ?? '') || !/^[a-f0-9]{64}$/.test(source.skillSha256 ?? '')
  ) return false;

  try {
    const parsed = parseGitHubSkillUrl(source.url);
    return parsed.ref === source.ref && parsed.directory === source.directory &&
      githubSkillUrl({ ...parsed, ref: source.ref }) === source.url;
  } catch {
    return false;
  }
}
