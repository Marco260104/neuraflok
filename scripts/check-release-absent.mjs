import { pathToFileURL } from 'node:url';

const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

function releaseLookupUrl(apiBase, repository, tag) {
  const base = apiBase.replace(/\/$/, '');
  return `${base}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`;
}

function releaseLookupHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'neuraflok-release-preflight'
  };
}

function requireReleaseInputs({ repository, tag, token }) {
  if (!repository || !repository.includes('/')) throw new Error('GITHUB_REPOSITORY is missing or invalid');
  if (!tag) throw new Error('Release tag is missing');
  if (!token) throw new Error('GH_TOKEN is missing');
}

async function lookupFailure(response, tag) {
  if (response.status === 200) {
    throw new Error(`Release ${tag} already exists; refusing to overwrite it.`);
  }

  const detail = (await response.text()).trim().replace(/\s+/g, ' ').slice(0, 500);
  const suffix = detail ? `: ${detail}` : '';
  throw new Error(
    `GitHub release lookup failed with HTTP ${response.status}${suffix}; refusing to assume the release is absent.`
  );
}

export async function assertReleaseAbsent({
  repository,
  tag,
  token,
  fetchImpl = globalThis.fetch,
  apiBase = GITHUB_API
}) {
  requireReleaseInputs({ repository, tag, token });

  const response = await fetchImpl(releaseLookupUrl(apiBase, repository, tag), {
    headers: releaseLookupHeaders(token)
  });

  if (response.status === 404) return;
  await lookupFailure(response, tag);
}

async function main(environment = process.env) {
  const tag = environment.TAG || environment.GITHUB_REF_NAME;
  await assertReleaseAbsent({
    repository: environment.GITHUB_REPOSITORY,
    tag,
    token: environment.GH_TOKEN || environment.GITHUB_TOKEN
  });
  process.stdout.write(`Release ${tag} does not exist yet.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
