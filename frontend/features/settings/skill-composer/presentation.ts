import type { LibrarySkill } from '../../../../contracts/skills.js';
import { t } from '../../../shared/i18n.js';

export function skillTitle(skill: LibrarySkill): string {
  return skill.displayName || skill.name;
}

export function skillScopeLabel(skill: LibrarySkill): string {
  return skill.scope === 'repo' ? t('Project')
    : skill.scope === 'system' ? t('System')
      : skill.scope === 'admin' ? t('Admin') : t('Personal');
}
