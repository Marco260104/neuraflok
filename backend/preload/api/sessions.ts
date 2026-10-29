import { ipcRenderer } from "electron";
import type { SessionControlsView } from "../../domains/browser/bridge.js";
import type { InputArgs, InputEntry } from "../../domains/sessions/input/input.js";
import type { InputAttachment } from "../../../contracts/input.js";
import type { SessionSummary } from "../../../contracts/session.js";
import type { ActiveWorkspaceProcess } from "../../../contracts/workspace/execution/active-process.js";
import type { RunningToolActivity, SessionSearchReply, SessionSearchLocation, Handoff, ImageStorageClearMode, ImageStorageClearResult, ImageStorageInfo } from "../../../contracts/session.js";
import type { SessionList, SessionListCursor, SessionDetail } from "./contracts.js";
import { call } from "./shared.js";

export function createSessionsApi() {
  return {
    listSessions: (options?: { cursor?: SessionListCursor; limit?: number }) =>
        call<SessionList>('sessions:list', options ?? {}),
    getSessionImage: (id: string, assetId: string) => call<string | null>('sessions:image', { id, assetId }),
    getImageStorage: () => call<ImageStorageInfo>('sessions:imageStorage'),
    clearImageStorage: (mode: ImageStorageClearMode) => call<ImageStorageClearResult>('sessions:clearImageStorage', { mode }),
    getSession: (id: string, options?: { from?: number; before?: number; after?: number; limit?: number }) =>
        call<SessionDetail>('sessions:events', { id, ...options }),
    stopSessionTurn: (id: string, expectedTurnId: string) => call<SessionControlsView>('sessions:stopTurn', { id, expectedTurnId }),
    releaseSessionFinish: (id: string, expectedTurnId: string) => call<SessionControlsView>('sessions:releaseFinish', { id, expectedTurnId }),
    generateFinishGoal: (id: string, expectedTurnId: string) => call<string>('sessions:generateFinishGoal', { id, expectedTurnId }),
    getSessionControls: (id: string) => call<SessionControlsView>('sessions:controls', { id }),
    cancelRecovery: (id: string) => call<boolean>('sessions:cancelRecovery', { id }),
    setSessionAutomation: (id: string, automation: SessionControlsView['automation'], afterTurn?: boolean) => call<SessionControlsView>('sessions:automation', { id, automation, afterTurn }),
    setSessionObjective: (id: string, text: string, mode: 'goal' | 'loop') => call<SessionControlsView>('sessions:objective', { id, text, mode }),
    compactSession: (id: string) => call<SessionControlsView>('sessions:compact', { id }),
    cancelSessionCompaction: (id: string) => call<SessionControlsView>('sessions:cancelCompaction', { id }),
    draftTaskPlan: (text: string, backend: 'api' | 'web', requestId?: string) => call<string[]>('sessions:plan', { text, backend, requestId }),
    ensureAttachmentSession: (sessionId: string | null, projectId: string | null) =>
      call<SessionSummary>('sessions:ensureAttachmentSession', { sessionId, projectId }),
    uploadProviderAttachments: (sessionId: string, attachments: InputAttachment[]) =>
      call<{ sessionId: string; attachmentIds: string[]; ready: true }>('sessions:uploadProviderAttachments', { sessionId, attachments }),
    removeProviderAttachments: (sessionId: string, attachments: InputAttachment[]) =>
      call<{ sessionId: string; attachmentIds: string[]; removed: true }>('sessions:removeProviderAttachments', { sessionId, attachments }),
    sendInput: (input: InputArgs) => call<InputEntry>('sessions:send', input),
    retryInputBrowser: (id: string) => call<InputEntry | null>('sessions:retryBrowser', { id }),
    listInputs: () => call<InputEntry[]>('sessions:outbox'),
    listPausedHelpers: () => call<Array<{ id: string; sourceSessionId: string }>>('sessions:pausedHelpers'),
    runningTools: (conversationIds: string[]) => call<RunningToolActivity[]>('sessions:runningTools', { conversationIds }),
    runningProcesses: (sessionId: string) => call<ActiveWorkspaceProcess[]>('sessions:runningProcesses', { sessionId }),
    stopProcess: (sessionId: string, processId: number, incarnation: number) =>
        call<boolean>('sessions:stopProcess', { sessionId, processId, incarnation }),
    onBackgroundProcessesChanged: (listener: () => void): (() => void) => {
        const wrapped = (): void => listener();
        ipcRenderer.on('sessions:backgroundExecChanged', wrapped);
        return () => ipcRenderer.removeListener('sessions:backgroundExecChanged', wrapped);
      },
    retryHelper: (id: string, sourceSessionId: string) => call<boolean>('sessions:retryHelper', { id, sourceSessionId }),
    editQueuedInput: (id: string, text: string, afterTurn?: boolean) => call<boolean>('sessions:editInput', { id, text, afterTurn }),
    reorderQueuedInputs: (sessionId: string, ids: string[]) => call<boolean>('sessions:reorderInputs', { sessionId, ids }),
    cancelInput: (id: string) => call<boolean>('sessions:cancelInput', { id }),
    setInputAutomation: (id: string, mode: 'off' | 'goal' | 'loop', loopAfterTurn?: boolean) => call<boolean>('sessions:inputAutomation', { id, mode, loopAfterTurn }),
    setZoom: (factor: number) => call<number>('window:zoom', { factor }),
    getZoom: () => call<number>('window:getZoom'),
    openSessionChat: (id: string) => call<boolean>('sessions:openChat', { id }),
    setSessionBlocked: (id: string, blocked: boolean) => call<string[]>('sessions:block', { id, blocked }),
    setSessionTrusted: (id: string, expectedConversationId: string, trusted: boolean) =>
        call<string[]>('sessions:trust', { id, expectedConversationId, trusted }),
    deleteSession: (id: string) => call<boolean>('sessions:delete', { id }),
    searchSessions: (query: string) => call<SessionSearchReply>('sessions:search', { query }),
    locateSearchMatch: (id: string, query: string) => call<SessionSearchLocation | null>('sessions:locate-match', { id, query }),
    renameSession: (id: string, title: string | null) => call<boolean>('sessions:rename', { id, title }),
    getHandoff: (id: string, handoffId?: string) => call<Handoff | null>('handoff:get', { id, handoffId })
  };
}
