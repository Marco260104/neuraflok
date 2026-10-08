import { expect, it } from 'vitest';
// @ts-expect-error The digest is a plain Node script without type declarations.
import { digest as build, prState as state } from '../scripts/weekly-digest.mjs';
// @ts-expect-error The scheduled publisher is a plain Node script without type declarations.
import { publishWeeklyDigest } from '../scripts/weekly-digest/run.mjs';
// @ts-expect-error The GitHub API adapter is a plain Node script without type declarations.
import { createGitHubClient } from '../scripts/weekly-digest/github-client.mjs';

type Row = { number: number; title: string; by?: string; state: string };
const prState = state as (input: { checks: string; lastPushAt: string; lastMaintainerAt?: string }) => string | null;
const digest = build as (input: { date: string; prs: Row[]; issues: Row[] }) => string;

it('sorts contributor PRs into waiting for a review or waiting for their author', () => {
  expect(prState({ checks: 'success', lastPushAt: '2026-10-02T00:00:00Z' })).toBe('review');
  expect(prState({ checks: 'success', lastPushAt: '2026-10-02T00:00:00Z', lastMaintainerAt: '2026-10-01T00:00:00Z' })).toBe('review');
  expect(prState({ checks: 'success', lastPushAt: '2026-10-02T00:00:00Z', lastMaintainerAt: '2026-10-03T00:00:00Z' })).toBe('author');
  expect(prState({ checks: 'failure', lastPushAt: '2026-10-02T00:00:00Z' })).toBe('author');
  expect(prState({ checks: 'pending', lastPushAt: '2026-10-02T00:00:00Z' })).toBeNull();
});

it('writes every section, saying so when one is empty', () => {
  const text = digest({ date: '2026-10-05', prs: [{ number: 774, title: 'Live row', by: 'Haz4rdovisk', state: 'review' }],
    issues: [{ number: 820, title: 'Stream recovery polling timed out', by: 'mahadansar', state: 'unanswered' }] });
  expect(text).toContain('### Green and waiting for a review\n\n- #774 Live row (@Haz4rdovisk)');
  expect(text).toContain('### Waiting for their authors\n\nNothing right now.');
  expect(text).toContain('### New issues without an answer yet\n\n- #820 Stream recovery polling timed out (@mahadansar)');
  expect(text).toContain('### Waiting for their reporters (needs-info)\n\nNothing right now.');
});

it('collects repository state, closes the previous report, and publishes through the injected client', async () => {
  const requests: string[] = [];
  const updates: Array<{ route: string; payload: unknown }> = [];
  const publications: Array<{ route: string; payload: { title: string; body: string } }> = [];
  const client = {
    async get(route: string) {
      requests.push(route);
      if (route.endsWith('/pulls?state=open&per_page=100')) return [{
        number: 7,
        title: 'Contributor change',
        draft: false,
        author_association: 'FIRST_TIME_CONTRIBUTOR',
        user: { login: 'contributor', type: 'User' },
        head: { sha: 'commit-7' },
        created_at: '2026-10-16T09:00:00Z'
      }];
      if (route.endsWith('/check-runs?per_page=100')) return { check_runs: [{ status: 'completed', conclusion: 'success' }] };
      if (route.endsWith('/pulls/7/commits?per_page=100')) return [{ commit: { committer: { date: '2026-10-17T09:00:00Z' } } }];
      if (route.endsWith('/pulls/7/reviews?per_page=100')) return [];
      if (route.endsWith('/issues/7/comments?per_page=100')) return [];
      if (route.endsWith('/issues?state=open&per_page=100')) return [
        { number: 11, title: 'Needs details', labels: [{ name: 'needs-info' }], created_at: '2026-08-01T09:00:00Z', author_association: 'NONE', user: { login: 'reporter' } },
        { number: 12, title: 'Answered issue', labels: [], created_at: '2026-10-16T09:00:00Z', author_association: 'NONE', user: { login: 'reporter' }, comments: 1 },
        { number: 13, title: 'Fresh unanswered issue', labels: [], created_at: '2026-10-16T09:00:00Z', author_association: 'NONE', user: { login: 'reporter' }, comments: 0 },
        { number: 14, title: 'Old issue', labels: [], created_at: '2026-08-01T09:00:00Z', author_association: 'NONE', user: { login: 'reporter' }, comments: 0 }
      ];
      if (route.endsWith('/issues/12/comments?per_page=100')) return [{ author_association: 'MEMBER' }];
      if (route.includes('creator=github-actions%5Bbot%5D')) return [{ number: 90, title: 'Maintainer digest: previous week' }];
      throw new Error(`Unexpected GitHub route: ${route}`);
    },
    async patch(route: string, payload: unknown) { updates.push({ route, payload }); return {}; },
    async post(route: string, payload: { title: string; body: string }) { publications.push({ route, payload }); return { number: 91 }; }
  };

  const result = await publishWeeklyDigest({ repository: 'team/neuraflok', client, now: new Date('2026-10-18T12:00:00Z') });

  expect(result.prs).toEqual([{ number: 7, title: 'Contributor change', by: 'contributor', state: 'review' }]);
  expect(result.issues.map((issue: { number: number; state: string }) => [issue.number, issue.state])).toEqual([
    [11, 'needs-info'], [13, 'unanswered']
  ]);
  expect(updates).toEqual([{
    route: '/repos/team/neuraflok/issues/90',
    payload: { state: 'closed', state_reason: 'completed' }
  }]);
  expect(publications).toHaveLength(1);
  const [publication] = publications;
  if (!publication) throw new Error('The weekly report was not published');
  expect(publication.route).toBe('/repos/team/neuraflok/issues');
  expect(publication.payload.title).toBe('Maintainer digest: week of 2026-10-18');
  expect(publication.payload.body).toContain('- #13 Fresh unanswered issue (@reporter)');
  expect(requests).toContain('/repos/team/neuraflok/issues/12/comments?per_page=100');
});

it('attaches the repository token and API version to GitHub requests', async () => {
  let observed: { url: string; options: { method?: string; headers?: Record<string, string>; body?: string } } | null = null;
  const client = createGitHubClient('test-token', async (
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string }
  ) => {
    observed = { url, options };
    return { ok: true, json: async () => ({ number: 1 }) };
  });

  await client.post('/repos/team/neuraflok/issues', { title: 'Digest', body: 'Summary' });

  expect(observed).toEqual({
    url: 'https://api.github.com/repos/team/neuraflok/issues',
    options: {
      method: 'POST',
      body: JSON.stringify({ title: 'Digest', body: 'Summary' }),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer test-token',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'neuraflok-weekly-digest'
      }
    }
  });
});
