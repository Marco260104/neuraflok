import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const repositoryOwner = (process.env.GITHUB_REPOSITORY ?? '').split('/')[0]?.trim().toLowerCase() ?? '';
const maintainerLogin = (process.env.NEURAFLOK_MAINTAINER_LOGIN ?? repositoryOwner).trim().toLowerCase();
const safeMaintainerEmail = /^(?:\d+\+)?.*@users\.noreply\.github\.com$/i;

// These patterns catch local Windows profiles and private session links without naming an account.
const blockedPatterns = [
  { label: 'private Windows user path', pattern: /[A-Z]:\\+Users\\+[^\\/\s]+/i, git: '[A-Z]:\\\\+Users\\\\+[A-Za-z0-9._-]+' },
  { label: 'private Windows user path', pattern: /[A-Z]:\/+Users\/+[^\\/\s]+/i, git: '[A-Z]:/Users/[A-Za-z0-9._-]+' },
  { label: 'private session provenance', pattern: /https?:\/\/\S+\/session[_-][A-Za-z0-9_-]+/i, git: 'https?://[^[:space:]]+/session[_-][A-Za-z0-9_-]+' },
];
const safePathPlaceholders = new Set(['you', 'example', 'name', 'username', 'yourname', 'someone', 'jane', 'x', 'me', '…']);

const privateEvidence = ['outputs/', '.private-attachments/'];
const ignoredWorkingTreeDirectories = new Set([
  '.git', '.private-attachments', '.tmp', 'coverage', 'dist', 'node_modules', 'out', 'outputs', 'release',
]);

function runGit(args, { allowFailure = false, encoding = 'utf8' } = {}) {
  const result = spawnSync('git', args, {
    cwd: process.cwd(),
    encoding,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      if (allowFailure) return { status: 1, stdout: '', stderr: '' };
      console.warn('git executable not found in PATH; skipping public-history check.');
      process.exit(0);
    }
    throw result.error;
  }
  if (!allowFailure && result.status !== 0) {
    const detail = String(result.stderr ?? '').trim();
    throw new Error(`git ${args[0] ?? ''} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function findBlockedText(text, location) {
  return blockedPatterns
    .filter(({ label, pattern }) => label === 'private Windows user path'
      ? hasPrivateWindowsUserPath(text)
      : pattern.test(text))
    .map(({ label }) => `${location} contains ${label}`);
}

function hasPrivateWindowsUserPath(text) {
  const paths = /[A-Z]:(?:\\+|\/+)Users(?:\\+|\/+)([^\\/\s]+)/ig;
  for (const match of text.matchAll(paths)) {
    const user = (match[1] ?? '').replace(/[,;:'"`)\]}]+$/g, '').replace(/^<|>$/g, '').toLowerCase();
    if (!safePathPlaceholders.has(user) && !/^\.+$/.test(user)) return true;
  }
  return false;
}

function checkMaintainerIdentity(name, email, location) {
  const normalizedName = name.trim().toLowerCase();
  const normalizedEmail = email.trim().replace(/^<|>$/g, '').toLowerCase();
  const belongsToMaintainer = Boolean(maintainerLogin) &&
    (normalizedName === maintainerLogin || normalizedEmail.includes(maintainerLogin));
  if (belongsToMaintainer && !safeMaintainerEmail.test(normalizedEmail)) {
    return [`${location} uses a non-noreply maintainer email`];
  }
  return [];
}

function parseGitIdent(ident) {
  const match = ident.match(/^(.*) <([^>]+)> \d+ [+-]\d{4}$/);
  if (!match) throw new Error('Could not parse the Git author identity.');
  return { name: match[1] ?? '', email: match[2] ?? '' };
}

