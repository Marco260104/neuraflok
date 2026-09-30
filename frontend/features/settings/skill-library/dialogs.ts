import type { AppApi } from '../../../../backend/preload/index.js';
import type { GitHubSkillUpdateCheck, ManagedSkill } from '../../../../contracts/skills.js';
import { $, el, run, toast } from '../../../shared/dom.js';
import { t, ui } from '../../../shared/i18n.js';
import type { SkillApiReply } from './contracts.js';

type DialogApi = Pick<AppApi,
  'skillsUpdateGithub' | 'skillsRemove' | 'skillsLinkGithub' | 'skillsImportGithub'>;

type SkillDialogDependencies = {
  api: DialogApi;
  getSkills: () => ManagedSkill[];
  setSkills: (skills: ManagedSkill[]) => void;
  update: (request: Promise<SkillApiReply>) => Promise<boolean>;
  beginAction: () => number;
  isCurrentAction: (epoch: number) => boolean;
  refreshList: () => Promise<boolean>;
  checks: Map<string, GitHubSkillUpdateCheck>;
  paintSource: (skill: ManagedSkill) => void;
  checkUpdates: (force: boolean) => Promise<void>;
  waitForCheckPass: () => Promise<void>;
};

const installedRevision = (skill: ManagedSkill): string =>
  skill.origin ? `${skill.origin.ref} @ ${skill.origin.commit.slice(0, 12)}` : '';

