import { randomUUID } from 'node:crypto';
import type { ActivitySummary, AssetRef, SessionSummary, StoredText, ToolCallRecord } from '../../../../contracts/session.js';
import { overlappingRequestTurns, recordedRequestTurn } from '../../../../contracts/chronology.js';
import { logWarn } from '../../../infrastructure/settings/logger.js';
import { redactCredentialText } from '../../../infrastructure/settings/redaction.js';
import { currentCall, emptyEvidence } from '../../../infrastructure/tool-gateway/protocol/call-context.js';
import {
  MAX_TOOL_ARGS_CHARS,
  MAX_TOOL_RESULT_CHARS,
  appendEvent,
  completeProcessCall,
  conversationAttachment,
  conversationWasSuperseded,
  getSession,
  readCompletedFinal,
  recordProcessCall,
  writeAsset
} from './store.js';
import { storeImage } from './recorder-images.js';
import { redactArgs, redactResult, safeJson } from './event-redaction.js';
import { summarizeToolCall } from './summarize.js';
import type { LiveConversation } from './recorder-observations.js';
import type { ToolCallInput, ToolCallTarget } from './recorder-tool-call-types.js';

const MAX_REVIEW_FILES = 32;
const MAX_REVIEW_BYTES = 512 * 1024;
const MAX_REVIEW_CALL_BYTES = 2 * 1024 * 1024;

export type RecorderCallAttributionListener = (
  conversationId: string | null,
  sessionId: string,
  currentConversation: boolean,
  startedAt: number,
  endsActivity: boolean,
  completedFinalAt: number | null,
  requestId: string | null,
  reopenedTurnId: string | null,
  filedSession: SessionSummary | null
) => void;

export interface RecorderToolWriterDependencies {
  recordingEnabled(): boolean;
  conversations: Map<string, LiveConversation>;
  targetSession(target: ToolCallTarget): Promise<string | null>;
  storeText(sessionId: string, text: string, cap: number): Promise<StoredText>;
  serializeObservations<T>(key: string, run: () => Promise<T>): Promise<T>;
  reopenFalselyEndedTurn(
    sessionId: string,
    conversationId: string | null,
    requestId: string | null,
    startedAt: number,
    agent: string | null,
    turnId: string | null
  ): Promise<string | null>;
  notifyChanged(sessionId: string): void;
  trackPending(work: Promise<unknown>): void;
  attributionListener(): RecorderCallAttributionListener | null;
}