function checkIndexedOrCommittedFiles(treeish) {
  const failures = [];
  const names = String(runGit(treeish === '--cached'
    ? ['ls-files', '--cached', '-z']
    : ['ls-tree', '-r', '--name-only', '-z', treeish]).stdout).split('\0');
  for (const excluded of privateEvidence) {
    if (names.some(name => excluded.endsWith('/') ? name.startsWith(excluded) : name === excluded)) {
      failures.push(`${treeish} tracks private evidence excluded from publication (${excluded})`);
    }
  }
  for (const { label, git } of blockedPatterns) {
    const args = ['grep', '-n', '-I', '-i', '-E', '-e', git];
    if (treeish === '--cached') args.push('--cached');
    else args.push(treeish);
    args.push('--', '.');
    const result = runGit(args, { allowFailure: true });
    const unsafeMatch = label === 'private Windows user path'
      ? String(result.stdout).split(/\r?\n/).some(hasPrivateWindowsUserPath)
      : result.status === 0;
    if (unsafeMatch) failures.push(`${treeish} contains ${label}`);
    else if (result.status !== 0 && result.status !== 1) throw new Error(`git grep failed while checking ${label}: ${String(result.stderr ?? '').trim()}`);
  }
  return failures;
}

function checkCurrentAuthor() {
  const ident = String(runGit(['var', 'GIT_AUTHOR_IDENT']).stdout).trim();
  const { name, email } = parseGitIdent(ident);
  return checkMaintainerIdentity(name, email, 'current Git author');
}

function checkMessageFile(messagePath) {
  return [
    ...checkCurrentAuthor(),
    ...findBlockedText(readFileSync(messagePath, 'utf8'), 'commit message'),
  ];
}

function hasGitWorktree() {
  const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0 && String(result.stdout).trim() === 'true';
}

function checkWorkingTree() {
  const failures = [];
  let files = 0;
  function walk(directory, relative = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!ignoredWorkingTreeDirectories.has(entry.name)) walk(join(directory, entry.name), childRelative);
      } else if (entry.isFile()) {
        const content = readFileSync(join(directory, entry.name));
        if (content.includes(0)) continue;
        files += 1;
        failures.push(...findBlockedText(content.toString('utf8'), childRelative));
      }
    }
  }
  walk(process.cwd());
  return { failures, files };
}

