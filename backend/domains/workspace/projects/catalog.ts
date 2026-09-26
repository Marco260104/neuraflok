import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PROJECT_COLORS, type LocalProject, type ProjectColor } from '../../../../contracts/workspace/projects.js';
import { readDurable, writeDurableNow } from '../../../persistence/durable.js';
import { getConfig } from '../../../infrastructure/settings/config.js';
import { resolvePath } from '../../../infrastructure/settings/sandbox.js';
import { rawPromises as fs } from '../rawfs.js';
import { sameProjectPath } from './identity.js';

const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(160),
  path: z.string().min(1).max(32768),
  color: z.enum(PROJECT_COLORS).optional(),
  createdAt: z.number().finite().nonnegative(),
  ungrouped: z.boolean().optional()
});
const catalogSchema = z.array(projectSchema).max(200);
let pendingMutation: Promise<void> = Promise.resolve();

function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = pendingMutation.then(operation);
  pendingMutation = result.then(() => undefined, () => undefined);
  return result;
}

async function writeCatalog(projects: LocalProject[]): Promise<void> {
  await writeDurableNow('projects', projects);
}

export async function listProjects(): Promise<LocalProject[]> {
  const stored = await readDurable<unknown>('projects');
  if (stored === null) return [];
  const result = catalogSchema.safeParse(stored);
  if (!result.success || new Set(result.data.map(project => project.id)).size !== result.data.length) {
    throw new Error('Project catalog is invalid');
  }
  return result.data;
}

export async function getProject(id: string): Promise<LocalProject | null> {
  const projects = await listProjects();
  return projects.find(project => project.id === id) ?? null;
}

export function addProject(folderPath: string): Promise<LocalProject> {
  return serializeMutation(async () => {
    if (!path.isAbsolute(folderPath)) throw new Error('Choose an absolute local project folder');
    const approvedPath = await resolvePath(getConfig().roots, folderPath);
    if (!(await fs.stat(approvedPath.real)).isDirectory()) throw new Error('Choose a project folder');

    const projects = await listProjects();
    const existing = projects.find(project => sameProjectPath(project.path, approvedPath.real));
    if (existing) {
      if (!existing.ungrouped) return existing;
      const { ungrouped: _ungrouped, ...restored } = existing;
      await writeCatalog(projects.map(project => project.id === existing.id ? restored : project));
      return restored;
    }
    if (projects.length >= 200) throw new Error('Project catalog limit reached');

    const project: LocalProject = {
      id: randomUUID(),
      name: (path.basename(approvedPath.real) || approvedPath.real).slice(0, 160),
      path: approvedPath.real,
      createdAt: Date.now()
    };
    await writeCatalog([...projects, project]);
    return project;
  });
}

export function setProjectColor(projectId: string, color: ProjectColor | null): Promise<LocalProject> {
  return serializeMutation(async () => {
    z.string().uuid().parse(projectId);
    const normalized = z.enum(PROJECT_COLORS).nullable().parse(color);
    const projects = await listProjects();
    const project = projects.find(row => row.id === projectId);
    if (!project) throw new Error('Project not found');
    if (project.color === (normalized ?? undefined)) return project;

    let updated: LocalProject;
    if (normalized === null) {
      const { color: _color, ...withoutColor } = project;
      updated = withoutColor;
    } else updated = { ...project, color: normalized };
    await writeCatalog(projects.map(row => row.id === projectId ? updated : row));
    return updated;
  });
}

export function removeProject(id: string): Promise<LocalProject> {
  return serializeMutation(async () => {
    z.string().uuid().parse(id);
    const projects = await listProjects();
    const project = projects.find(row => row.id === id);
    if (!project) throw new Error('Project not found');
    if (project.ungrouped) return project;

    const ungrouped = { ...project, ungrouped: true };
    await writeCatalog(projects.map(row => row.id === id ? ungrouped : row));
    return ungrouped;
  });
}
