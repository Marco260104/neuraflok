import { ipcRenderer } from "electron";

export type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

export const call = <T>(channel: string, payload?: unknown): Promise<Reply<T>> =>
  ipcRenderer.invoke(channel, payload) as Promise<Reply<T>>;
