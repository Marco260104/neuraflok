import type { ToolCallRecord } from '../../../../contracts/session.js';
import { logWarn } from '../../../infrastructure/settings/logger.js';
import type { RequestCorrelation } from './correlation.js';
import type { LiveConversation } from './recorder-observations.js';
import type { ToolCallInput, ToolCallTarget } from './recorder-tool-call-types.js';

export interface RecorderCallAdmissionDependencies {
  conversations: Map<string, LiveConversation>;
  recordingEnabled(): boolean;
  requestCorrelation(requestId: string): RequestCorrelation | null;
  awaitRequestCorrelation(requestId: string, timeoutMs: number): Promise<RequestCorrelation | null>;
  requestIdGraceMs: number;
  bindAgentConversation(agent: string, conversationId: string): void;
  targetSession(target: ToolCallTarget): Promise<string | null>;
  fileToolCall(input: ToolCallInput, target: ToolCallTarget): Promise<ToolCallRecord | null>;
  pendingRecordings: Set<Promise<unknown>>;
}

export function createRecorderCallAdmission(dependencies: RecorderCallAdmissionDependencies) {
  const requestRecordings = new Map<string, Promise<void>>();
  const sessionRecordings = new Map<string, Promise<void>>();

  function serializeRecording<T>(queues: Map<string, Promise<void>>, key: string, run: () => Promise<T>): Promise<T> {
    const work = (queues.get(key) ?? Promise.resolve()).then(run);
    const settled = work.then(() => undefined, () => undefined);
    queues.set(key, settled);
    void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
    return work;
  }

  function recordToolCall(input: ToolCallInput): Promise<ToolCallRecord | null> {
    if (!dependencies.recordingEnabled()) return Promise.resolve(null);
    let attributing: Promise<ToolCallTarget>;
    if (input.conversationId) {
      const live = dependencies.conversations.get(input.conversationId);
      const correlation = input.requestId ? dependencies.requestCorrelation(input.requestId) : null;
      const target: ToolCallTarget = {
        conversationId: input.conversationId,
        sessionId:
          input.sessionId ??
          (correlation?.conversationId === input.conversationId ? correlation.sessionId : null),
        attribution: 'request_id',
        turnId: live?.turnId ?? null
      };
      if (input.bind) dependencies.bindAgentConversation(input.bind, input.conversationId);
      attributing = Promise.resolve(target);
    } else {
      // Open the evidence wait before entering this workflow's queue, so sequential calls never restart its deadline.
      attributing = input.requestId
        ? dependencies.awaitRequestCorrelation(input.requestId, dependencies.requestIdGraceMs).then((correlation) => {
            const conversationId = correlation?.conversationId ?? null;
            if (!conversationId) {
              logWarn(
                `request attribution: no page evidence for ${input.requestId} within ` +
                  `${dependencies.requestIdGraceMs}ms; filing ${input.tool} under Unattributed activity`
              );
            }
            if (input.bind && conversationId) dependencies.bindAgentConversation(input.bind, conversationId);
            return {
              conversationId,
              sessionId: correlation?.sessionId ?? null,
              attribution: conversationId ? ('request_id' as const) : ('unattributed' as const),
              turnId: conversationId ? dependencies.conversations.get(conversationId)?.turnId ?? null : null
            };
          })
        : Promise.resolve<ToolCallTarget>({ conversationId: null, sessionId: null, attribution: 'unattributed', turnId: null });
    }
    const file = async (): Promise<ToolCallRecord | null> => {
      const target = await attributing;
      const owner = target.sessionId ?? (target.conversationId ? dependencies.conversations.get(target.conversationId)?.sessionId : null);
      const sessionId = owner ?? await dependencies.targetSession(target);
      if (!sessionId) return null;
      return serializeRecording(sessionRecordings, sessionId, () => dependencies.fileToolCall(input, target));
    };
    const filed = (input.requestId ? serializeRecording(requestRecordings, input.requestId, file) : file())
      .catch((err: Error) => { logWarn(`session recorder could not admit a tool call: ${err.message}`); return null; });
    dependencies.pendingRecordings.add(filed);
    void filed.then(() => dependencies.pendingRecordings.delete(filed));
    return filed;
  }

  function reset(): void {
    requestRecordings.clear();
    sessionRecordings.clear();
  }

  return { recordToolCall, reset };
}
