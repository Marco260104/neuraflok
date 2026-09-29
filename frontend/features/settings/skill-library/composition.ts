import type { AppApi } from '../../../../backend/preload/index.js';
import type { ManagedSkill } from '../../../../contracts/skills.js';
import { $, run, toast } from '../../../shared/dom.js';
import { t } from '../../../shared/i18n.js';
import { createSkillDialogs } from './dialogs.js';
import type { RecommendedSkillCard, SkillApiReply } from './contracts.js';
import { createSkillLibraryView } from './view.js';
import { createSkillUpdateChecks } from './update-checks.js';
import { initSkillMenuDismissal } from './menu-dismissal.js';

/** Initializes the managed skills library and returns its refresh action. */
export function initSkillsLibrary(api: AppApi): () => void {
  initSkillMenuDismissal();
  let skills: ManagedSkill[] = [];
  let recommended: RecommendedSkillCard[] = [];
  let epoch = 0;
  let openGithubDialog = (_skill: ManagedSkill | null): void => {};
  let confirmUpdate = (_skill: ManagedSkill): void => {};
  let confirmRemove = (_skill: ManagedSkill): void => {};
  const view = createSkillLibraryView({
    confirmUpdate: skill => confirmUpdate(skill),
    confirmRemove: skill => confirmRemove(skill),
    openGithubDialog: skill => openGithubDialog(skill),
    installRecommended: id => update(api.installRecommendedSkill(id))
  });
  const updateChecks = createSkillUpdateChecks(api, () => skills, view.paintSource);
  const render = (): void => view.render(recommended, skills, updateChecks.checks, updateChecks.checking);
  const setSkills = (next: ManagedSkill[]): void => {
    skills = next;
    updateChecks.reconcile(next);
    render();
  };
  const update = async (request: Promise<SkillApiReply>): Promise<boolean> => {
    const own = ++epoch;
    const next = await run(request);
    if (!next || own !== epoch) return false;
    setSkills(next);
    return true;
  };
  const refreshList = (): Promise<boolean> => update(api.listManagedSkills());
  const refresh = (force: boolean): void => {
    void (async () => { if (await refreshList()) await updateChecks.checkUpdates(force); })();
  };
  const dialogs = createSkillDialogs({
    api,
    getSkills: () => skills,
    setSkills,
    update,
    beginAction: () => ++epoch,
    isCurrentAction: own => own === epoch,
    refreshList,
    checks: updateChecks.checks,
    paintSource: skill => view.paintSource(skill, updateChecks.checks, updateChecks.checking),
    checkUpdates: updateChecks.checkUpdates,
    waitForCheckPass: updateChecks.waitForPass
  });
  confirmUpdate = dialogs.confirmUpdate;
  confirmRemove = dialogs.confirmRemove;
  openGithubDialog = dialogs.initGithubDialog();

  $('skillsSearch').addEventListener('input', render);
  $('skillsRefresh').addEventListener('click', () => refresh(true));
  for (const [id, kind] of [['skillsImportFolder', 'folder'], ['skillsImportFile', 'file']] as const) {
    $(id).addEventListener('click', () => void (async () => {
      const button = $<HTMLButtonElement>(id);
      button.disabled = true;
      try {
        const imported = await update(api.skillsImport(kind));
        if (imported) toast(t('Skill added to your library'));
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    })());
  }
  void refreshList();
  if (typeof api.listRecommendedSkills === 'function') {
    void run(api.listRecommendedSkills()).then(list => {
      if (list) {
        recommended = list;
        render();
      }
    });
  }
  return () => refresh(false);
}
