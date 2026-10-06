const MAINTAINER_ROLES = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function pullRequestState({ checks, lastPushAt, lastMaintainerAt }) {
  if (checks === 'pending') return null;
  if (checks === 'failure') return 'author';
  return lastMaintainerAt && Date.parse(lastMaintainerAt) > Date.parse(lastPushAt) ? 'author' : 'review';
}

function isExternalContribution(pullRequest) {
  return !pullRequest.draft &&
    !MAINTAINER_ROLES.has(pullRequest.author_association) &&
    pullRequest.user.type !== 'Bot';
}

function latestMaintainerReply(reviews, comments) {
  const times = [
    ...reviews.map(review => ({ time: review.submitted_at, role: review.author_association })),
    ...comments
      .filter(comment => comment.user.type !== 'Bot')
      .map(comment => ({ time: comment.created_at, role: comment.author_association }))
  ]
    .filter(event => MAINTAINER_ROLES.has(event.role) && typeof event.time === 'string')
    .map(event => event.time)
    .filter(time => Number.isFinite(Date.parse(time)));

  return times.reduce((latest, time) => !latest || Date.parse(time) > Date.parse(latest) ? time : latest, null);
}

function checkState(runs) {
  if (runs.some(run => run.status !== 'completed')) return 'pending';
  if (runs.some(run => run.conclusion === 'failure')) return 'failure';
  return 'success';
}

export function classifyPullRequest(pullRequest, { runs, commits, reviews, comments }) {
  if (!isExternalContribution(pullRequest)) return null;

  const state = pullRequestState({
    checks: checkState(runs),
    lastPushAt: commits.at(-1)?.commit.committer.date ?? pullRequest.created_at,
    lastMaintainerAt: latestMaintainerReply(reviews, comments)
  });

  return state ? {
    number: pullRequest.number,
    title: pullRequest.title,
    by: pullRequest.user.login,
    state
  } : null;
}

export async function collectPullRequests(client, repository) {
  const pullRequests = await client.get(`/repos/${repository}/pulls?state=open&per_page=100`);
  const result = [];

  for (const pullRequest of pullRequests) {
    if (!isExternalContribution(pullRequest)) continue;
    const number = pullRequest.number;
    const [runs, commits, reviews, comments] = await Promise.all([
      client.get(`/repos/${repository}/commits/${pullRequest.head.sha}/check-runs?per_page=100`),
      client.get(`/repos/${repository}/pulls/${number}/commits?per_page=100`),
      client.get(`/repos/${repository}/pulls/${number}/reviews?per_page=100`),
      client.get(`/repos/${repository}/issues/${number}/comments?per_page=100`)
    ]);
    const row = classifyPullRequest(pullRequest, { runs: runs.check_runs, commits, reviews, comments });
    if (row) result.push(row);
  }

  return result;
}
