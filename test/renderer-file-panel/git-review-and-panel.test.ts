import { attached, cleanGit, dom, host, ok, projectA, projectB, projectFilesChanged, projectGitChanged, tick, toggle } from './context.js';

import { createFilePanel } from "../../frontend/features/workspace/file-panel.js";
import { setLanguage } from "../../frontend/shared/i18n.js";
import type { ProjectGitDiff, ProjectGitSnapshot } from "../../contracts/workspace/project-git.js";
import { expect, it, vi } from 'vitest';

it('is unavailable without a local project and lazily expands only the chosen directory', async () => {
  const onShow = vi.fn();
  const panel = createFilePanel({ host, toggle, onShow, onAttach: file => attached.push(file.name) });
  panel.update(null);
  expect(toggle.hidden).toBe(true);

  panel.update(projectA);
  expect(toggle.hidden).toBe(false);
  toggle.click(); await tick();
  expect(onShow).toHaveBeenCalledTimes(1);
  expect((window.api.listProjectFiles as any)).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('README.md');
  expect(host.textContent).not.toContain('main.ts');

  host.querySelector<HTMLButtonElement>('[data-path="src"]')!.click(); await tick();
  expect((window.api.listProjectFiles as any)).toHaveBeenLastCalledWith(projectA.id, 'src');
  expect(host.textContent).toContain('main.ts');
  expect((window.api.watchProjectFiles as any)).toHaveBeenLastCalledWith(projectA.id, ['', 'src']);
});

