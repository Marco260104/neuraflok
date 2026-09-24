export type WorkspaceTerminalInfo = {
  id: string;
  projectId: string | null;
  cwd: string;
  shell: string;
};

type TerminalOutput = {
  id: string;
  data: string;
};

type TerminalCompletion = {
  id: string;
  exitCode: number;
};

export type WorkspaceTerminalEvent = TerminalOutput | TerminalCompletion;
