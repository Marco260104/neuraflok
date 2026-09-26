import { spawn, type IPty } from 'node-pty';
import { defaultUserShell } from '../execution/shell.js';
import { deleteEnvValue, normalizeEnvironment } from '../../../infrastructure/settings/env.js';
import type { WorkspaceTerminalInfo } from '../../../../contracts/workspace/terminal.js';

const OUTPUT_FRAME_LIMIT = 16_384;
const OUTPUT_PAUSE_LIMIT = 262_144;
const OUTPUT_RESUME_LIMIT = 65_536;

export type WorkspaceTerminalSessionOptions = {
  id: string;
  projectId: string | null;
  cwd: string;
  cols: number;
  rows: number;
  onData: (session: WorkspaceTerminalSession, data: string) => void;
  onExit: (session: WorkspaceTerminalSession, exitCode: number) => void;
};

export class WorkspaceTerminalSession {
  readonly info: WorkspaceTerminalInfo;
  readonly exited: Promise<void>;
  private readonly pty: IPty;
  private readonly resolveExit: () => void;
  private unacknowledgedCharacters = 0;
  private outputPaused = false;
  private terminationRequested = false;

  constructor(private readonly options: WorkspaceTerminalSessionOptions) {
    const shell = defaultUserShell();
    const environment = normalizeEnvironment();
    deleteEnvValue(environment, 'ELECTRON_RUN_AS_NODE');
    this.pty = spawn(shell.shellPath, shell.shellType === 'powershell' ? ['-NoLogo'] : [], {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: environment,
      useConpty: true
    });
    this.info = {
      id: options.id,
      projectId: options.projectId,
      cwd: options.cwd,
      shell: shell.shellType
    };
    let signalExit!: () => void;
    this.exited = new Promise(resolve => { signalExit = resolve; });
    this.resolveExit = signalExit;
    this.pty.onData(data => this.forwardOutput(data));
    this.pty.onExit(({ exitCode }) => {
      this.resolveExit();
      this.options.onExit(this, exitCode);
    });
  }

  write(data: string): void {
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
  }

  acknowledge(count: number): void {
    this.unacknowledgedCharacters = Math.max(0, this.unacknowledgedCharacters - count);
    if (this.outputPaused && this.unacknowledgedCharacters < OUTPUT_RESUME_LIMIT) {
      this.outputPaused = false;
      this.pty.resume();
    }
  }

  terminate(): boolean {
    if (this.terminationRequested) return true;
    this.terminationRequested = true;
    try {
      this.pty.kill();
      return true;
    } catch {
      this.resolveExit();
      return false;
    }
  }

  private forwardOutput(data: string): void {
    for (let offset = 0; offset < data.length; offset += OUTPUT_FRAME_LIMIT) {
      const frame = data.slice(offset, offset + OUTPUT_FRAME_LIMIT);
      this.unacknowledgedCharacters += frame.length;
      this.options.onData(this, frame);
    }
    if (this.unacknowledgedCharacters >= OUTPUT_PAUSE_LIMIT && !this.outputPaused) {
      this.outputPaused = true;
      this.pty.pause();
    }
  }
}
