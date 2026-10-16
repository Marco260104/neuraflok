import { watch as watchFs, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { ProjectGitChanged } from '../../../../contracts/workspace/project-git.js';
import { rawPromises as fs } from '../rawfs.js';
import type { RepositoryContext } from './repository.js';

const CHANGE_DEBOUNCE_MS = 180;

export type ProjectGitContextReader = (projectId: string) => Promise<RepositoryContext | null>;
export type ProjectGitWatchFactory = (nativePath: string, listener: () => void, recursive?: boolean) => FSWatcher;

async function addGitDirectories(root: string, output: Set<string>, limit = 96): Promise<void> {
  if (output.size >= limit) return;
  try {
    const directory = await fs.lstat(root);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return;
    output.add(root);
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (output.size >= limit) return;
      if (entry.isDirectory() && !entry.isSymbolicLink()) await addGitDirectories(path.join(root, entry.name), output, limit);
    }
  } catch {}
}

export class ProjectGitWatchSetCore {
  private watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;
  private projectId: string | null = null;

  constructor(
    private readonly changed: (event: ProjectGitChanged) => void,
    private readonly readContext: ProjectGitContextReader,
    private readonly watchFactory: ProjectGitWatchFactory = (nativePath, listener, recursive = false) =>
      watchFs(nativePath, { persistent: false, recursive }, listener)
  ) {}

  async sync(projectId: string | null): Promise<void> {
    if (projectId && this.projectId === projectId && this.watchers.length > 0) return;
    const generation = ++this.generation;
    this.closeWatchers();
    this.projectId = projectId;
    if (!projectId) return;
    let context: RepositoryContext | null;
    try { context = await this.readContext(projectId); } catch { return; }
    if (!context || generation !== this.generation || this.projectId !== projectId) return;
    try {
      const watcher = this.watchFactory(context.projectReal, () => this.schedule(projectId), true);
      watcher.on('error', () => watcher.close());
      this.watchers.push(watcher);
    } catch {}
    const metadata = new Set([context.gitDir, context.commonDir]);
    await addGitDirectories(path.join(context.commonDir, 'refs'), metadata);
    await addGitDirectories(path.join(context.commonDir, 'logs', 'refs'), metadata);
    for (const directory of metadata) {
      try {
        if (!(await fs.stat(directory)).isDirectory()) continue;
        const watcher = this.watchFactory(directory, () => this.schedule(projectId));
        watcher.on('error', () => watcher.close());
        if (generation !== this.generation || this.projectId !== projectId) {
          watcher.close();
          return;
        }
        this.watchers.push(watcher);
      } catch {}
    }
  }

  close(): void {
    this.generation++;
    this.projectId = null;
    this.closeWatchers();
  }

  private schedule(projectId: string): void {
    if (this.projectId !== projectId) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.projectId === projectId) this.changed({ projectId });
    }, CHANGE_DEBOUNCE_MS);
  }

  private closeWatchers(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