it('shows real Git groups, tree markers, unified diffs, and reconciles metadata changes', async () => {
  let snapshot: ProjectGitSnapshot = {
    projectId: projectA.id,
    state: 'ready',
    truncated: false,
    revision: 'dirty-1',
    changes: [
      { status: 'M', path: 'README.md', additions: 2, deletions: 1, binary: false },
      { status: 'A', path: 'src/staged.ts', additions: 1, deletions: 0, binary: false },
      { status: 'U', path: 'src/new.ts', additions: 1, deletions: 0, binary: false },
      { status: 'D', path: 'old.ts', additions: 0, deletions: 3, binary: false },
      { status: 'R', path: 'src/main.ts', previousPath: 'src/old-main.ts', additions: 1, deletions: 1, binary: false }
    ]
  };
  (window.api.getProjectGitSnapshot as any).mockImplementation(() => ok(snapshot));
  const diff: ProjectGitDiff = {
    projectId: projectA.id, status: 'M', path: 'README.md', additions: 2, deletions: 1,
    binary: false, tooLarge: false, baseText: '# old', currentText: '# new\nnext'
  };
  (window.api.getProjectGitDiff as any).mockImplementation(() => ok(diff));

  const panel = createFilePanel({ host, toggle });
  panel.update(projectA);
  toggle.click(); await tick(); await tick();
  const marker = host.querySelector<HTMLElement>('[data-path="README.md"] .file-tree-git-status');
  expect(marker?.getAttribute('aria-label')).toBe('Modified');
  expect(marker?.textContent).toBe('M');
  expect(host.querySelector('[data-path="old.ts"]')).toBeNull();
  expect(host.querySelector('.file-panel-changes-badge')?.textContent).toBe('5');
  expect(host.querySelector('[data-path="src"] .file-tree-git-status')?.getAttribute('aria-label')).toBe('Git changes in this folder: 3');
  expect(host.querySelector('[data-path="src"] .file-tree-git-status')?.textContent).toBe('M');
  expect(host.querySelector('.file-tree-root .file-tree-git-status')?.getAttribute('aria-label')).toBe('Git changes in this folder: 5');

  host.querySelector<HTMLButtonElement>('.file-panel-changes-toggle')!.click(); await tick(); await tick();
  expect(host.querySelector('.file-changes-header-title')?.textContent).toBe('Working tree');
  expect(host.querySelector('.file-panel-refresh')?.getAttribute('aria-label')).toBe('Refresh changes');
  expect(host.textContent).toContain('Modified (1)');
  expect(host.textContent).toContain('Added (1)');
  expect(host.textContent).toContain('Deleted (1)');
  expect(host.textContent).toContain('Renamed (1)');
  expect(host.textContent).toContain('Untracked (1)');
  expect(host.querySelector('.file-change-row[data-path="src/new.ts"] .file-change-status')?.textContent).toBe('U');
  expect(host.querySelector('.file-change-row[data-path="src/new.ts"] .file-change-stats')?.textContent).toBe('1 line');
  expect(host.querySelector('.file-change-row[data-path="src/staged.ts"] .file-change-stats')?.textContent).toContain('+1');
  expect(window.api.watchProjectFiles).toHaveBeenLastCalledWith(projectA.id, ['', 'src']);
  const action = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('.file-panel-toolbar button')]
    .find(button => button.textContent?.includes(label))!;
  expect(action('New file').disabled).toBe(true);
  expect(action('New folder').disabled).toBe(true);
  expect(action('Reveal').disabled).toBe(true);
  expect(action('Rename').disabled).toBe(true);
  expect(action('Delete').disabled).toBe(true);
  host.querySelector<HTMLButtonElement>('.file-change-row[data-path="README.md"]')!.click(); await tick(); await tick();
  expect(host.querySelector('.file-changes-header-title')?.textContent).toBe('Diff');
  expect(document.activeElement).toBe(host.querySelector('.file-changes-back'));
  expect(host.querySelector('.file-changes-back .ico.ph-arrow-left')).not.toBeNull();
  try {
    setLanguage('es');
    expect(host.querySelector('.file-changes-header-title')?.textContent).toBe('Diferencias');
    expect(host.querySelector('.file-changes-back')?.getAttribute('aria-label')).toBe('Volver a cambios');
    expect(host.querySelector('.file-panel-refresh')?.getAttribute('aria-label')).toBe('Actualizar cambios');
  } finally { setLanguage('en'); }
  expect(host.querySelector('.test-diff-viewer')?.textContent).toContain('# old\n---\n# new');
  expect(host.querySelector('.file-preview-title > strong')?.textContent).toBe('README.md');
  expect(host.querySelector('.file-preview-meta')?.textContent).toContain('README.md');
  let finishDiff!: (result: { ok: true; data: ProjectGitDiff }) => void;
  (window.api.getProjectGitDiff as any).mockImplementationOnce(() => new Promise(resolve => { finishDiff = resolve; }));
  snapshot = { ...snapshot, revision: 'dirty-1b' };
  projectGitChanged?.({ projectId: projectA.id });
  await new Promise(resolve => setTimeout(resolve, 150)); await tick();
  expect(host.querySelector('.test-diff-viewer')).toBeNull();
  expect(host.textContent).toContain('Loading diff');
  finishDiff({ ok: true, data: { ...diff, currentText: '# revised' } }); await tick();
  expect(host.querySelector('.test-diff-viewer')?.textContent).toContain('# revised');
  (window.api.getProjectGitDiff as any).mockImplementationOnce(() => ok({ ...diff, currentText: '# same-count edit' }));
  projectGitChanged?.({ projectId: projectA.id });
  await new Promise(resolve => setTimeout(resolve, 150)); await tick();
  expect(host.querySelector('.test-diff-viewer')?.textContent).toContain('# same-count edit');
  expect(host.querySelector('.file-panel-body')?.classList.contains('is-diff-open')).toBe(true);
  expect(host.querySelector<HTMLElement>('.file-changes-list')?.hidden).toBe(true);
  expect(action('Rename').disabled).toBe(true);
  expect(action('Delete').disabled).toBe(true);
  action('Reveal').click(); await tick();
  expect(window.api.revealProjectFileEntry).not.toHaveBeenCalled();
  const backToFiles = host.querySelector<HTMLButtonElement>('.file-changes-back')!;
  expect(backToFiles.getAttribute('aria-label')).toBe('Back to changes');
  backToFiles.click(); await tick();
  expect(host.querySelector('.test-diff-viewer')).toBeNull();
  expect(host.querySelector('.file-changes-header-title')?.textContent).toBe('Working tree');
  expect(host.querySelector<HTMLElement>('.file-changes-list')?.hidden).toBe(false);
  expect(host.querySelector('.file-panel-body')?.classList.contains('is-diff-open')).toBe(false);
  expect(backToFiles.getAttribute('aria-label')).toBe('Back to files');
  backToFiles.click(); await tick();
  expect(host.querySelector<HTMLElement>('.file-tree')?.hidden).toBe(false);
  expect(document.activeElement).toBe(host.querySelector('.file-tree-root'));
  expect(host.querySelector<HTMLElement>('.file-changes-view')?.hidden).toBe(true);
  expect(action('New file').disabled).toBe(false);
  expect(action('Reveal').disabled).toBe(false);
  expect(host.querySelector('[data-path="src"] .file-tree-git-status')).not.toBeNull();
  host.querySelector<HTMLButtonElement>('.file-panel-changes-toggle')!.click(); await tick(); await tick();

  snapshot = {
    ...snapshot,
    revision: 'dirty-2',
    changes: snapshot.changes.map(change => change.path === 'src/new.ts' ? { ...change, additions: 7 } : change)
  };
  projectFilesChanged?.({ projectId: projectA.id, directory: 'src' });
  await new Promise(resolve => setTimeout(resolve, 150)); await tick();
  expect(host.querySelector('[data-path="src/new.ts"] .file-change-stats')?.textContent).toBe('7 lines');

  // A push/metadata event is not authority to clear Changes; only the reread snapshot is.
  projectGitChanged?.({ projectId: projectA.id });
  await new Promise(resolve => setTimeout(resolve, 150)); await tick();
  expect(host.querySelector('.file-panel-changes-badge')?.textContent).toBe('5');

  snapshot = { ...cleanGit(), revision: 'clean-2' };
  projectGitChanged?.({ projectId: projectA.id });
  await new Promise(resolve => setTimeout(resolve, 150)); await tick();
  expect(host.textContent).toContain('Working tree is clean');
  expect(host.querySelector('.file-panel-changes-badge')?.hasAttribute('hidden')).toBe(true);
  expect(host.querySelector('.test-diff-viewer')).toBeNull();
});

