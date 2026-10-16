export interface ProcessRecord {
  pid: number;
  executable: string;
  command: string;
}

export function selectVitestProcesses(processes: ProcessRecord[], currentPid?: number): ProcessRecord[];
export function stopProcesses(processes: Array<Pick<ProcessRecord, 'pid'>>, terminate?: (pid: number, signal: NodeJS.Signals) => void): number;
