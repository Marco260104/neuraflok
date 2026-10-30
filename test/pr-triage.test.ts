import { expect, it } from 'vitest';
// @ts-expect-error The triage is a plain Node script without type declarations.
import { SIZE_MARK as sizeMark, WELCOME_MARK as welcomeMark, areasFor as areas, triage as run } from '../scripts/pr-triage.mjs';

type File = { filename: string; additions: number; deletions: number };
type Input = { pr: { labels: Array<{ name: string }>; author_association: string }; files: File[]; comments: Array<{ body: string }> };
const areasFor = areas as (files: File[]) => string[];
const triage = run as (input: Input) => { labels: string[]; comments: string[] };
const SIZE_MARK = sizeMark as string, WELCOME_MARK = welcomeMark as string;
const file = (filename: string, lines = 10): File => ({ filename, additions: lines, deletions: 0 });

it('labels a PR by the areas its files touch, as the labeler config did', () => {
  expect(areasFor([file('backend/domains/browser/bridge.ts'), file('frontend/locales/de.json'), file('README.md'), file('test/x.test.ts')]))
    .toEqual(['area: app', 'area: interface', 'area: translations', 'documentation']);
  expect(areasFor([file('browser-extension/src/background/service-worker.js'), file('.circleci/config.yml'), file('docs/release-notes/v0.1.0.md')]))
    .toEqual(['area: browser companion', 'area: ci', 'documentation']);
});

it('adds only missing labels, welcomes a first-time contributor once, and notes a large PR once', () => {
  const big = [file('backend/domains/browser/bridge.ts', 900), file('browser-extension/src/background/service-worker.js', 200), file('test/bridge.test.ts', 5000)];
  const first = triage({ pr: { labels: [{ name: 'area: app' }], author_association: 'FIRST_TIME_CONTRIBUTOR' }, files: big, comments: [] });
  expect(first.labels).toEqual(['area: browser companion']);
  expect(first.comments).toHaveLength(2);
  expect(first.comments[0]).toContain(WELCOME_MARK);
  expect(first.comments[1]).toContain('about 1100 lines');
  const again = triage({ pr: { labels: [{ name: 'area: app' }, { name: 'area: browser companion' }], author_association: 'FIRST_TIME_CONTRIBUTOR' },
    files: big, comments: first.comments.map(body => ({ body })) });
  expect(again).toEqual({ labels: [], comments: [] });
});

it('stays quiet for a regular contributor with a normal-sized PR', () => {
  const todo = triage({ pr: { labels: [], author_association: 'CONTRIBUTOR' }, files: [file('backend/domains/browser/bridge.ts', 300)], comments: [{ body: `${SIZE_MARK} old` }] });
  expect(todo).toEqual({ labels: ['area: app'], comments: [] });
});

it('does not welcome again a first-timer the earlier welcome action already greeted', () => {
  const todo = triage({ pr: { labels: [{ name: 'area: app' }], author_association: 'FIRST_TIME_CONTRIBUTOR' },
    files: [file('backend/domains/browser/bridge.ts')], comments: [{ body: 'Thanks for your first pull request, and welcome! 👋' }] });
  expect(todo.comments).toEqual([]);
});
