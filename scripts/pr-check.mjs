#!/usr/bin/env node
/** The pull request checklist, enforced before anyone reviews. CONTRIBUTING.md explains each rule; this only decides whether a PR description and its files meet them, so a PR that does not is sent back by CI instead of by a person. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Changed lines outside tests and locale catalogs above this need a stated reason or a split. */
export const MAX_CHANGED_LINES = 600;

const CODE = /^(backend|frontend|contracts|brand|browser-extension|scripts|build)\//;
const TESTS = /^(test\/|scripts\/verify-[^/]+\.cjs$|scripts\/fixtures\/)/;
const CATALOG = /(^|\/)(locales\/[^/]+\.json|_locales\/[^/]+\/messages\.json)$/;
const UI = /^(frontend\/(?!locales\/)|browser-extension\/src\/popup\/|browser-extension\/[^/]+\.(html|css))/;
const STRAY = /(^|\/)(\.DS_Store|Thumbs\.db|npm-debug\.log[^/]*|[^/]+\.log|[^/]+\.orig|[^/]+\.rej)$|^docs\/(worklog|notes|scratch)[^/]*$/i;

/** Files that define contracts between processes, the extension and stored data. */
const CONTRACT = /^(backend\/preload\/[^/]+\.ts|backend\/application\/ipc\/[^/]+\.ts|backend\/features\/integrations\/plugins-ipc\.ts|contracts\/[^/]+\.ts)$/;
const GITHUB_API = 'https://api.github.com';
/** The template's headings and the names contributors already use for the same thing. */
const HEADINGS = {
  why: ['why', 'problem', 'root cause', 'cause', 'summary', 'motivation'],
  what: ['what changed', 'what changes', 'what', 'change', 'changes', 'fix'],
  test: ['test', 'tests', 'testing', 'validation', 'verification'],
  screenshots: ['screenshots', 'screenshot', 'before and after', 'ui']
};

/** Text of the first `##` section with one of these headings, without HTML comments; empty when missing. */
function section(body, key) {
  const names = HEADINGS[key];
  const lines = body.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const heading = /^##\s+(.+?)\s*#*\s*$/.exec(line.trim());
    return !!heading && names.includes(heading[1].toLowerCase().replace(/[:.]$/, ''));
  });
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

/** @param {{ body: string, files: Array<{ path: string, changes: number }>, draft?: boolean, fromFork?: boolean, maintainerCanModify?: boolean }} pr @returns {string[]} what is missing, in words a contributor can act on; empty when it passes */
export function checkPullRequest({ body, files, draft = false, fromFork = false, maintainerCanModify = true }) {
  const problems = [];
  const text = String(body || '');
  // No issue is required: the description carries the why and the what, and discussion happens on the PR itself. A PR that closes an issue says "Fixes #123" so it closes on merge.
  if (section(text, 'why').length < 20) problems.push('Fill in "## Why": the root cause or the user problem, in a few sentences.');
  if (section(text, 'what').length < 20) problems.push('Fill in "## What changed": the behavior change, not a file list.');

  const stray = files.filter((file) => STRAY.test(file.path)).map((file) => file.path);
  if (stray.length) problems.push(`Remove files that do not belong in the repository: ${stray.join(', ')}.`);

  const code = files.filter((file) => CODE.test(file.path) && !TESTS.test(file.path) && !CATALOG.test(file.path));
  const tests = files.filter((file) => TESTS.test(file.path));
  const testSection = section(text, 'test');
  if (code.length) {
    const optedOut = /^no test:\s*\S.{10,}/im.test(testSection);
    if (!tests.length && !optedOut) {
      problems.push('Add or update a test for the behavior change, or write "No test: <reason>" under "## Test".');
    }
    // The checklist verifies that a regression test is present; the normal CI suite executes it.
  }

  if (files.some((file) => UI.test(file.path)) && !/!\[[^\]]*\]\(|<img\s/i.test(section(text, 'screenshots')) &&
      !/^no visual change:\s*\S.{10,}/im.test(text)) {
    problems.push('This changes the interface: add before and after screenshots under "## Screenshots", or write "No visual change: <reason>" when nothing on screen changes.');
  }

  if (files.some((file) => CONTRACT.test(file.path)) && !files.some((file) => file.path === 'ARCHITECTURE.md') &&
      !/^no contract change:\s*\S.{10,}/im.test(text)) {
    problems.push('This changes a shared contract (preload, IPC or shared-contracts): update ARCHITECTURE.md in the same PR, or write "No contract change: <reason>".');
  }
  if (fromFork && !maintainerCanModify) {
    problems.push('Turn on "Allow edits by maintainers" so small fixes can be finished on this PR.');
  }
  if (/\bdepends on\s+#\d+/i.test(text) && !draft) {
    problems.push('This PR depends on another one: keep it a draft until that PR is merged, then rebase on main.');
  }
  const changed = code.reduce((sum, file) => sum + file.changes, 0);
  if (changed > MAX_CHANGED_LINES && !/^large change:\s*\S.{10,}/im.test(text)) {
    problems.push(`${changed} changed lines outside tests and translations (limit ${MAX_CHANGED_LINES}). Split it into smaller PRs, or add a line "Large change: <reason>".`);
  }
  return problems;
}

