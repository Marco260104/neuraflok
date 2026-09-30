import type { ProjectGitStatus } from '../../../contracts/workspace/project-git.js';
import { t } from '../../shared/i18n.js';

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function gitStatusLabel(status: ProjectGitStatus): string {
  if (status === 'U') return t('Untracked');
  if (status === 'A') return t('Added');
  if (status === 'D') return t('Deleted');
  if (status === 'R') return t('Renamed');
  return t('Modified');
}
