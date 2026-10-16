export interface ActiveWorkspaceProcess {
  processId: number;
  incarnation: number;
  command: string;
  startedAt: number;
  tty: boolean;
}