it('searches a comparison branch without checking out and keeps the chosen diff scoped to that branch', async () => {
  const baseRef = 'refs/remotes/origin/main';
  const branches = [{ ref: baseRef, label: 'origin/main' }, { ref: 'refs/heads/feature', label: 'feature' }];
  (window.api.getProjectGitSnapshot as any).mockImplementation((_id: string, selected?: string) => ok({
    ...cleanGit(), currentBranch: 'feature', branches,
    ...(selected ? { comparison: { ref: selected, label: 'origin/main', baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40) },
      revision: 'compared', changes: [{ status: 'M', path: 'README.md', additions: 2, deletions: 1, binary: false }] } : {})
  }));
  (window.api.getProjectGitDiff as any).mockImplementation(() => ok({
    projectId: projectA.id, status: 'M', path: 'README.md', additions: 2, deletions: 1,
    binary: false, tooLarge: false, baseText: 'before', currentText: 'after'
  }));
  const panel = createFilePanel({ host, reviewOnly: true });
  panel.update(projectA);
  await panel.show(); await tick();
  expect(host.querySelector('.file-changes-header-title')?.textContent).toBe('feature');
  host.querySelector<HTMLButtonElement>('.file-branch-trigger')!.click();
  const search = document.querySelector<HTMLInputElement>('.file-branch-search')!;
  search.value = 'origin'; search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  expect(document.querySelectorAll('.file-branch-option')).toHaveLength(1);
  document.querySelector<HTMLButtonElement>('.file-branch-option')!.click(); await tick();
  expect(window.api.getProjectGitSnapshot).toHaveBeenLastCalledWith(projectA.id, baseRef);
  expect(host.querySelector('.file-branch-trigger')?.textContent).toContain('origin/main');
  expect(host.querySelector('.file-branch-stats')?.textContent).toContain('+2');
  host.querySelector<HTMLButtonElement>('.file-change-row')!.click(); await tick();
  expect(window.api.getProjectGitDiff).toHaveBeenLastCalledWith(projectA.id, 'README.md', baseRef, 'compared');
  panel.update(projectB); await tick();
  expect(document.querySelector('.file-branch-menu')).toBeNull();
  expect(window.api.getProjectGitSnapshot).toHaveBeenLastCalledWith(projectB.id, undefined);
});

it('lets Review leave a comparison whose branch disappeared', async () => {
  const baseRef = 'refs/heads/removed';
  (window.api.getProjectGitSnapshot as any).mockImplementation((_id: string, selected?: string) => ok(selected
    ? { ...cleanGit(), state: 'unavailable', message: 'Branch disappeared' }
    : { ...cleanGit(), currentBranch: 'feature', branches: [{ ref: baseRef, label: 'removed' }] }));
  const panel = createFilePanel({ host, reviewOnly: true });
  panel.update(projectA); await panel.show(); await tick();
  host.querySelector<HTMLButtonElement>('.file-branch-trigger')!.click();
  [...document.querySelectorAll<HTMLButtonElement>('.file-branch-option')].find(button => button.textContent === 'removed')!.click();
  await tick();
  expect(host.textContent).toContain('Git changes are unavailable.');
  host.querySelector<HTMLButtonElement>('.file-branch-trigger')!.click();
  [...document.querySelectorAll<HTMLButtonElement>('.file-branch-option')].find(button => button.textContent === 'Working tree')!.click();
  await tick();
  expect(window.api.getProjectGitSnapshot).toHaveBeenLastCalledWith(projectA.id, undefined);
  expect(host.textContent).toContain('Working tree is clean');
});

