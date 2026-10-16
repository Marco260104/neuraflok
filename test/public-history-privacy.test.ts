import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.join(process.cwd(), 'scripts', 'verify-public-history.mjs');
const repositories: string[] = [];
const safeEmail = '12345+neuraflok-maintainer@users.noreply.github.com';

function makeRepository(): string {
  const repository = mkdtempSync(path.join(tmpdir(), 'public-history-privacy-'));
  repositories.push(repository);
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repository });
  writeFileSync(path.join(repository, 'README.md'), 'clean\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repository });
  commit(repository, 'Clean root', safeEmail);
  return repository;
}

function commit(repository: string, message: string, email: string): void {
  execFileSync('git', ['commit', '--allow-empty', '-m', message], {
    cwd: repository,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'neuraflok-maintainer',
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: 'neuraflok-maintainer',
      GIT_COMMITTER_EMAIL: email,
    },
  });
}

function tag(repository: string, name: string, message: string, email: string): void {
  execFileSync('git', ['tag', '-a', name, '-m', message], {
    cwd: repository,
    env: {
      ...process.env,
      GIT_COMMITTER_NAME: 'neuraflok-maintainer',
      GIT_COMMITTER_EMAIL: email,
      GIT_AUTHOR_NAME: 'neuraflok-maintainer',
      GIT_AUTHOR_EMAIL: email,
    },
  });
}

function verify(repository: string, args: string[] = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GITHUB_REPOSITORY: 'example/neuraflok', NEURAFLOK_MAINTAINER_LOGIN: 'neuraflok-maintainer', GIT_AUTHOR_NAME: 'neuraflok-maintainer', GIT_AUTHOR_EMAIL: safeEmail },
  });
}

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true });
  }
});

