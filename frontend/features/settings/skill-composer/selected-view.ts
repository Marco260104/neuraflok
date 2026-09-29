import type { SkillLibrary } from '../../../../contracts/skills.js';
import { el, icon } from '../../../shared/dom.js';
import { t, ui } from '../../../shared/i18n.js';
import { skillTitle } from './presentation.js';

export function renderSelectedSkills(
  host: HTMLElement,
  ids: string[],
  catalog: SkillLibrary | null,
  removeSkill: (id: string) => void
): void {
  host.replaceChildren();
  host.hidden = !ids.length;
  for (const id of ids) {
    const command = id === 'compact';
    const skill = command ? undefined : catalog?.skills.find(row => row.id === id);
    const name = command ? t('Compact') : skill ? skillTitle(skill) : id;
    const chip = el('div', 'composer-selected-skill');
    chip.dataset.skillId = id;
    if (command) chip.dataset.command = id;
    chip.title = command ? t('Compact this chat and resume it in a fresh conversation.') : skill?.path ?? `/${id}`;
    const remove = el('button', 'composer-selected-skill-remove') as HTMLButtonElement;
    remove.type = 'button';
    remove.replaceChildren(icon('i-x'));
    ui(remove, 'aria-label', () => t('Remove {0}', [name]));
    remove.addEventListener('click', () => removeSkill(id));
    chip.append(icon(command ? 'i-copy' : 'i-skill', 'ico composer-selected-skill-icon'), el('span', 'composer-selected-skill-title', name), remove);
    host.append(chip);
  }
}