export function createRecorderToolWriter(dependencies: RecorderToolWriterDependencies) {
  async function fileToolCall(input: ToolCallInput, initialTarget: ToolCallTarget): Promise<ToolCallRecord | null> {
    if (!dependencies.recordingEnabled()) return null;

    try {
      let target = initialTarget;
      if (
        target.conversationId &&
        (await conversationAttachment(target.conversationId, target.sessionId)) === 'superseded'
      ) target = { ...target, attribution: 'superseded', turnId: null };

      const evidence = input.evidence ?? currentCall()?.evidence ?? emptyEvidence();
      const sessionId = await dependencies.targetSession(target);
      if (!sessionId) return null;

      if (target.attribution === 'request_id' && target.conversationId && input.requestId) {
        const stored = await getSession(sessionId);
        const owner = recordedRequestTurn(stored?.requestTurns, input.requestId, target.conversationId);
        if (
          owner !== undefined &&
          !(owner && target.turnId && overlappingRequestTurns(
            stored?.timelineTurns,
            owner.turnId,
            target.turnId,
            stored?.requestTurns,
            input.requestId
          ))
        ) target = { ...target, turnId: owner?.turnId ?? null };
      }

      let eventAgent = input.agent ?? null;
      let callModel: Pick<ToolCallRecord, 'model' | 'reasoningEffort'> = {};
      if (target.conversationId) {
        const summary = await getSession(sessionId);
        const selection = summary?.selectedModel;
        const live = dependencies.conversations.get(target.conversationId);
        if (
          selection?.conversationId === target.conversationId && live?.turnId === target.turnId &&
          live.turnStartedAt !== null && live.turnStartedAt !== undefined &&
          selection.observedAt <= live.turnStartedAt && selection.observedAt <= input.startedAt
        ) {
          callModel = {
            model: selection.model,
            ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {})
          };
        }
        const origin = summary?.origin;
        if (origin?.kind === 'worker' && origin.agentId && /^worker-\d+$/.test(origin.agentId)) {
          eventAgent = origin.agentId;
        }
      }

      const textParts = input.content.filter(part => part.type === 'text').map(part => part.text ?? '');
      const authoredResultText = redactResult(input.tool, textParts.join('\n'));
      const resultText = input.protocolResult === undefined
        ? authoredResultText
        : redactResult(input.tool, safeJson(input.protocolResult));
      const assets: AssetRef[] = [...evidence.assets];
      let missingImages = 0;
      const imageRecordingReasons = new Set<string>();
      for (const part of input.content) {
        if (part.type !== 'image') continue;
        try {
          assets.push(await storeImage(sessionId, part.data ?? '', part.mimeType ?? 'image/png'));
        } catch (error) {
          missingImages++;
          const message = error instanceof Error ? error.message : '';
          const reason = message === 'Global session asset quota exceeded' || message === 'Session asset quota exceeded'
            ? 'recording storage limit reached'
            : message === 'Session image exceeds the recording limit' ? 'recording image size limit' : 'recording write failed';
          imageRecordingReasons.add(reason);
          logWarn(`session image not stored: ${reason}`);
        }
      }

      const activity: ActivitySummary = summarizeToolCall({
        tool: input.tool,
        args: input.args,
        evidence,
        outcome: input.outcome,
        durationMs: input.durationMs,
        resultHead: authoredResultText.split('\n', 1)[0] ?? ''
      });
      if (missingImages) {
        const note = `${missingImages} image preview(s) not saved: ${[...imageRecordingReasons].join('; ')}. Image content remains in the tool response.`;
        activity.detail = activity.detail ? `${activity.detail} · ${note}` : note;
        if (activity.tone !== 'bad') activity.tone = 'warn';
      }

      const changes = evidence.changes.map(change => ({ ...change }));
      if (input.outcome === 'ok') {
        let reviewBytes = 0;
        evidence.reviews.forEach((review, position) => {
          const change = changes[review.changeIndex];
          if (change) change.reviewUnavailable = position < MAX_REVIEW_FILES ? undefined : 'not-kept';
        });
        for (const review of evidence.reviews.slice(0, MAX_REVIEW_FILES)) {
          const change = changes[review.changeIndex];
          if (!change) continue;
          const bytes = Buffer.from(JSON.stringify({ before: review.before, after: review.after }), 'utf8');
          if (bytes.length > MAX_REVIEW_BYTES) {
            change.reviewUnavailable = 'too-large';
            continue;
          }
          if (reviewBytes + bytes.length > MAX_REVIEW_CALL_BYTES) {
            change.reviewUnavailable = 'not-kept';
            continue;
          }
          try {
            const asset = await writeAsset(sessionId, bytes, 'text/plain');
            change.reviewAssetId = asset.id;
            delete change.reviewUnavailable;
            reviewBytes += bytes.length;
          } catch {
            change.reviewUnavailable = 'not-kept';
          }
        }
        for (const change of changes) if (change.reviewUnavailable === undefined) delete change.reviewUnavailable;
      }

      const call: ToolCallRecord = {
        ...(input.nested === true ? { nested: true } : {}),
        ...(target.attribution === 'request_id' && target.conversationId && evidence.processCompletion &&
          evidence.processSessionId && input.tool === 'exec_command'
          ? { process: { sessionId: evidence.processSessionId } }
          : {}),
        ...callModel,
        callId: randomUUID(),
        tool: input.tool,
        attribution: target.attribution,
        requestId: input.requestId ?? null,
        conversationId: target.conversationId,
        attributionMethod: target.attribution === 'superseded'
          ? 'superseded'
          : target.conversationId && input.requestId ? 'request_id' : 'unattributed',
        args: await dependencies.storeText(
          sessionId,
          redactCredentialText(safeJson(redactArgs(input.tool, input.args))),
          MAX_TOOL_ARGS_CHARS
        ),
        result: await dependencies.storeText(sessionId, resultText, MAX_TOOL_RESULT_CHARS),
        outcome: input.outcome,
        durationMs: input.durationMs,
        summary: activity,
        ...(changes.length > 0 ? { changes } : {}),
        ...(assets.length > 0 ? { assets } : {}),
        ...(input.endsActivity === true ? { endsActivity: true as const } : {})
      };

      const record = call.process ? recordProcessCall : appendEvent;
      await record(sessionId, {
        time: input.startedAt,
        source: 'mcp',
        kind: 'tool_call',
        call,
        ...(eventAgent ? { agent: eventAgent } : {}),
        ...(target.turnId ? { turnId: target.turnId } : {})
      });
      if (call.process && evidence.processCompletion) {
        void evidence.processCompletion.then(completion => {
          const work = completeProcessCall(sessionId, call.callId, completion)
            .then(() => dependencies.notifyChanged(sessionId))
            .catch(() => logWarn('session recorder could not store process completion'));
          dependencies.trackPending(work);
        });
      }

      const reopenedTurnId = input.endsActivity === true
        ? null
        : await dependencies.serializeObservations(target.conversationId ?? sessionId, () =>
            dependencies.reopenFalselyEndedTurn(
              sessionId,
              target.conversationId,
              input.requestId ?? null,
              input.startedAt,
              eventAgent,
              target.turnId
            )
          );
      dependencies.notifyChanged(sessionId);
      try {
        const completed = target.conversationId ? await readCompletedFinal(sessionId, target.conversationId) : null;
        const filed = await getSession(sessionId);
        const currentConversation = target.conversationId !== null &&
          filed?.conversationId === target.conversationId &&
          !(await conversationWasSuperseded(target.conversationId));
        dependencies.attributionListener()?.(
          target.conversationId,
          sessionId,
          currentConversation,
          input.startedAt,
          input.endsActivity === true,
          completed?.completedAt ?? null,
          input.requestId ?? null,
          reopenedTurnId,
          filed
        );
      } catch (error) {
        logWarn(`call attribution listener failed: ${(error as Error).message}`);
      }
      return call;
    } catch (error) {
      logWarn(`session recorder could not store a tool call: ${(error as Error).message}`);
      return null;
    }
  }

  return { fileToolCall };
}
