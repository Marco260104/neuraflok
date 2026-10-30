import { ipcRenderer, webUtils } from "electron";
import type { WorkspaceTerminalEvent, WorkspaceTerminalInfo } from "../../../contracts/workspace/terminal.js";
import type { UsageOverview } from "../../../contracts/usage.js";
import type { AppState, LogEntry } from "../../../contracts/types.js";
import type { GoalModelPage, SettingsPatch } from "./contracts.js";
import { call } from "./shared.js";

export function createDesktopApi() {
  return {
    terminalCreate: (id: string, projectId: string | null, cols: number, rows: number) => call<WorkspaceTerminalInfo>('workspaceTerminal:request', { action: 'create', id, projectId, cols, rows }),
    terminalWrite: (id: string, data: string) => call<void>('workspaceTerminal:request', { action: 'write', id, data }),
    terminalResize: (id: string, cols: number, rows: number) => call<void>('workspaceTerminal:request', { action: 'resize', id, cols, rows }),
    terminalAck: (id: string, count: number) => call<void>('workspaceTerminal:request', { action: 'ack', id, count }),
    terminalClose: (id: string) => call<void>('workspaceTerminal:request', { action: 'close', id }),
    onTerminalEvent: (listener: (event: WorkspaceTerminalEvent) => void): (() => void) => {
        const wrapped = (_event: unknown, value: WorkspaceTerminalEvent): void => listener(value);
        ipcRenderer.on('workspaceTerminal:event', wrapped);
        return () => ipcRenderer.removeListener('workspaceTerminal:event', wrapped);
      },
    setStopNoticeTexts: (texts: Record<string, string>) => call<void>('ui:stopNoticeTexts', texts),
    setMainTexts: (texts: Record<string, string>) => call<void>('ui:mainTexts', texts),
    setUiLanguage: (language: string) => call<void>('ui:language', language),
    markWhatsNewSeen: () => call<void>('ui:whatsNewSeen'),
    onKeychainWaiting: (listener: (waiting: boolean) => void): (() => void) => {
        const wrapped = (_event: unknown, waiting: boolean): void => listener(waiting === true);
        ipcRenderer.on('keychain:waiting', wrapped);
        return () => ipcRenderer.removeListener('keychain:waiting', wrapped);
      },
    keychainNoticeReady: () => call<void>('keychain:noticeReady'),
    getUsage: () => call<UsageOverview>('usage:get'),
    getState: () => call<AppState>('state:get'),
    saveSettings: (patch: SettingsPatch, base: SettingsPatch) => call<AppState>('settings:save', { patch, base }),
    addRoot: () => call<AppState>('roots:add'),
    addRootPath: (file: File) => call<AppState>('roots:addPath', { path: webUtils.getPathForFile(file) }),
    removeRoot: (name: string) => call<AppState>('roots:remove', { name }),
    renameRoot: (name: string, newName: string) => call<AppState>('roots:rename', { name, newName }),
    setGoalKey: (value: string) => call<AppState>('secret:set', { value, key: 'openRouterApiKey' }),
    setOpenAiModelKey: (value: string) => call<AppState>('secret:set', { value, key: 'openaiChatApiKey' }),
    setCustomProviderKey: (value: string) => call<AppState>('secret:set', { value, key: 'customProviderApiKey' }),
    setCustomProviderHeaders: (value: string) => call<AppState>('secret:set', { value, key: 'customProviderHeaders' }),
    listGoalModels: (offset: number, query = '') => call<GoalModelPage>('goal:models', { offset, query }),
    saveDiagnosticsReport: () => call<{ saved: false } | { saved: true; name: string }>('diagnostics:saveReport'),
    requestDesktopAccessibility: () => call<AppState>('desktop:requestAccessibility'),
    getLog: () => call<LogEntry[]>('log:get'),
    getLogText: () => call<string>('log:text'),
    getLogJson: () => call<string>('log:json'),
    writeClipboard: (text: string) => call<boolean>('clipboard:write', { text }),
    exportMarkdown: (request: { id: string; scope: 'answer' | 'session'; turnId?: string; target: 'clipboard' | 'file' }) =>
        call<{ done: 'copied' } | { done: 'saved'; name: string } | { done: 'cancelled' }>('sessions:exportMarkdown', request),
    installUpdate: () => call<boolean>('update:install'),
    downloadUpdate: () => call<boolean>('update:download'),
    refreshUpdate: () => call<boolean>('update:refresh')
  };
}