it('marks every ancestor folder, including paths of deleted and renamed files, then clears them from Git truth', async () => {
  let snapshot: ProjectGitSnapshot = {
    ...cleanGit(), revision: 'nested-dirty', changes: [
      { status: 'M', path: 'src/nested/main.ts', additions: 1, deletions: 1, binary: false },
      { status: 'U', path: 'src/nested/loose.ts', additions: 2, deletions: 0, binary: false },
      { status: 'D', path: 'docs/removed.ts', additions: 0, deletions: 2, binary: false },
      { status: 'R', path: 'src/nested/new.ts', previousPath: 'docs/old.ts', additions: 0, deletions: 0, binary: false }
    ]
  };
  (window.api.getProjectGitSnapshot as any).mockImplementation(() => ok(snapshot));
  (window.api.listProjectFiles as any).mockImplementation((_id: string, directory: string) => ok({
    projectId: projectA.id, projectName: projectA.name, directory, truncated: false,
    entries: directory === '' ? [
      { name: 'src', path: 'src', kind: 'directory', bytes: null },
      { name: 'docs', path: 'docs', kind: 'directory', bytes: null },
      { name: 'src-other', path: 'src-other', kind: 'directory', bytes: null }
    ] : directory === 'src' ? [
      { name: 'nested', path: 'src/nested', kind: 'directory', bytes: null }
    ] : directory === 'src/nested' ? [
      { name: 'main.ts', path: 'src/nested/main.ts', kind: 'file', bytes: 10 },
      { name: 'loose.ts', path: 'src/nested/loose.ts', kind: 'file', bytes: 10 },
      { name: 'new.ts', path: 'src/nested/new.ts', kind: 'file', bytes: 10 }
    ] : []
  }));
  const panel = createFilePanel({ host, toggle });
  panel.update(projectA); toggle.click(); await tick(); await tick();
  const label = (path: string) => host.querySelector(`[data-path="${path}"] .file-tree-git-status`)?.getAttribute('aria-label');
  expect(label('src')).toBe('Git changes in this folder: 3');
  expect(label('docs')).toBe('Git changes in this folder: 2');
  expect(host.querySelector('[data-path="src"] .file-tree-git-status')?.textContent).toBe('M');
  expect(host.querySelector('[data-path="docs"] .file-tree-git-status')?.textContent).toBe('M');
  expect(label('src-other')).toBeUndefined();
  host.querySelector<HTMLButtonElement>('[data-path="src"]')!.click(); await tick();
  expect(label('src/nested')).toBe('Git changes in this folder: 3');
  host.querySelector<HTMLButtonElement>('[data-path="src/nested"]')!.click(); await tick();
  expect(host.querySelector('[data-path="src/nested/main.ts"] .file-tree-git-status')?.textContent).toBe('M');
  expect(host.querySelector('[data-path="src/nested/loose.ts"] .file-tree-git-status')?.textContent).toBe('U');
  expect(host.querySelector('[data-path="src/nested/new.ts"] .file-tree-git-status')?.textContent).toBe('R');
  snapshot = { ...cleanGit(), revision: 'nested-clean' };
  projectGitChanged?.({ projectId: projectA.id });
  await new Promise(resolve => setTimeout(resolve, 150)); await tick();
  expect(label('src')).toBeUndefined();
  expect(label('docs')).toBeUndefined();
  expect(label('src/nested')).toBeUndefined();
  expect(label('src/nested/main.ts')).toBeUndefined();
});