describe('public-history privacy gate', () => {
  it.each(['\\', '\\\\', '/'])('rejects private roots using %s in staged and committed content without echoing them', separator => {
    const repository = makeRepository();
    const privateRoot = ['C:', 'Users', 'private-user'].join(separator);
    writeFileSync(path.join(repository, 'README.md'), `Local root: ${privateRoot}`);
    execFileSync('git', ['add', 'README.md'], { cwd: repository });
    const staged = verify(repository, ['--staged']);
    expect(staged.status).toBe(1);
    expect(staged.stderr).toContain('private Windows user path');
    expect(staged.stderr).not.toContain(privateRoot);
    commit(repository, 'Private fixture', safeEmail);
    expect(verify(repository).status).toBe(1);
  });

  it('allows sanitized Windows path examples in staged and committed content', () => {
    const repository = makeRepository();
    writeFileSync(path.join(repository, 'README.md'), [
      ['C:', 'Users', 'you', 'project'].join('\\'),
      JSON.stringify(['C:', 'Users', 'example'].join('/')),
      JSON.stringify(['C:', 'Users', '...'].join('\\')),
      ['C:', 'Users', '…', 'project'].join('\\\\'),
    ].join('\n'));
    execFileSync('git', ['add', 'README.md'], { cwd: repository });
    const staged = verify(repository, ['--staged']);
    expect(staged.status, staged.stderr).toBe(0);
    commit(repository, 'Sanitized path examples', safeEmail);
    expect(verify(repository).status).toBe(0);
  });

  it.each(['outputs/clean.txt', '.private-attachments/clean.txt', '.private-attachments/history/item.txt'])
    ('rejects tracked evidence %s despite ignore rules and preserves the immutable HEAD check after index-only cleanup', file => {
      const repository = makeRepository();
      mkdirSync(path.dirname(path.join(repository, file)), { recursive: true });
      writeFileSync(path.join(repository, file), 'Local evidence retained');
      writeFileSync(path.join(repository, '.gitignore'), `/${file}\n`);
      execFileSync('git', ['add', '-f', '--', file], { cwd: repository });
      expect(verify(repository, ['--staged']).stderr).toContain('tracks private evidence');
      commit(repository, 'Tracked evidence fixture', safeEmail);
      expect(verify(repository).stderr).toContain('tracks private evidence');
      execFileSync('git', ['rm', '--cached', '--', file], { cwd: repository });
      expect(readFileSync(path.join(repository, file), 'utf8')).toBe('Local evidence retained');
      expect(verify(repository, ['--staged']).status).toBe(0);
      expect(verify(repository).status).toBe(1);
    });

  it('accepts the numeric GitHub noreply identity', () => {
    const repository = makeRepository();
    const result = verify(repository);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('privacy check passed');
  });

  it('scans source files when the workspace has no Git repository', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'privacy-worktree-'));
    repositories.push(workspace);
    writeFileSync(path.join(workspace, 'README.md'), 'Local root: C:\\Users\\example\\project');

    const clean = verify(workspace);

    expect(clean.status, clean.stderr).toBe(0);
    expect(clean.stdout).toContain('Working-tree privacy check passed');

    const privateRoot = ['C:', 'Users', 'private-user'].join('\\');
    writeFileSync(path.join(workspace, 'README.md'), `Local root: ${privateRoot}`);

    const result = verify(workspace);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('private Windows user path');
    expect(result.stderr).not.toContain(privateRoot);
  });

  it('rejects a non-noreply maintainer identity without printing the address', () => {
    const repository = makeRepository();
    const privateEmail = ['neuraflok-maintainer', 'gmail.com'].join('@');
    commit(repository, 'Unsafe identity', privateEmail);

    const result = verify(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('non-noreply maintainer email');
    expect(result.stderr).not.toContain(privateEmail);
  });

  it('rejects private session provenance in commit messages without echoing it', () => {
    const repository = makeRepository();
    const sessionUrl = ['https://provider.example/code/', 'session_privateIdentifier'].join('');
    commit(repository, `Unsafe trailer\n\nPrivate-Session: ${sessionUrl}`, safeEmail);

    const result = verify(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('private session provenance');
    expect(result.stderr).not.toContain(sessionUrl);
  });

  /** A full clone carries refs this branch will never contain: other contributors' fetched branches, abandoned local experiments. Those cannot enter the releasable line, so they are not this gate's business — and failing on them made a clean branch look unsafe. */
  it('passes a clean checked-out line even when an unrelated ref carries unsafe identity', () => {
    const repository = makeRepository();
    const privateEmail = ['neuraflok-maintainer', 'gmail.com'].join('@');
    execFileSync('git', ['checkout', '-q', '-b', 'unrelated'], { cwd: repository });
    commit(repository, 'Unsafe identity on a ref this branch never contains', privateEmail);
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repository });

    const result = verify(repository);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('privacy check passed');
  });

  it('still rejects unsafe identity that is an ancestor of HEAD', () => {
    const repository = makeRepository();
    const privateEmail = ['neuraflok-maintainer', 'gmail.com'].join('@');
    commit(repository, 'Unsafe identity in ancestry', privateEmail);
    commit(repository, 'Clean commit on top', safeEmail);

    const result = verify(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('non-noreply maintainer email');
    expect(result.stderr).not.toContain(privateEmail);
  });

  /** The merge commit GitHub writes for a merged pull request carries whatever address that account publishes, and no local hook ever saw it. Once it is on `origin/main` the value is public, so failing every later push cannot unpublish it — it only strands the clone. Taking it out is a deliberate rewrite of a public branch, not a hook's decision. */
  it('exempts unsafe identity that is already published on origin/main', () => {
    const repository = makeRepository();
    const privateEmail = ['neuraflok-maintainer', 'gmail.com'].join('@');
    commit(repository, 'Unsafe identity merged through the forge', privateEmail);
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repository });
    commit(repository, 'Clean local commit on top', safeEmail);

    const result = verify(repository);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('privacy check passed');
  });

  it.each([
    'https://github.com/example/neuraflok.git',
    'git@github.com:example/neuraflok.git',
    'ssh://git@github.com/example/neuraflok'
  ])('recognizes canonical main under an arbitrary remote name (%s)', (url) => {
    const repository = makeRepository();
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/fork.git'], { cwd: repository });
    execFileSync('git', ['remote', 'add', 'published', url], { cwd: repository });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repository });
    commit(repository, 'Already public canonical commit', ['neuraflok-maintainer', 'gmail.com'].join('@'));
    execFileSync('git', ['update-ref', 'refs/remotes/published/main', 'HEAD'], { cwd: repository });
    commit(repository, 'Local clean change', safeEmail);
    expect(verify(repository).status).toBe(0);
    commit(repository, 'New unpublished unsafe identity', ['neuraflok-maintainer', 'gmail.com'].join('@'));
    expect(verify(repository).status).toBe(1);
  });

  it.each([
    'https://github.com/example/unrelated.git',
    'https://github.com/example/neuraflok-extra.git',
    'https://github.com.example/example/neuraflok.git'
  ])('does not trust an unrelated upstream URL (%s)', (url) => {
    const repository = makeRepository();
    execFileSync('git', ['remote', 'add', 'upstream', url], { cwd: repository });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repository });
    commit(repository, 'Unpublished identity', ['neuraflok-maintainer', 'gmail.com'].join('@'));
    execFileSync('git', ['update-ref', 'refs/remotes/upstream/main', 'HEAD'], { cwd: repository });
    expect(verify(repository).status).toBe(1);
  });

  it('does not fall back to fork history when canonical main has not been fetched', () => {
    const repository = makeRepository();
    execFileSync('git', ['remote', 'add', 'upstream', 'https://github.com/example/neuraflok.git'], { cwd: repository });
    commit(repository, 'Only published on a fork', ['neuraflok-maintainer', 'gmail.com'].join('@'));
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repository });
    expect(verify(repository).status).toBe(1);
  });

  it('still rejects unsafe identity a push would add ahead of origin/main', () => {
    const repository = makeRepository();
    const privateEmail = ['neuraflok-maintainer', 'gmail.com'].join('@');
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repository });
    commit(repository, 'Unsafe identity not published yet', privateEmail);

    const result = verify(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('non-noreply maintainer email');
    expect(result.stderr).not.toContain(privateEmail);
  });

  it('keeps annotated tags reachable from HEAD under the same checks', () => {
    const repository = makeRepository();
    const sessionUrl = ['https://provider.example/code/', 'session_taggedIdentifier'].join('');
    tag(repository, 'v0.0.1-test', `Release\n\nPrivate-Session: ${sessionUrl}`, safeEmail);

    const result = verify(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('private session provenance');
    expect(result.stderr).not.toContain(sessionUrl);
  });

  it('ignores an annotated tag that is not reachable from HEAD', () => {
    const repository = makeRepository();
    const sessionUrl = ['https://provider.example/code/', 'session_otherLineIdentifier'].join('');
    execFileSync('git', ['checkout', '-q', '-b', 'other-line'], { cwd: repository });
    commit(repository, 'Only on the other line', safeEmail);
    tag(repository, 'v0.0.2-other', `Release\n\nPrivate-Session: ${sessionUrl}`, safeEmail);
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repository });

    const result = verify(repository);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('privacy check passed');
  });
});
