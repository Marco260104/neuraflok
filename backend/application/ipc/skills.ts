import { dialog, shell, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { SKILL_ID_PATTERN } from '../../../contracts/skills.js';
import type { IpcHandler } from './types.js';
import { getSessionProject, projectWorkspace } from '../../domains/workspace/projects.js';
import { importSkillFile, removeSkill } from '../../domains/skills/storage/local-files.js';
import { importSkillPackage } from '../../domains/skills/storage/packages.js';
import { listManagedSkills, listSkills } from '../../domains/skills/storage/catalog.js';
import { checkGitHubSkillUpdates } from '../../domains/skills/github/updates.js';
import { importGitHubSkill, linkGitHubSkill, updateGitHubSkill } from '../../domains/skills/github/lifecycle.js';
import { listSkillLibrary } from '../../domains/skills/skill-library.js';
import { installRecommendedSkill, listRecommendedSkills } from '../../domains/skills/recommended-skills.js';

export function registerSkillsIpc(handle: IpcHandler, getWindow: () => BrowserWindow | null): void {
  handle('skills:list', () => listSkills());
  handle('skills:managed', () => listManagedSkills());
  handle('skills:recommended', () => listRecommendedSkills());
  handle('skills:installRecommended', async payload => {
    const { id } = z.object({ id: z.string().regex(SKILL_ID_PATTERN) }).strict().parse(payload);
    return installRecommendedSkill(id);
  });
  handle('skills:import', async payload => {
    const { kind } = z.object({ kind: z.enum(['folder', 'file']) }).strict().parse(payload);
    const options: Electron.OpenDialogOptions = kind === 'folder'
      ? { title: 'Import Skill folder', properties: ['openDirectory'] }
      : { title: 'Import SKILL.md', properties: ['openFile'], filters: [{ name: 'Markdown skills', extensions: ['md'] }] };
    const owner = getWindow();
    const selected = owner && !owner.isDestroyed()
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths[0]) return null;
    if (kind === 'folder') await importSkillPackage(selected.filePaths[0]);
    else await importSkillFile(selected.filePaths[0]);
    return listManagedSkills();
  });
  handle('skills:githubImport', async payload => {
    const { url } = z.object({ url: z.string().trim().min(1).max(2048) }).strict().parse(payload);
    return importGitHubSkill(url);
  });
  handle('skills:githubLink', async payload => {
    const { id, url } = z.object({ id: z.string().regex(SKILL_ID_PATTERN), url: z.string().trim().min(1).max(2048) }).strict().parse(payload);
    return linkGitHubSkill(id, url);
  });
  handle('skills:githubCheck', async payload => {
    const { id } = z.object({ id: z.string().regex(SKILL_ID_PATTERN) }).strict().parse(payload);
    return checkGitHubSkillUpdates(id);
  });
  handle('skills:githubUpdate', async payload => {
    const { id } = z.object({ id: z.string().regex(SKILL_ID_PATTERN) }).strict().parse(payload);
    return updateGitHubSkill(id, directory => shell.trashItem(directory));
  });
  handle('skills:remove', async payload => {
    const { id } = z.object({ id: z.string().regex(SKILL_ID_PATTERN) }).strict().parse(payload);
    await removeSkill(id, directory => shell.trashItem(directory));
    return listManagedSkills();
  });
  handle('skills:library', async payload => {
    const scope = z.object({ sessionId: z.string().min(1).max(80).nullable().optional(), projectId: z.string().uuid().nullable().optional() }).strict().parse(payload ?? {});
    const folder = () => scope.sessionId ? getSessionProject(scope.sessionId)
      : scope.projectId ? projectWorkspace(scope.projectId) : Promise.resolve(null);
    const before = await folder();
    const library = await listSkillLibrary({ projectPath: before?.real ?? null });
    if ((await folder())?.real !== before?.real) throw new Error('The project changed while Skills were loading');
    return library;
  });
}
