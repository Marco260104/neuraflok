import type { GitHubSkillUpdateCheck, ManagedSkill } from '../../../../contracts/skills.js';
import { $, el, icon, toast } from '../../../shared/dom.js';
import { t, ui } from '../../../shared/i18n.js';
import type { RecommendedSkillCard, SkillLibraryViewActions } from './contracts.js';

const installedRevision = (skill: ManagedSkill): string =>
  skill.origin ? `${skill.origin.ref} @ ${skill.origin.commit.slice(0, 12)}` : '';

export function createSkillLibraryView(actions: SkillLibraryViewActions) {
  const paintSource = (
    skill: ManagedSkill,
    checks: Map<string, GitHubSkillUpdateCheck>,
    checking: Set<string>
  ): void => {
    const source = document.querySelector<HTMLElement>(`[data-skill-id="${skill.id}"] .skill-library-source`);
    if (!source) return;
    if (!skill.origin) {
      source.className = 'skill-library-source is-local';
      source.replaceChildren(icon('i-folder'), el('span', '', () => t('Local')));
      ui(source, 'title', () => t('Link a GitHub source from the card menu to check for updates.'));
      return;
    }
    const check = checks.get(skill.id);
    const state = checking.has(skill.id) ? 'checking' : check?.state ?? 'unknown';
    source.className = `skill-library-source is-${state}`;
    const label = state === 'checking' ? 'Checking…'
      : state === 'available' ? 'Update available'
        : state === 'current' ? 'Up to date'
          : state === 'error' ? 'Check failed' : 'GitHub';
    const marker = state === 'available' ? 'i-retry' : state === 'current' ? 'i-check'
      : state === 'error' ? 'i-warning' : 'i-globe';
    if (state === 'available') {
      const action = el('button', 'skill-library-update') as HTMLButtonElement;
      action.type = 'button';
      action.append(icon(marker), el('span', '', () => t(label)));
      ui(action, 'aria-label', () => `${t('Update from GitHub')}: ${skill.name}`);
      action.addEventListener('click', () => actions.confirmUpdate(skill));
      source.replaceChildren(action);
    } else {
      source.replaceChildren(icon(marker), el('span', '', () => t(label)));
    }
    const revision = installedRevision(skill);
    source.title = check?.error
      ? `${skill.origin.url}\n${revision}\n${check.error}`
      : `${skill.origin.url}\n${revision}`;
  };

  const renderRecommended = (recommended: RecommendedSkillCard[], skills: ManagedSkill[], query: string): void => {
    const section = document.getElementById('skillsRecommendedSection');
    if (!section) return;
    const installed = new Set(skills.map(skill => skill.id));
    const available = recommended.filter(entry => !installed.has(entry.id) &&
      `${entry.id} ${entry.name} ${entry.description} ${t(entry.description)}`.toLocaleLowerCase().includes(query));
    section.hidden = available.length === 0;
    ui($('skillsRecommendedCount'), 'textContent', () => t(available.length === 1 ? '{0} skill' : '{0} skills', [available.length]));
    const host = $('skillsRecommended');
    host.replaceChildren();
    for (const entry of available) {
      const card = el('article', 'skill-card skill-library-card');
      card.dataset.recommendedSkillId = entry.id;
      const body = el('div', 'skill-entry skill-library-entry');
      const artwork = el('div', 'skill-library-icon');
      artwork.append(icon('i-skill'));
      const title = el('div', 'skill-card-title');
      title.append(el('h2', '', entry.name), el('p', 'muted', () => t(entry.description)));
      const foot = el('div', 'skill-card-foot');
      foot.append(el('span', 'skill-library-id', `/${entry.id}`));
      const install = el('button', 'btn skill-recommended-install', () => t('Install')) as HTMLButtonElement;
      install.type = 'button';
      install.addEventListener('click', () => void (async () => {
        install.disabled = true;
        try { if (await actions.installRecommended(entry.id)) toast(t('Skill added to your library')); }
        finally { if (install.isConnected) install.disabled = false; }
      })());
      foot.append(install);
      title.append(foot);
      body.append(artwork, title);
      card.append(body);
      host.append(card);
    }
  };

  const renderInstalled = (
    skills: ManagedSkill[],
    checks: Map<string, GitHubSkillUpdateCheck>,
    checking: Set<string>,
    query: string
  ): void => {
    const visible = skills.filter(skill => `${skill.id} ${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query));
    ui($('skillsCount'), 'textContent', () => t(skills.length === 1 ? '{0} skill' : '{0} skills', [skills.length]));
    const host = $('skillsInstalled');
    host.replaceChildren();
    if (!visible.length) {
      const empty = skills.length
        ? t('No skills match your search.')
        : t('No skills installed yet. Import a folder, SKILL.md, or GitHub link to get started.');
      host.append(el('p', 'skill-no-results muted', empty));
      return;
    }
    for (const skill of visible) {
      const card = el('article', 'skill-card skill-library-card');
      card.dataset.skillId = skill.id;
      const entry = el('div', 'skill-entry skill-library-entry');
      const artwork = el('div', 'skill-library-icon');
      artwork.append(icon('i-skill'));
      const title = el('div', 'skill-card-title');
      title.append(el('h2', '', skill.name), el('p', 'muted', skill.description || t('Reusable instructions for this workspace.')));
      const foot = el('div', 'skill-card-foot');
      foot.append(el('span', 'skill-library-id', `/${skill.id}`));
      const source = el('span', 'skill-library-source');
      source.setAttribute('aria-live', 'polite');
      foot.append(source);
      title.append(foot);
      entry.append(artwork, title);
      const menu = document.createElement('details');
      menu.className = 'skill-menu';
      const summary = el('summary');
      summary.append(icon('i-more'));
      ui(summary, 'aria-label', () => t('Actions for {0}', [skill.name]));
      const menuActions = el('div', 'skill-menu-actions');
      if (skill.origin) {
        const refresh = el('button', 'btn', () => t('Update from GitHub')) as HTMLButtonElement;
        refresh.type = 'button';
        refresh.addEventListener('click', () => { menu.open = false; actions.confirmUpdate(skill); });
        menuActions.append(refresh);
      } else {
        const link = el('button', 'btn', () => t('Link GitHub source')) as HTMLButtonElement;
        link.type = 'button';
        link.addEventListener('click', () => { menu.open = false; actions.openGithubDialog(skill); });
        menuActions.append(link);
      }
      const remove = el('button', 'btn skill-destructive', () => t('Remove skill')) as HTMLButtonElement;
      remove.type = 'button';
      remove.addEventListener('click', () => actions.confirmRemove(skill));
      menuActions.append(remove);
      menu.append(summary, menuActions);
      card.append(entry, menu);
      host.append(card);
      paintSource(skill, checks, checking);
    }
  };

  return {
    render(recommended: RecommendedSkillCard[], skills: ManagedSkill[], checks: Map<string, GitHubSkillUpdateCheck>, checking: Set<string>): void {
      const query = $<HTMLInputElement>('skillsSearch').value.trim().toLocaleLowerCase();
      renderRecommended(recommended, skills, query);
      renderInstalled(skills, checks, checking, query);
    },
    paintSource
  };
}