function changedFiles(base) {
  const raw = execFileSync('git', ['diff', '--numstat', `${base}...HEAD`], { encoding: 'utf8' });
  return raw.split('\n').filter(Boolean).map((line) => {
    const [added, removed, ...rest] = line.split('\t');
    const changes = added === '-' ? 0 : Number(added) + Number(removed);
    return { path: rest.join('\t'), changes };
  });
}

async function circlePullRequest(environment) {
  const candidates = String(environment.CIRCLE_PULL_REQUESTS || environment.CIRCLE_PULL_REQUEST || '')
    .split(',').map(value => value.trim()).filter(Boolean);
  if (!candidates.length) return null;
  const url = new URL(candidates[0]);
  if (url.hostname !== 'github.com') throw new Error('CircleCI pull request URL must point to github.com.');
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
  if (!match) throw new Error(`Unrecognized CircleCI pull request URL: ${url.pathname}`);
  const [, owner, repository, number] = match;
  const apiUrl = `${GITHUB_API}/repos/${owner}/${repository}/pulls/${number}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'neuraflok-circleci-pr-check',
    ...(environment.GH_TOKEN ? { Authorization: `Bearer ${environment.GH_TOKEN}` } : {})
  };
  const request = async target => {
    const response = await fetch(target, { headers });
    if (!response.ok) throw new Error(`GitHub pull request lookup failed with HTTP ${response.status}.`);
    return response.json();
  };
  const pr = await request(apiUrl);
  const files = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await request(`${apiUrl}/files?per_page=100&page=${page}`);
    files.push(...batch.map(file => ({ path: file.filename, changes: file.additions + file.deletions })));
    if (batch.length < 100) return { pr, files };
  }
  throw new Error('The pull request has too many changed files for the CircleCI checklist.');
}

async function main(environment = process.env) {
  let pr;
  let files;
  if (environment.GITHUB_EVENT_PATH) {
    const event = JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH, 'utf8'));
    pr = event.pull_request;
    if (!pr) { console.log('Not a pull request; nothing to check.'); return; }
    files = changedFiles(`origin/${pr.base.ref}`);
  } else {
    const result = await circlePullRequest(environment);
    if (!result) { console.log('Not a pull request; nothing to check.'); return; }
    ({ pr, files } = result);
  }
  const problems = checkPullRequest({
    body: pr.body ?? '', files, draft: pr.draft === true,
    fromFork: pr.head?.repo?.full_name !== pr.base?.repo?.full_name, maintainerCanModify: pr.maintainer_can_modify !== false
  });
  if (!problems.length) { console.log('Pull request checklist passed.'); return; }
  console.log('This pull request is not ready for review yet. See CONTRIBUTING.md.\n');
  for (const problem of problems) console.log(`- ${problem}`);
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
