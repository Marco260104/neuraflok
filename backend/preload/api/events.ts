import { ipcRenderer } from "electron";
import type { TaskProgress } from "../../../contracts/automation/task-progress.js";
import type { AppState, LogEntry } from "../../../contracts/types.js";
import type { ClearAgentResult, SessionChange, SwarmState } from "../../../contracts/session.js";
import { call } from "./shared.js";

export function createEventsApi() {
  return {
    getSwarm: () => call<SwarmState>('swarm:get'),
    resetSwarm: () => call<SwarmState>('swarm:reset'),
    clearAgent: (id: string, runId?: string) => call<ClearAgentResult>('swarm:clearAgent', { id, runId }),
    onStateChanged: (listener: (state: AppState) => void): (() => void) => {
        const wrapped = (_event: unknown, state: AppState): void => listener(state);
        ipcRenderer.on('state:changed', wrapped);
        return () => ipcRenderer.removeListener('state:changed', wrapped);
      },
    onLogEntry: (listener: (entry: LogEntry) => void): (() => void) => {
        const wrapped = (_event: unknown, entry: LogEntry): void => listener(entry);
        ipcRenderer.on('log:entry', wrapped);
        return () => ipcRenderer.removeListener('log:entry', wrapped);
      },
    onSessionChanged: (listener: (change?: SessionChange) => void): (() => void) => {
        const wrapped = (_event: unknown, change?: SessionChange): void => listener(change);
        ipcRenderer.on('session:changed', wrapped);
        return () => ipcRenderer.removeListener('session:changed', wrapped);
      },
    onWriteSession: (listener: (id: string) => void): (() => void) => {
        const wrapped = (_event: unknown, id: string): void => listener(id);
        ipcRenderer.on('session:write', wrapped);
        return () => ipcRenderer.removeListener('session:write', wrapped);
      },
    onTaskProgress: (listener: (progress: TaskProgress) => void): (() => void) => {
        const wrapped = (_event: unknown, progress: TaskProgress): void => listener(progress);
        ipcRenderer.on('task:progress', wrapped);
        return () => ipcRenderer.removeListener('task:progress', wrapped);
      },
    cancelTaskRequest: (requestId: string) => call<boolean>('tasks:cancel', { requestId }),
    draftGoalOpening: (text: string, mode: 'goal' | 'loop', requestId: string) =>
        call<{ reply: string; model: string }>('sessions:goalOpening', { text, mode, requestId }),
    onSwarmChanged: (listener: (state: SwarmState) => void): (() => void) => {
        const wrapped = (_event: unknown, state: SwarmState): void => listener(state);
        ipcRenderer.on('swarm:changed', wrapped);
        return () => ipcRenderer.removeListener('swarm:changed', wrapped);
      }
  };
}
