import type { BrowserWindow } from 'electron';
import type { AppState } from '../../../contracts/types.js';

export type IpcHandler = <T>(channel: string, fn: (payload: unknown) => Promise<T>) => void;

export interface IpcRouteContext {
  handle: IpcHandler;
  getWindow: () => BrowserWindow | null;
  buildState: () => Promise<AppState>;
  push: (channel: string, ...args: unknown[]) => void;
}
