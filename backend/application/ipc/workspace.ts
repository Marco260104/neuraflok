import { dialog, shell, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { PROJECT_COLORS } from '../../../contracts/workspace/projects.js';
import type { AppState } from '../../../contracts/types.js';
import { getConfig, updateConfig } from '../../infrastructure/settings/config.js';
import { logInfo } from '../../infrastructure/settings/logger.js';
import {
  RESERVED_ROOT_NAMES,
  SandboxError,
  resolvePath,
  uniqueRootName,
  validateNewRoot
} from '../../infrastructure/settings/sandbox.js';
import { forgetWorkspaceRoot, renameWorkspaceRoot } from '../../domains/workspace/workspace.js';
import {
  addProject,
  listProjects,
  removeProject,
  setProjectColor
} from '../../domains/workspace/projects.js';
import {
  createProjectEntry,
  renameProjectEntry,
  saveProjectTextFile
} from '../../domains/workspace/file-ops/project-files/mutations.js';
import { listProjectDirectory } from '../../domains/workspace/file-ops/project-files/directory.js';
import { previewProjectFile } from '../../domains/workspace/file-ops/project-files/preview.js';
import { projectFileTarget, revalidateProjectFileTarget } from '../../domains/workspace/file-ops/project-files/target.js';
import { ProjectFileWatchSet } from '../../domains/workspace/project-file-watcher.js';
import { ProjectGitWatchSet, readProjectGitDiff, readProjectGitSnapshot } from '../../domains/workspace/git/index.js';
import { readToolEditReview } from '../../domains/sessions/history/store.js';
import { listInputs } from '../../domains/sessions/input/input.js';
import { stageInputAttachment } from '../../domains/sessions/input/attachments/index.js';
import type { IpcRouteContext } from './types.js';

const renameRoot = z.object({
  name: z.string().min(1).max(32),
  newName: z.string().min(1).max(32).regex(/^[a-z0-9][a-z0-9._-]*$/, 'Lowercase letters, digits, dot, dash and underscore only')
});
const projectId = z.string().uuid();
const relativePath = z.string().max(4096);

export function registerWorkspaceIpc({ handle, getWindow, buildState, push }: IpcRouteContext): void {
  let watchedWindow: BrowserWindow | null = null;
  let watchRequest = 0;
  const fileWatches = new ProjectFileWatchSet(event => {
    const target = getWindow();
    if (!target || target !== watchedWindow || target.isDestroyed() || target.webContents.isDestroyed()) return;
    target.webContents.send('projectFiles:changed', event);
  });
  const gitWatches = new ProjectGitWatchSet(event => {
    const target = getWindow();
    if (!target || target !== watchedWindow || target.isDestroyed() || target.webContents.isDestroyed()) return;
    target.webContents.send('projectGit:changed', event);
  });
  const closeWatches = (): void => {
    watchRequest++;
    fileWatches.close();
    gitWatches.close();
  };
  const approveRoot = async (folderPath: string): Promise<AppState> => {
    let addedName = '';
    await updateConfig(async config => {
      const real = await validateNewRoot(folderPath, config.roots);
      const name = uniqueRootName(real, config.roots);
      addedName = name;
      return { ...config, roots: [...config.roots, { name, path: real }] };
    });
    logInfo('approved folder /' + addedName);
    return buildState();
  };

  handle('roots:add', async () => {
    const owner = getWindow();
    if (!owner) throw new Error('No window');
    const result = await dialog.showOpenDialog(owner, { title: 'Approve a folder for NEURAFLOK', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return buildState();
    return approveRoot(result.filePaths[0]);
  });
  handle('projects:list', () => listProjects());
  handle('projects:remove', async payload => {
    const { id } = z.object({ id: projectId }).parse(payload);
    const project = await removeProject(id);
    push('session:changed');
    return project;
  });
  handle('projects:add', async () => {
    const owner = getWindow();
    if (!owner) throw new Error('No window');
    const result = await dialog.showOpenDialog(owner, { title: 'Choose a project folder for NEURAFLOK', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const folder = result.filePaths[0];
    try { await resolvePath(getConfig().roots, folder); }
    catch (error) {
      if (!(error instanceof SandboxError)) throw error;
      push('state:changed', await approveRoot(folder));
    }
    const project = await addProject(folder);
    push('session:changed');
    return project;
  });
  handle('projects:color', async payload => {
    const { id, color } = z.object({ id: projectId, color: z.enum(PROJECT_COLORS).nullable() }).strict().parse(payload);
    const project = await setProjectColor(id, color);
    push('session:changed');
    return project;
  });
  handle('roots:addPath', async payload => {
    const { path: folderPath } = z.object({ path: z.string().min(1).max(4096) }).parse(payload);
    return approveRoot(folderPath);
  });
  handle('roots:remove', async payload => {
    const { name } = z.object({ name: z.string().min(1).max(32) }).parse(payload);
    await updateConfig(config => {
      if (!config.roots.some(root => root.name === name)) throw new Error('/' + name + ' is not an approved folder');
      return { ...config, roots: config.roots.filter(root => root.name !== name) };
    });
    forgetWorkspaceRoot(name);
    fileWatches.close();
    logInfo('removed folder /' + name);
    return buildState();
  });
  handle('roots:rename', async payload => {
    const { name, newName } = renameRoot.parse(payload);
    if (RESERVED_ROOT_NAMES.has(newName)) throw new SandboxError('/' + newName + ' is reserved by NEURAFLOK and cannot be used as a folder name');
    await updateConfig(config => {
      if (!config.roots.some(root => root.name === name)) throw new Error('/' + name + ' is not an approved folder');
      if (config.roots.some(root => root.name !== name && root.name === newName)) throw new Error('/' + newName + ' is already used');
      return { ...config, roots: config.roots.map(root => root.name === name ? { ...root, name: newName } : root) };
    });
    renameWorkspaceRoot(name, newName);
    return buildState();
  });
  handle('projectFiles:list', async payload => {
    const { projectId: id, directory } = z.object({ projectId, directory: relativePath.default('') }).strict().parse(payload);
    return listProjectDirectory(id, directory);
  });
  handle('projectFiles:watch', async payload => {
    const { projectId: id, directories } = z.object({
      projectId: projectId.nullable(),
      directories: z.array(relativePath).max(128)
    }).strict().parse(payload);
    const target = getWindow();
    if (!target || target.isDestroyed()) { closeWatches(); return false; }
    if (target !== watchedWindow) {
      closeWatches();
      watchedWindow = target;
      target.webContents.once('destroyed', () => {
        if (watchedWindow === target) { watchedWindow = null; closeWatches(); }
      });
      target.webContents.on('did-start-loading', () => {
        if (watchedWindow === target) closeWatches();
      });
    }
    const request = ++watchRequest;
    await fileWatches.sync(id, id ? directories : []);
    if (request !== watchRequest || watchedWindow !== target) return false;
    await gitWatches.sync(id);
    return request === watchRequest && watchedWindow === target;
  });
  handle('projectGit:snapshot', async payload => {
    const { projectId: id, baseRef } = z.object({ projectId, baseRef: z.string().min(1).max(256).optional() }).strict().parse(payload);
    return readProjectGitSnapshot(id, baseRef);
  });
  handle('projectGit:diff', async payload => {
    const { projectId: id, path, baseRef, expectedRevision } = z.object({
      projectId, path: relativePath.min(1), baseRef: z.string().min(1).max(256).optional(),
      expectedRevision: z.string().length(64).regex(/^[0-9a-f]+$/).optional()
    }).strict().parse(payload);
    return readProjectGitDiff(id, path, baseRef, expectedRevision);
  });
  handle('sessions:toolEditReview', async payload => {
    const { sessionId, callId, changeIndex } = z.object({
      sessionId: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i),
      callId: z.string().uuid(),
      changeIndex: z.number().int().min(0).max(63)
    }).strict().parse(payload);
    return readToolEditReview(sessionId, callId, changeIndex);
  });
  handle('projectFiles:preview', async payload => {
    const { projectId: id, path } = z.object({ projectId, path: relativePath.min(1) }).strict().parse(payload);
    return previewProjectFile(id, path);
  });
  handle('projectFiles:create', async payload => {
    const { projectId: id, directory, name, kind } = z.object({
      projectId, directory: relativePath.default(''), name: z.string().min(1).max(255), kind: z.enum(['file', 'directory'])
    }).strict().parse(payload);
    return createProjectEntry(id, directory, name, kind);
  });
  handle('projectFiles:rename', async payload => {
    const { projectId: id, path, name } = z.object({
      projectId, path: relativePath.min(1), name: z.string().min(1).max(255)
    }).strict().parse(payload);
    return renameProjectEntry(id, path, name);
  });
  handle('projectFiles:save', async payload => {
    const { projectId: id, path, text, expectedModifiedAt, expectedBytes, expectedRevision } = z.object({
      projectId, path: relativePath.min(1), text: z.string().max(256 * 1024), expectedModifiedAt: z.string().min(1).max(64),
      expectedBytes: z.number().int().min(0).max(256 * 1024), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/)
    }).strict().parse(payload);
    return saveProjectTextFile(id, path, text, expectedModifiedAt, expectedBytes, expectedRevision);
  });
  handle('projectFiles:delete', async payload => {
    const { projectId: id, path } = z.object({ projectId, path: relativePath.min(1) }).strict().parse(payload);
    const target = await projectFileTarget(id, path, { allowRoot: false });
    if (target.kind !== 'file' && target.kind !== 'directory') throw new Error('Only regular files and folders can be deleted');
    await revalidateProjectFileTarget(target);
    await shell.trashItem(target.real);
    return true;
  });
  handle('projectFiles:reveal', async payload => {
    const { projectId: id, path } = z.object({ projectId, path: relativePath.default('') }).strict().parse(payload);
    const target = await projectFileTarget(id, path);
    shell.showItemInFolder(target.real);
    return true;
  });
  handle('projectFiles:attach', async payload => {
    const { projectId: id, path } = z.object({ projectId, path: relativePath.min(1) }).strict().parse(payload);
    const target = await projectFileTarget(id, path, { allowRoot: false, fileOnly: true });
    const retained = new Set((await listInputs()).filter(row => !['sent', 'failed', 'cancelled'].includes(row.state))
      .flatMap(row => row.attachments?.map(file => file.id) ?? []));
    const checked = await projectFileTarget(id, path, { allowRoot: false, fileOnly: true });
    if (checked.real !== target.real) throw new Error('The project file changed location');
    return stageInputAttachment(checked.real, retained);
  });
}
