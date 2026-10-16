import { projectWorkspace } from './projects.js';
import { effectiveCapabilities, getConfig } from '../../infrastructure/settings/config.js';
import type { WorkspaceTerminalEvent, WorkspaceTerminalInfo } from '../../../contracts/workspace/terminal.js';
import { WorkspaceTerminalSession } from './terminals/pty-session.js';

const MAX_TERMINAL_SESSIONS = 8;
const TERMINAL_SHUTDOWN_WAIT_MS = 5_000;

export class WorkspaceTerminals {
  private readonly sessions = new Map<string, WorkspaceTerminalSession>();
  private readonly retiring = new Set<WorkspaceTerminalSession>();
  private readonly reservations = new Map<string, symbol>();
  private stopped = false;
  private shutdown: Promise<void> | null = null;

  constructor(
    private readonly emit: (event: WorkspaceTerminalEvent) => void,
    private readonly homeDirectory: string
  ) {}

  async create(id: string, projectId: string | null, cols: number, rows: number): Promise<WorkspaceTerminalInfo> {
    this.assertAvailable();
    this.assertCommandPermission();
    this.assertCapacity(id);
    const reservation = Symbol(id);
    this.reservations.set(id, reservation);

    try {
      const cwd = await this.resolveWorkingDirectory(projectId);
      this.assertCommandPermission();
      if (this.stopped || this.reservations.get(id) !== reservation) {
        throw new Error('Terminal opening was cancelled');
      }
      return this.startSession(id, projectId, cwd, cols, rows).info;
    } finally {
      if (this.reservations.get(id) === reservation) this.reservations.delete(id);
    }
  }

  async write(id: string, data: string): Promise<void> {
    this.assertCommandPermission();
    const session = this.sessions.get(id);
    if (!session) throw new Error('Terminal is closed');
    const currentDirectory = session.info.projectId === null
      ? null
      : await projectWorkspace(session.info.projectId);
    this.assertCommandPermission();
    if (this.sessions.get(id) !== session || (currentDirectory && currentDirectory.real !== session.info.cwd)) {
      throw new Error('Terminal project changed');
    }
    session.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.resize(cols, rows);
  }

  acknowledge(id: string, count: number): void {
    this.sessions.get(id)?.acknowledge(count);
  }

  close(id: string): void {
    this.reservations.delete(id);
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    this.retiring.add(session);
    this.terminate(session);
  }

  dispose(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.stopped = true;
    this.reservations.clear();
    for (const [id, session] of this.sessions) {
      this.sessions.delete(id);
      this.retiring.add(session);
    }

    const sessionsToStop = [...this.retiring];
    for (const session of sessionsToStop) this.terminate(session);
    this.shutdown = this.waitForExit(sessionsToStop);
    return this.shutdown;
  }

  private assertAvailable(): void {
    if (this.stopped) throw new Error('Terminal service is stopping');
  }

  private assertCommandPermission(): void {
    if (!effectiveCapabilities(getConfig()).command) {
      throw new Error('Command execution is disabled in Settings');
    }
  }

  private assertCapacity(id: string): void {
    if (this.sessions.has(id) || this.reservations.has(id)) {
      throw new Error('Terminal already exists');
    }
    if (this.sessions.size + this.reservations.size >= MAX_TERMINAL_SESSIONS) {
      throw new Error('Close a terminal before opening another (maximum 8)');
    }
  }

  private async resolveWorkingDirectory(projectId: string | null): Promise<string> {
    if (projectId === null) return this.homeDirectory;
    return (await projectWorkspace(projectId)).real;
  }

  private startSession(id: string, projectId: string | null, cwd: string, cols: number, rows: number): WorkspaceTerminalSession {
    const session = new WorkspaceTerminalSession({
      id,
      projectId,
      cwd,
      cols,
      rows,
      onData: (source, data) => {
        if (this.sessions.get(id) === source) this.emit({ id, data });
      },
      onExit: (source, exitCode) => this.completeSession(id, source, exitCode)
    });
    this.sessions.set(id, session);
    return session;
  }

  private completeSession(id: string, session: WorkspaceTerminalSession, exitCode: number): void {
    this.retiring.delete(session);
    if (this.sessions.get(id) !== session) return;
    this.sessions.delete(id);
    this.emit({ id, exitCode });
  }

  private terminate(session: WorkspaceTerminalSession): void {
    if (!session.terminate()) this.retiring.delete(session);
  }

  private waitForExit(sessions: WorkspaceTerminalSession[]): Promise<void> {
    if (sessions.length === 0) return Promise.resolve();
    return new Promise(resolve => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, TERMINAL_SHUTDOWN_WAIT_MS);
      void Promise.all(sessions.map(session => session.exited)).then(finish);
    });
  }
}
