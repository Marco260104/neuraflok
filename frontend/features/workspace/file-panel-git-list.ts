import type { LocalProject } from '../../../contracts/workspace/projects.js';
import type { ProjectGitChange, ProjectGitSnapshot, ProjectGitStatus } from '../../../contracts/workspace/project-git.js';
import { el, icon } from '../../shared/dom.js';
import { t } from '../../shared/i18n.js';
import { gitStatusLabel } from './file-panel-format.js';

interface Runtime {
  changesList: HTMLElement;
  project: LocalProject | null;
  gitLoading: boolean;
  snapshot: ProjectGitSnapshot | null;
  diffPath: string | null;
  openGitDiff(change: ProjectGitChange): void | Promise<void>;
}

function changeStats(change: ProjectGitChange, snapshot: ProjectGitSnapshot): HTMLElement {
  const stats = el('span', 'file-change-stats');
  if (change.status === 'U') {
    stats.title = t('All lines in this untracked file');
    stats.append(el('span', 'is-muted', change.binary ? t('Binary') :
      change.additions === null ? '—' : change.additions === 1 ? t('1 line') : t('{0} lines', [change.additions])));
    return stats;
  }
  stats.title = snapshot.comparison ? t('Changes from comparison base') : t('Changes since HEAD');
  if (change.additions !== null) stats.append(el('span', 'is-added', `+${change.additions}`));
  if (change.deletions !== null) stats.append(el('span', 'is-deleted', `−${change.deletions}`));
  if (change.additions === null && change.deletions === null) {
    stats.append(el('span', 'is-muted', change.binary ? t('Binary') : '—'));
  }
  return stats;
}

export function renderProjectGitChanges(runtime: Runtime): void {
  const { changesList, project, gitLoading, snapshot, diffPath } = runtime;
  changesList.replaceChildren();
  if (!project) {
    changesList.append(el('p', 'file-changes-empty', () => t('Changes is available only for chats in a local project.')));
    return;
  }
  if (gitLoading && !snapshot) {
    changesList.append(el('p', 'file-changes-empty', () => t('Reading Git changes…')));
    return;
  }
  if (!snapshot) {
    changesList.append(el('p', 'file-changes-empty', () => t('Open Changes to inspect this project.')));
    return;
  }
  if (snapshot.state === 'not-repository') {
    changesList.append(el('p', 'file-changes-empty', () => t('This folder is not a Git repository.')));
    return;
  }
  if (snapshot.state === 'unavailable') {
    const message = el('p', 'file-changes-empty', () => t('Git changes are unavailable.'));
    if (snapshot.message) message.title = snapshot.message;
    changesList.append(message);
    return;
  }
  if (!snapshot.changes.length) {
    const clean = el('div', 'file-changes-clean');
    clean.append(icon('i-check'), el('span', '', () => t(snapshot.comparison ? 'No changes between branches' : 'Working tree is clean')));
    changesList.append(clean);
    return;
  }
  const groups: Array<[ProjectGitStatus, string]> = [
    ['M', t('Modified')], ['A', t('Added')], ['D', t('Deleted')],
    ['R', t('Renamed')], ['U', t('Untracked')]
  ];
  for (const [status, label] of groups) {
    const entries = snapshot.changes.filter(change => change.status === status);
    if (!entries.length) continue;
    const section = el('section', 'file-change-group');
    section.append(el('h3', 'file-change-group-title', `${label} (${entries.length})`));
    for (const change of entries) {
      const row = el('button', `file-change-row${diffPath === change.path ? ' is-selected' : ''}`) as HTMLButtonElement;
      row.type = 'button';
      row.dataset.path = change.path;
      row.setAttribute('aria-pressed', String(diffPath === change.path));
      const statusMark = el('span', `file-change-status is-${status.toLowerCase()}`, status);
      statusMark.setAttribute('aria-hidden', 'true');
      const names = el('span', 'file-change-names');
      if (change.previousPath) {
        names.append(el('span', 'file-change-previous', change.previousPath), icon('i-arrow-right', 'ico file-change-arrow'));
      }
      names.append(el('span', 'file-change-path', change.path));
      const stats = changeStats(change, snapshot);
      row.append(statusMark, names, stats);
      row.title = `${gitStatusLabel(change.status)} · ${change.previousPath ? `${change.previousPath} → ` : ''}${change.path} · ${stats.textContent ?? ''}`;
      row.setAttribute('aria-label', row.title);
      row.addEventListener('click', () => void runtime.openGitDiff(change));
      section.append(row);
    }
    changesList.append(section);
  }
  if (snapshot.truncated) changesList.append(el('p', 'file-changes-limit', () => t('More changes exist than can be shown at once.')));
}
