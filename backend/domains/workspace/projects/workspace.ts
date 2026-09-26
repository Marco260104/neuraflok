import { getSession } from '../../sessions/history/store.js';
import { getConfig } from '../../../infrastructure/settings/config.js';
import { resolvePath } from '../../../infrastructure/settings/sandbox.js';
import { rawPromises as fs } from '../rawfs.js';
import { getProject } from './catalog.js';
import { sameProjectPath } from './identity.js';

export async function resolveProjectWorkspace(project: { path: string }): Promise<{ virtual: string; real: string }> {
  const approvedPath = await resolvePath(getConfig().roots, project.path);
  if (!sameProjectPath(approvedPath.real, project.path) || !(await fs.stat(approvedPath.real)).isDirectory()) {
    throw new Error('Project folder changed or is unavailable');
  }
  return { virtual: approvedPath.virtual, real: approvedPath.real };
}

export async function projectWorkspace(projectId: string): Promise<{ virtual: string; real: string }> {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');
  return resolveProjectWorkspace(project);
}

export async function getSessionProject(sessionId: string): Promise<{ virtual: string; real: string } | null> {
  const session = await getSession(sessionId);
  if (!session?.projectId) return null;
  const project = await getProject(session.projectId);
  if (!project) throw new Error('The session project is unavailable');
  return resolveProjectWorkspace(project);
}