/** Commits that are already published on the public main line. The gate exists to keep a private value from *entering* public history. A commit that is already on the canonical repository's main has entered it, and refusing every later local push cannot unpublish it — it only strands the working clone, because the merge commits GitHub writes for a merged pull request carry whatever address that account publishes, and no local hook ever saw them. Those are exempt here; everything a local push would actually add stays checked. Removing a value from published history is a deliberate rewrite of a public branch, not something a pre-push hook should be able to demand. A fork's origin may lag upstream. Select by exact repository URL, never by the name "upstream". Without a canonical remote, retain the legacy origin/main convention. If a configured canonical remote has no fetched main, exempt nothing. */
function githubRepositorySlug(url) {
  const match = url.trim().match(/^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function publishedHistoryRef() {
  const remotes = String(runGit(['remote']).stdout).split(/\r?\n/).filter(Boolean);
  const canonicalRepository = (process.env.NEURAFLOK_CANONICAL_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? '').trim().toLowerCase();
  const canonical = remotes.find((remote) => {
    const url = String(runGit(['remote', 'get-url', remote]).stdout).trim();
    return canonicalRepository && githubRepositorySlug(url) === canonicalRepository;
  });
  const publishedRef = `refs/remotes/${canonical ?? 'origin'}/main`;
  const ref = runGit(['rev-parse', '--verify', '--quiet', publishedRef], {
    allowFailure: true,
  });
  return ref.status === 0 ? publishedRef : null;
}

function checkHistory() {
  const failures = [];
  const publishedRef = publishedHistoryRef();
  // Only history that can actually enter the releasable line. `--all` walks every local and remote-tracking ref in the clone, so an unrelated fetched branch — someone else's fork, an abandoned experiment — could fail verification for a clean checked-out branch that never contains it. A fresh CI checkout has no such refs, which is why this passes there and fails locally on a full clone.
  const head = runGit(['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
  const commits =
    head.status === 0
      ? String(runGit(['rev-list', 'HEAD']).stdout)
          .split(/\r?\n/)
          .filter(Boolean)
      : [];
  const revisions = ['HEAD', ...(publishedRef ? ['--not', publishedRef] : [])];
  const format = '%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x00%x00';
  const history = head.status === 0
    ? String(runGit(['log', `--format=${format}`, ...revisions]).stdout)
        .split('\0\0')
        .map((record) => record.replace(/^\r?\n/, ''))
        .filter(Boolean)
        .map((record) => {
          const fields = record.split('\0');
          if (fields.length !== 6 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(fields[0] ?? '')) {
            throw new Error('Could not parse commit metadata while checking public history.');
          }
          return fields;
        })
    : [];
  // pull_request jobs default to a GitHub-generated merge object that can never enter public history. Its identity belongs to GitHub's test ref, not to the proposed tree.
  const syntheticPullRequestCommit =
    process.env.GITHUB_EVENT_NAME === 'pull_request' ? process.env.GITHUB_SHA?.trim() : '';

  for (const [commit, authorName, authorEmail, committerName, committerEmail, message] of history) {
    if (syntheticPullRequestCommit && commit === syntheticPullRequestCommit) continue;
    const location = `commit ${commit}`;
    failures.push(
      ...checkMaintainerIdentity(authorName, authorEmail, `${location} author`),
      ...checkMaintainerIdentity(committerName, committerEmail, `${location} committer`),
      ...findBlockedText(message, `${location} message`),
    );
  }

  // Same rule for tags: an annotated tag reachable from HEAD is part of this line's public history and stays checked. One that is not reachable belongs to a different line.
  const tags =
    head.status === 0
      ? String(runGit(['tag', '--merged', 'HEAD', '--list']).stdout)
          .split(/\r?\n/)
          .filter(Boolean)
      : [];
  for (const tag of tags) {
    const type = String(runGit(['cat-file', '-t', tag]).stdout).trim();
    if (type !== 'tag') continue;
    const record = String(
      runGit([
        'for-each-ref',
        `refs/tags/${tag}`,
        '--format=%(taggername)%00%(taggeremail)%00%(contents)',
      ]).stdout,
    );
    const [taggerName = '', taggerEmail = '', ...body] = record.split('\0');
    failures.push(
      ...checkMaintainerIdentity(taggerName, taggerEmail, `tag ${tag} tagger`),
      ...findBlockedText(body.join('\0'), `tag ${tag} message`),
    );
  }

  if (head.status === 0) failures.push(...checkIndexedOrCommittedFiles('HEAD'));
  return { failures, commits: commits.length, tags: tags.length };
}

function fail(failures) {
  console.error('Public-history privacy check failed:');
  for (const failure of [...new Set(failures)]) console.error(`- ${failure}`);
  process.exitCode = 1;
}

const [mode, argument] = process.argv.slice(2);
if (mode === '--message') {
  if (!argument) throw new Error('--message requires the commit-message file path.');
  const failures = checkMessageFile(argument);
  if (failures.length > 0) fail(failures);
} else if (mode === '--staged') {
  const failures = [...checkCurrentAuthor(), ...checkIndexedOrCommittedFiles('--cached')];
  if (failures.length > 0) fail(failures);
} else if (mode) {
  throw new Error(`Unknown argument: ${mode}`);
} else if (!hasGitWorktree()) {
  const { failures, files } = checkWorkingTree();
  if (failures.length > 0) fail(failures);
  else console.log(`Working-tree privacy check passed (${files} files).`);
} else {
  const { failures, commits, tags } = checkHistory();
  if (failures.length > 0) fail(failures);
  else console.log(`Public-history privacy check passed (${commits} commits, ${tags} tags).`);
}
