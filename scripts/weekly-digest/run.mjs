import { collectIssueRows } from './issues.mjs';
import { collectPullRequests } from './pull-requests.mjs';
import { renderDigest } from './render.mjs';

const DIGEST_TITLE = 'Maintainer digest';

export async function publishWeeklyDigest({ repository, client, now = new Date() }) {
  if (!repository) throw new Error('GITHUB_REPOSITORY is required');

  const prs = await collectPullRequests(client, repository);
  const issues = await collectIssueRows(client, repository, now);
  const date = now.toISOString().slice(0, 10);
  const previousReports = await client.get(
    `/repos/${repository}/issues?state=open&creator=github-actions%5Bbot%5D&per_page=100`
  );

  for (const report of previousReports) {
    if (report.title.startsWith(DIGEST_TITLE)) {
      await client.patch(`/repos/${repository}/issues/${report.number}`, {
        state: 'closed',
        state_reason: 'completed'
      });
    }
  }

  const issue = await client.post(`/repos/${repository}/issues`, {
    title: `${DIGEST_TITLE}: week of ${date}`,
    body: renderDigest({ date, prs, issues })
  });

  return { date, prs, issues, issue };
}
