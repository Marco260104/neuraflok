import { expect, it } from 'vitest';
// @ts-expect-error The finder is a plain Node script without type declarations.
import { commentFor as comment, similarIssues as similar, similarity as score } from '../scripts/similar-issues.mjs';

type Issue = { number: number; title: string; state?: string; pull_request?: object };
const similarity = score as (a: string, b: string) => number;
const similarIssues = similar as (issue: Issue, candidates: Issue[]) => Issue[];
const commentFor = comment as (matches: Issue[]) => string;

it('finds a related browser-companion report and ignores issues that only share a topic', () => {
  const issue = { number: 120, title: 'Provider tab reload disconnects the browser companion' };
  const candidates: Issue[] = [
    { number: 95, title: 'Provider tab reload disconnects the browser companion after updates', state: 'closed' },
    { number: 87, title: 'Provider sign-in page fails to load after an update' },
    { number: 61, title: 'Setup cannot find a signed-in provider tab' },
    { number: 120, title: 'itself' },
    { number: 96, title: 'Browser companion reloads the provider tab too often', pull_request: {} }
  ];
  expect(similarIssues(issue, candidates).map(match => match.number)).toEqual([95]);
});

it('does not match titles that only share filler words or versions', () => {
  expect(similarity('[2.1.20] The chat is not working', '[2.1.14] The app is not working again')).toBe(0);
  expect(similarity('Goal says why it stopped', 'Goal says why it stopped')).toBe(1);
});

it('writes a gentle note that marks closed matches', () => {
  const text = commentFor([{ number: 805, title: 'Reload note in the new chat', state: 'closed' }]);
  expect(text).toContain('- #805 Reload note in the new chat (closed)');
  expect(text).toContain('just ignore this note');
});