export function createSkillDialogs(deps: SkillDialogDependencies) {
  const confirmUpdate = (skill: ManagedSkill): void => {
    if (!skill.origin) return;
    document.querySelector('#skillUpdateDialog')?.remove();
    const dialog = document.createElement('dialog');
    dialog.id = 'skillUpdateDialog';
    dialog.className = 'skill-dialog';
    const head = el('div', 'skill-dialog-head');
    const title = el('h2', '', () => t('Update {0}?', [skill.name]));
    title.id = 'skillUpdateTitle';
    dialog.setAttribute('aria-labelledby', title.id);
    const close = el('button', 'btn', () => t('Close')) as HTMLButtonElement;
    close.type = 'button';
    close.addEventListener('click', () => dialog.close());
    head.append(title, close);
    const body = el('div', 'skill-dialog-body');
    body.append(el('p', '', () => t('Check this GitHub source for changes. If it changed, NEURAFLOK replaces the whole skill folder and moves the previous version to Trash. Local edits to resources will be replaced.')));
    body.append(el('p', 'skill-source-url', skill.origin.url));
    body.append(el('p', 'skill-source-revision', installedRevision(skill)));
    const actions = el('div', 'skill-dialog-actions');
    const cancel = el('button', 'btn', () => t('Cancel')) as HTMLButtonElement;
    cancel.type = 'button';
    cancel.addEventListener('click', () => dialog.close());
    const submit = el('button', 'btn btn-solid', () => t('Check and update')) as HTMLButtonElement;
    submit.type = 'button';
    submit.addEventListener('click', () => void (async () => {
      submit.disabled = close.disabled = cancel.disabled = true;
      dialog.setAttribute('aria-busy', 'true');
      ui(submit, 'textContent', () => t('Checking GitHub…'));
      const own = deps.beginAction();
      try {
        const result = await run(deps.api.skillsUpdateGithub(skill.id));
        if (!result) return;
        if (deps.isCurrentAction(own)) {
          deps.setSkills(result.skills);
          const installed = deps.getSkills().find(item => item.id === skill.id);
          if (installed?.origin) {
            deps.checks.set(skill.id, {
              id: skill.id,
              originRevision: installed.origin.revision,
              state: 'current',
              checkedAt: Date.now()
            });
            deps.paintSource(installed);
          }
        } else {
          void deps.refreshList();
        }
        toast(result.warning ? t(result.warning) : t(result.status === 'current' ? 'Skill is already up to date' : 'Skill updated from GitHub'));
        dialog.close();
      } catch {
        toast(t('Could not reach GitHub. Try again.'));
      } finally {
        if (submit.isConnected) {
          submit.disabled = close.disabled = cancel.disabled = false;
          dialog.removeAttribute('aria-busy');
          ui(submit, 'textContent', () => t('Check and update'));
        }
      }
    })());
    actions.append(cancel, submit);
    body.append(actions);
    dialog.append(head, body);
    dialog.addEventListener('click', event => { if (event.target === dialog && !submit.disabled) dialog.close(); });
    dialog.addEventListener('cancel', event => { if (submit.disabled) event.preventDefault(); });
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  };

  const confirmRemove = (skill: ManagedSkill): void => {
    document.querySelector('#skillRemoveDialog')?.remove();
    const dialog = document.createElement('dialog');
    dialog.id = 'skillRemoveDialog';
    dialog.className = 'skill-dialog';
    const head = el('div', 'skill-dialog-head');
    const title = el('h2', '', () => t('Remove {0}?', [skill.name]));
    title.id = 'skillRemoveTitle';
    dialog.setAttribute('aria-labelledby', title.id);
    const close = el('button', 'btn', () => t('Close')) as HTMLButtonElement;
    close.type = 'button';
    close.addEventListener('click', () => dialog.close());
    head.append(title, close);
    const body = el('div', 'skill-dialog-body');
    body.append(el('p', '', () => t('This moves the skill and its resources to the Trash. Existing prepared messages will not change.')));
    const actions = el('div', 'skill-dialog-actions');
    const cancel = el('button', 'btn btn-solid skill-dialog-cancel', () => t('Cancel')) as HTMLButtonElement;
    cancel.type = 'button';
    cancel.addEventListener('click', () => dialog.close());
    const remove = el('button', 'btn skill-destructive skill-dialog-confirm', () => t('Remove skill')) as HTMLButtonElement;
    remove.type = 'button';
    remove.addEventListener('click', () => void (async () => {
      remove.disabled = true;
      try {
        if (await deps.update(deps.api.skillsRemove(skill.id))) dialog.close();
      } finally {
        if (remove.isConnected) remove.disabled = false;
      }
    })());
    actions.append(cancel, remove);
    body.append(actions);
    dialog.append(head, body);
    dialog.addEventListener('click', event => { if (event.target === dialog && !remove.disabled) dialog.close(); });
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  };

  const initGithubDialog = (): ((target: ManagedSkill | null) => void) => {
    let linkTarget: ManagedSkill | null = null;
    const dialog = $<HTMLDialogElement>('skillGithubDialog');
    const input = $<HTMLInputElement>('skillGithubUrl');
    const error = $('skillGithubError');
    const submit = $<HTMLButtonElement>('skillGithubSubmit');
    const close = $<HTMLButtonElement>('skillGithubClose');
    const cancel = $<HTMLButtonElement>('skillGithubCancel');
    const open = (target: ManagedSkill | null): void => {
      linkTarget = target;
      ui($('skillGithubTitle'), 'textContent', () => t(target ? 'Link {0} to GitHub' : 'Import from GitHub', target ? [target.name] : []));
      ui($('skillGithubDescription'), 'textContent', () => t(target
        ? 'Link only if the local SKILL.md matches the GitHub file. Your files stay in place; missing or changed resources will show as an available update.'
        : 'Paste a public GitHub folder link or a link to its SKILL.md. The complete skill folder will be copied to your NEURAFLOK library.'));
      ui(submit, 'textContent', () => t(target ? 'Link source' : 'Import skill'));
      $('skillsImportGithub').closest('details')?.removeAttribute('open');
      error.hidden = true;
      error.textContent = '';
      dialog.showModal();
      input.focus();
    };
    $('skillsImportGithub').addEventListener('click', () => open(null));
    close.addEventListener('click', () => dialog.close());
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog && !submit.disabled) dialog.close(); });
    dialog.addEventListener('cancel', event => { if (submit.disabled) event.preventDefault(); });
    $('skillGithubForm').addEventListener('submit', event => void (async () => {
      event.preventDefault();
      submit.disabled = close.disabled = cancel.disabled = true;
      dialog.setAttribute('aria-busy', 'true');
      const target = linkTarget;
      ui(submit, 'textContent', () => t(target ? 'Linking…' : 'Importing…'));
      error.hidden = true;
      const own = deps.beginAction();
      const previous = new Set(deps.getSkills().map(skill => skill.id));
      try {
        const result = target
          ? await deps.api.skillsLinkGithub(target.id, input.value.trim())
          : await deps.api.skillsImportGithub(input.value.trim());
        if (!result.ok) {
          error.textContent = result.error;
          error.hidden = false;
          return;
        }
        if (deps.isCurrentAction(own)) {
          deps.setSkills(result.data);
          for (const skill of deps.getSkills()) {
            if (!previous.has(skill.id) && skill.origin) {
              deps.checks.set(skill.id, {
                id: skill.id,
                originRevision: skill.origin.revision,
                state: 'current',
                checkedAt: Date.now()
              });
              deps.paintSource(skill);
            }
          }
        } else {
          await deps.refreshList();
        }
        dialog.close();
        input.value = '';
        toast(t(target ? 'GitHub source linked' : 'Skill imported from GitHub'));
        if (target) {
          await deps.waitForCheckPass();
          await deps.checkUpdates(true);
        }
      } catch {
        error.textContent = t('Could not reach GitHub. Try again.');
        error.hidden = false;
      } finally {
        submit.disabled = close.disabled = cancel.disabled = false;
        dialog.removeAttribute('aria-busy');
        ui(submit, 'textContent', () => t(linkTarget ? 'Link source' : 'Import skill'));
      }
    })());
    return open;
  };

  return { confirmUpdate, confirmRemove, initGithubDialog };
}
