import type { SkillLibrary } from '../../../../contracts/skills.js';
import { el, icon } from '../../../shared/dom.js';
import { t } from '../../../shared/i18n.js';
import type { SkillChoice } from './contracts.js';
import { skillScopeLabel, skillTitle } from './presentation.js';

export type SkillChoiceViewRequest = {
  host: HTMLElement;
  input: HTMLTextAreaElement;
  choices: SkillChoice[];
  selected: number;
  commandCount: number;
  query: string;
  loading: boolean;
  error: string;
  library: SkillLibrary | null;
  renderEpoch: number;
  renderOwner: string;
  renderSelection: string;
  owner: () => string;
  selection: () => string;
  epoch: () => number;
  choose: (choice: SkillChoice) => void;
};

function createButton(className: string): HTMLButtonElement {
  const button = el('button', className) as HTMLButtonElement;
  button.type = 'button';
  return button;
}

export function renderSkillChoices(view: SkillChoiceViewRequest): void {
  const chooseCurrent = (choice: SkillChoice): void => {
    if (view.epoch() === view.renderEpoch && view.owner() === view.renderOwner && view.selection() === view.renderSelection) view.choose(choice);
  };
  view.host.replaceChildren();
  view.host.hidden = false;
  view.input.setAttribute('aria-expanded', 'true');
  view.input.setAttribute('aria-controls', view.host.id);
  for (const [index, skill] of view.choices.entries()) {
    const command = 'command' in skill;
    if (index === 0 || (index === view.commandCount && !command)) {
      view.host.append(el('div', 'slash-menu-section-title', () => t(command ? 'Commands' : 'Skills')));
    }
    const row = createButton('skill-choice skill-autocomplete-option slash-menu-option');
    row.id = `skill-option-${index}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(index === view.selected));
    if (!command) row.dataset.skillId = skill.id;
    row.title = command ? `/${skill.command}` : skill.path;
    const copy = el('span', 'slash-menu-copy');
    const name = command ? t(skill.name) : skillTitle(skill);
    const description = command ? t(skill.description) : skill.shortDescription ?? skill.description;
    copy.append(el('strong', '', name), el('small', '', description));
    row.append(icon(command ? skill.glyph : 'i-skill', 'ico slash-menu-icon'), copy, el('span', 'slash-menu-meta', () => command ? '' : skillScopeLabel(skill)));
    row.addEventListener('pointerdown', event => event.preventDefault());
    row.addEventListener('click', () => chooseCurrent(skill));
    view.host.append(row);
  }
  const stateMessage = view.error ? view.error : view.loading && !view.library ? t('Loading skills…')
    : !view.choices.length ? (view.query ? t('No matches for “{0}”.', [`/${view.query}`]) : t('No skills available.')) : '';
  if (stateMessage) {
    const state = el('p', 'slash-menu-empty', stateMessage);
    state.setAttribute('role', view.error ? 'alert' : 'status');
    view.host.append(state);
  }
  if (view.choices.length) {
    view.input.setAttribute('aria-activedescendant', `skill-option-${view.selected}`);
    view.host.querySelector(`#skill-option-${view.selected}`)?.scrollIntoView?.({ block: 'nearest' });
  } else {
    view.input.removeAttribute('aria-activedescendant');
  }
}