it('reviews the exact edit independently of current Git changes and returns to Files', async () => {
  const review = vi.fn((_sessionId: string, _callId: string, index: number) => ok({
    callId: 'call-id', changeIndex: index, path: index === 0 ? 'src/main.ts' : 'src/other.ts',
    added: 1, removed: 1, baseText: index === 0 ? 'before' : 'old', currentText: index === 0 ? 'after' : 'new'
  }));
  (window.api as any).getToolEditReview = review;
  const panel = createFilePanel({ host, toggle });
  panel.update(projectA);
  expect(await panel.openReview(projectB.id, 'session-id', 'call-id', [0])).toBe(false);
  expect(await panel.openReview(projectA.id, 'session-id', 'call-id', [-1])).toBe(false);
  expect((window.api.getProjectGitSnapshot as any)).not.toHaveBeenCalled();
  expect(await panel.openReview(projectA.id, 'session-id', 'call-id', [0, 1])).toBe(true);
  await tick();
  expect(document.activeElement).toBe(host.querySelector('.file-changes-back'));
  expect(panel.visible()).toBe(true);
  expect(host.querySelector<HTMLElement>('.file-changes-view')?.hidden).toBe(false);
  expect(host.querySelector<HTMLElement>('.file-changes-list')?.hidden).toBe(true);
  expect(host.querySelector('.file-panel-body')?.classList.contains('is-diff-open')).toBe(true);
  expect(host.querySelector<HTMLButtonElement>('.file-changes-back')?.getAttribute('aria-label')).toBe('Back to files');
  expect(host.querySelector('[title="Previous edited file"] .ico.ph-arrow-left')).not.toBeNull();
  expect(host.querySelector('.test-diff-viewer')?.textContent).toBe('before\n---\nafter');
  expect((window.api.getProjectGitDiff as any)).not.toHaveBeenCalled();
  expect(review).toHaveBeenCalledWith('session-id', 'call-id', 0);
  host.querySelector<HTMLButtonElement>('[title="Next edited file"]')!.click(); await tick();
  expect(host.querySelector('.test-diff-viewer')?.textContent).toBe('old\n---\nnew');
  expect(review).toHaveBeenLastCalledWith('session-id', 'call-id', 1);
  host.querySelector<HTMLButtonElement>('.file-changes-back')!.click(); await tick();
  expect(host.querySelector('.test-diff-viewer')).toBeNull();
  expect(host.querySelector<HTMLElement>('.file-tree')?.hidden).toBe(false);
  expect(document.activeElement).toBe(host.querySelector('.file-tree-root'));
});

it('shows Files and the read-only Review projection at once without a second file watcher', async () => {
  const right = document.createElement('div'), bottom = document.createElement('div');
  host.append(right, bottom);
  const files = createFilePanel({ host, mount: right, toggle });
  const reviewToggle = document.createElement('button');
  const review = createFilePanel({ host, mount: bottom, toggle: reviewToggle, reviewOnly: true });
  files.update(projectA); review.update(projectA);
  await files.show(); await tick();
  const fileWatchCalls = vi.mocked(window.api.watchProjectFiles).mock.calls.length;
  await review.show(); await tick();
  expect(right.querySelector<HTMLElement>('.file-tree')?.hidden).toBe(false);
  expect(bottom.querySelector<HTMLElement>('.file-changes-view')?.hidden).toBe(false);
  expect(bottom.querySelector('.file-panel-toolbar')).toBeNull();
  expect(bottom.querySelector('.file-changes-header .file-panel-refresh')).not.toBeNull();
  expect(bottom.querySelector('.file-changes-header')?.lastElementChild?.classList.contains('file-panel-refresh')).toBe(true);
  expect(bottom.querySelector('.file-changes-header-content')?.contains(bottom.querySelector('.file-changes-header-title'))).toBe(true);
  expect(bottom.querySelector('.file-changes-header-content')?.contains(bottom.querySelector('.file-panel-refresh'))).toBe(false);
  expect(window.api.listProjectFiles).toHaveBeenCalledTimes(1);
  expect(window.api.watchProjectFiles).toHaveBeenCalledTimes(fileWatchCalls);
  expect(window.api.getProjectGitSnapshot).toHaveBeenCalled();
});

it('returns a recorded edit to Review rather than exposing Files actions', async () => {
  (window.api as any).getToolEditReview = vi.fn(() => ok({
    callId: 'call-id', changeIndex: 0, path: 'src/main.ts', added: 1, removed: 1,
    baseText: 'before', currentText: 'after'
  }));
  const review = createFilePanel({ host, mount: host, toggle, reviewOnly: true });
  review.update(projectA);
  expect(await review.openReview(projectA.id, 'session-id', 'call-id', [0])).toBe(true);
  host.querySelector<HTMLButtonElement>('.file-changes-back')!.click(); await tick();
  expect(host.querySelector<HTMLElement>('.file-tree')?.hidden).toBe(true);
  expect(host.querySelector<HTMLElement>('.file-changes-view')?.hidden).toBe(false);
  expect(host.querySelector('.file-panel-toolbar')).toBeNull();
  expect(host.querySelector('.file-changes-header .file-panel-refresh')).not.toBeNull();
  expect(window.api.saveProjectFile).not.toHaveBeenCalled();
});

