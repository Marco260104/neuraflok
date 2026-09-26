import { rawPromises as fs } from './rawfs.js';
import {
  SandboxError,
  isAbsoluteVirtualPath,
  isNativeWindowsPath,
  resolvePath,
  type Resolved
} from '../../infrastructure/settings/sandbox.js';
import { currentWorkspace, forgetMissingWorkspace, learnWorkspace, setCurrentWorkspace } from './workspace.js';
import { getSessionProject } from './projects.js';
import { firstTaskRoot } from '../skills/access/managed-roots.js';
import { resolveLinkedSkillAlias } from '../skills/access/linked-package.js';
import { isUserSkillVirtualPath, resolveUserSkillPath } from '../skills/user-skills.js';

interface ToolPathResolutionRuntime {
  currentSessionId(): string | null;
  multiAgentEnabled(): boolean;
}

type ToolRoots = Parameters<typeof resolvePath>[0];
type WorkspacePath = Pick<Resolved, 'real' | 'virtual'>;

export interface ResolvedCwd {
  real: string;
  virtual: string;
  defaulted: boolean;
}

export function createToolPathResolver(runtime: ToolPathResolutionRuntime) {
  async function liveWorkspace(): Promise<{ workspace: WorkspacePath | null; missing: string | null }> {
    const sessionId = runtime.currentSessionId();
    const project = sessionId ? await getSessionProject(sessionId) : null;
    if (project) {
      setCurrentWorkspace(project);
      return { workspace: project, missing: null };
    }
    const learned = currentWorkspace();
    if (!learned) return { workspace: null, missing: null };
    const exists = await fs.stat(learned.real).then((stat) => stat.isDirectory(), () => false);
    if (exists) return { workspace: learned, missing: null };
    forgetMissingWorkspace(learned.real);
    return { workspace: null, missing: learned.virtual };
  }

  async function resolveIn(
    roots: ToolRoots,
    requested: string,
    options: { allowMissing?: boolean; base?: string | null; access?: 'read' } = {}
  ): Promise<Resolved> {
    if (isUserSkillVirtualPath(requested)) {
      if (options.access !== 'read') {
        throw new SandboxError(`${requested} is a read-only Skill folder. Copy the Skill into an approved folder to change it.`);
      }
      return (await resolveUserSkillPath(requested))!;
    }
    const { workspace } = await liveWorkspace();
    const base = options.base !== undefined ? options.base : (workspace?.virtual ?? null);
    const resolveOptions = {
      ...(options.allowMissing === undefined ? {} : { allowMissing: options.allowMissing }),
      base
    };
    const resolved = await resolveLinkedSkillAlias(roots, requested, resolveOptions) ??
      await resolvePath(roots, requested, resolveOptions);
    if (isAbsoluteVirtualPath(requested) || isNativeWindowsPath(requested)) await learnWorkspace(resolved);
    return resolved;
  }

  async function resolveCwd(roots: ToolRoots, virtualPath: string | undefined): Promise<ResolvedCwd> {
    const { workspace, missing } = await liveWorkspace();
    const provided = virtualPath !== undefined && virtualPath !== '';
    if (!provided && !workspace && runtime.multiAgentEnabled()) {
      throw new SandboxError(
        missing
          ? `WORKSPACE_REQUIRED: the folder this chat was working in (${missing}) no longer exists. Supply an explicit approved workdir before running a command.`
          : 'WORKSPACE_REQUIRED: this multi-agent chat has no proven workspace. Supply an explicit approved workdir before running a command.'
      );
    }
    const fallback = firstTaskRoot(roots);
    const target = provided ? virtualPath : (workspace?.virtual ?? (fallback ? `/${fallback.name}` : ''));
    if (!target) throw new SandboxError('No folder is approved, so there is nowhere to run');
    const resolved = await resolveIn(roots, target);
    const stat = await fs.stat(resolved.real);
    if (!stat.isDirectory()) throw new SandboxError('workdir must be a folder');
    return { real: resolved.real, virtual: resolved.virtual, defaulted: !provided };
  }

  return { resolveIn, resolveCwd };
}
