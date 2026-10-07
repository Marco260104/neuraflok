/** Builds and publishes the scheduled repository digest. */
import { pathToFileURL } from 'node:url';
import { createGitHubClient } from './weekly-digest/github-client.mjs';
import { publishWeeklyDigest } from './weekly-digest/run.mjs';

export { renderDigest as digest } from './weekly-digest/render.mjs';
export { pullRequestState as prState } from './weekly-digest/pull-requests.mjs';

async function main(environment = process.env) {
  const repository = environment.GITHUB_REPOSITORY;
  const token = environment.GH_TOKEN;
  if (!repository || !token) throw new Error('GITHUB_REPOSITORY and GH_TOKEN are required');
  await publishWeeklyDigest({ repository, client: createGitHubClient(token) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
