import type { LocalProject } from '../../../contracts/workspace/projects.js';
import type { ProjectDirectoryListing, ProjectFileEntry, ProjectFileKind } from '../../../contracts/workspace/project-files.js';
import type { ProjectGitChange, ProjectGitSnapshot, ProjectGitStatus } from '../../../contracts/workspace/project-git.js';
import { t } from '../../shared/i18n.js';
import { el, icon } from '../../shared/dom.js';
import { gitStatusLabel, humanBytes } from './file-panel-format.js';

interface FileTreeSelection {
  path: string;
  kind: ProjectFileKind | 'root';
}

interface FileTreeOptions {
  host: HTMLElement;
  project: () => LocalProject | null;
  selection: () => FileTreeSelection;
  expanded: () => ReadonlySet<string>;
  listing: (relative: string) => ProjectDirectoryListing | undefined;
  gitSnapshot: () => ProjectGitSnapshot | null;
  parentPath: (relative: string) => string;
  onSelectRoot: () => void | Promise<void>;
  onToggleDirectory: (entry: ProjectFileEntry) => void | Promise<void>;
  onSelectFile: (entry: ProjectFileEntry) => void | Promise<void>;
}

export function createFileTreeView(options: FileTreeOptions): { render: () => void } {
  const { host } = options;

  function treeGitStatus(snapshot: ProjectGitSnapshot | null, relative: string): ProjectGitChange | undefined {
    if (snapshot?.state !== 'ready') return undefined;
    return snapshot.changes.find(change => change.path === relative && change.status !== 'D');
  }

  function changedDirectoryCounts(snapshot: ProjectGitSnapshot | null): Map<string, { count: number; statuses: Set<ProjectGitStatus> }> {
    const counts = new Map<string, { count: number; statuses: Set<ProjectGitStatus> }>();
    if (snapshot?.state !== 'ready') return counts;
    for (const change of snapshot.changes) {
      const visited = new Set<string>();
      for (const changedPath of [change.path, change.previousPath]) {
        if (!changedPath) continue;
        let directory = options.parentPath(changedPath);
        while (directory) {
          if (!visited.has(directory)) {
            const summary = counts.get(directory) ?? { count: 0, statuses: new Set<ProjectGitStatus>() };
            summary.count++;
            summary.statuses.add(change.status);
            counts.set(directory, summary);
            visited.add(directory);
          }
          directory = options.parentPath(directory);
        }
      }
    }
    return counts;
  }

  function folderGitStatus(statuses: ReadonlySet<ProjectGitStatus>): ProjectGitStatus {
    return statuses.size === 1 ? [...statuses][0]! : 'M';
  }

  function folderGitLabel(count: number): string {
    return t('Git changes in this folder: {0}', [count]);
  }

  function treeRow(
    entry: ProjectFileEntry,
    depth: number,
    selection: FileTreeSelection,
    expanded: ReadonlySet<string>,
    snapshot: ProjectGitSnapshot | null,
    directoryCounts: Map<string, { count: number; statuses: Set<ProjectGitStatus> }>
  ): HTMLElement {
    const row = el('button', `file-tree-row${selection.path === entry.path ? ' is-selected' : ''}`) as HTMLButtonElement;
    row.type = 'button'; row.dataset.path = entry.path; row.dataset.kind = entry.kind;
    row.style.setProperty('--file-depth', String(depth));
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth + 2));
    row.setAttribute('aria-selected', String(selection.path === entry.path));
    row.tabIndex = selection.path === entry.path ? 0 : -1;
    if (entry.kind === 'directory') row.setAttribute('aria-expanded', String(expanded.has(entry.path)));
    const disclosure = el('span', `file-tree-disclosure${entry.kind === 'directory' && expanded.has(entry.path) ? ' is-open' : ''}`);
    disclosure.setAttribute('aria-hidden', 'true');
    row.append(disclosure, icon(entry.kind === 'directory' ? 'i-folder' : entry.kind === 'file' ? 'i-file' : 'i-ban', 'ico file-tree-icon'));
    row.append(el('span', 'file-tree-name', entry.name));
    const gitChange = entry.kind === 'file' ? treeGitStatus(snapshot, entry.path) : undefined;
    const descendants = entry.kind === 'directory' ? directoryCounts.get(entry.path) : undefined;
    if (gitChange || descendants) {
      const status = gitChange?.status ?? folderGitStatus(descendants!.statuses);
      const marker = el('span', `file-tree-git-status is-${status.toLowerCase()}${descendants ? ' is-directory' : ''}`, status);
      marker.setAttribute('role', 'img');
      const label = gitChange ? gitStatusLabel(gitChange.status) : folderGitLabel(descendants!.count);
      marker.title = label;
      marker.setAttribute('aria-label', label);
      row.append(marker);
    }
    if (entry.kind === 'file' && entry.bytes !== null) row.append(el('span', 'file-tree-size', humanBytes(entry.bytes)));
    row.title = entry.path;
    row.addEventListener('click', () => void (entry.kind === 'directory' ? options.onToggleDirectory(entry) : options.onSelectFile(entry)));
    return row;
  }

  function appendDirectory(
    target: DocumentFragment | HTMLElement,
    relative: string,
    depth: number,
    selection: FileTreeSelection,
    expanded: ReadonlySet<string>,
    snapshot: ProjectGitSnapshot | null,
    directoryCounts: Map<string, { count: number; statuses: Set<ProjectGitStatus> }>
  ): void {
    const listing = options.listing(relative);
    if (!listing) {
      if (expanded.has(relative)) target.append(el('div', 'file-tree-status', () => t('Loading…')));
      return;
    }
    for (const entry of listing.entries) {
      target.append(treeRow(entry, depth, selection, expanded, snapshot, directoryCounts));
      if (entry.kind === 'directory' && expanded.has(entry.path)) {
        appendDirectory(target, entry.path, depth + 1, selection, expanded, snapshot, directoryCounts);
      }
    }
    if (listing.truncated) target.append(el('div', 'file-tree-status', () => t('This folder has more items than the explorer can show at once.')));
  }

  function render(): void {
    const focused = host.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.path : undefined;
    host.replaceChildren();
    const project = options.project();
    if (!project) {
      host.append(el('p', 'meta', () => t('Files is available only for chats in a local project.')));
      return;
    }
    const selection = options.selection();
    const expanded = options.expanded();
    const snapshot = options.gitSnapshot();
    const root = el('button', `file-tree-root${selection.path === '' ? ' is-selected' : ''}`) as HTMLButtonElement;
    root.type = 'button'; root.setAttribute('role', 'treeitem'); root.setAttribute('aria-expanded', 'true');
    root.dataset.path = ''; root.dataset.kind = 'root';
    root.setAttribute('aria-level', '1'); root.setAttribute('aria-selected', String(selection.path === ''));
    root.tabIndex = selection.path === '' ? 0 : -1;
    root.append(icon('i-folder', 'ico file-tree-icon'), el('strong', 'file-tree-name', project.name));
    const directoryCounts = changedDirectoryCounts(snapshot);
    if (snapshot?.state === 'ready' && snapshot.changes.length) {
      const status = folderGitStatus(new Set(snapshot.changes.map(change => change.status)));
      const marker = el('span', `file-tree-git-status is-${status.toLowerCase()} is-directory`, status);
      const label = folderGitLabel(snapshot.changes.length);
      marker.setAttribute('role', 'img'); marker.setAttribute('aria-label', label); marker.title = label;
      root.append(marker);
    }
    root.title = project.path;
    root.onclick = () => void options.onSelectRoot();
    host.append(root);
    const fragment = document.createDocumentFragment();
    appendDirectory(fragment, '', 0, selection, expanded, snapshot, directoryCounts);
    host.append(fragment);
    const rows = [...host.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')];
    if (!rows.some(row => row.tabIndex === 0)) root.tabIndex = 0;
    if (focused !== undefined) {
      let path = focused;
      while (!rows.some(row => row.dataset.path === path) && path) path = options.parentPath(path);
      rows.find(row => row.dataset.path === path)?.focus({ preventScroll: true });
    }
  }

  host.addEventListener('focusin', event => {
    const row = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="treeitem"]');
    if (!row) return;
    for (const item of host.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')) item.tabIndex = item === row ? 0 : -1;
  });
  host.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const rows = [...host.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')];
    const row = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="treeitem"]');
    if (!row) return;
    const index = rows.indexOf(row);
    let next: HTMLButtonElement | undefined;
    if (event.key === 'ArrowDown') next = rows[Math.min(index + 1, rows.length - 1)];
    else if (event.key === 'ArrowUp') next = rows[Math.max(0, index - 1)];
    else if (event.key === 'Home') next = rows[0];
    else if (event.key === 'End') next = rows.at(-1);
    else if (event.key === 'ArrowRight') {
      if (row.getAttribute('aria-expanded') === 'false') row.click();
      else if (row.hasAttribute('aria-expanded')) next = rows[index + 1];
    } else if (event.key === 'ArrowLeft') {
      if (row.dataset.kind === 'directory' && row.getAttribute('aria-expanded') === 'true') row.click();
      else next = rows.find(item => item.dataset.path === options.parentPath(row.dataset.path ?? ''));
    } else return;
    event.preventDefault();
    next?.focus();
  });

  return { render };
}
