const MAINTAINER_ROLES = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const DAYS_TO_INCLUDE = 30;
const DAY_MS = 86_400_000;

export async function collectIssueRows(client, repository, now = new Date()) {
  const issues = await client.get(`/repos/${repository}/issues?state=open&per_page=100`);
  const oldestIncluded = now.getTime() - DAYS_TO_INCLUDE * DAY_MS;
  const result = [];

  for (const issue of issues) {
    if (issue.pull_request || issue.title.startsWith('Maintainer digest')) continue;

    if ((issue.labels ?? []).some(label => label.name === 'needs-info')) {
      result.push({ number: issue.number, title: issue.title, state: 'needs-info' });
      continue;
    }

    if (Date.parse(issue.created_at) < oldestIncluded || MAINTAINER_ROLES.has(issue.author_association)) continue;
    const comments = issue.comments
      ? await client.get(`/repos/${repository}/issues/${issue.number}/comments?per_page=100`)
      : [];
    const hasMaintainerReply = comments.some(comment => MAINTAINER_ROLES.has(comment.author_association));
    if (!hasMaintainerReply) result.push({
      number: issue.number,
      title: issue.title,
      by: issue.user.login,
      state: 'unanswered'
    });
  }

  return result;
}
