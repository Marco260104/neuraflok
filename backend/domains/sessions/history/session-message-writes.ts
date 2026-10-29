import { authoredTimeOf } from '../../../../contracts/chronology.js';
import { eventTokens, workSequence, type StoredText } from '../../../../contracts/session.js';
import { logError } from '../../../infrastructure/settings/logger.js';
import { refreshUserTitle } from './title.js';
import { applyToSummary, noteFinishWork } from './session-summary-projection.js';
import type { MessageEvent, NativeImageEvent, NewMessageEvent, NewNativeImageEvent, sessionMessageWritesRuntime } from './store.js';

type Runtime = typeof sessionMessageWritesRuntime;

export function createSessionMessageWrites(runtime: Runtime) {
  const { admittedAssets, deniedAssetIds, ensureOpen, messageKey, mergedRetiredAssetIds, retainedAssets, scheduleMeta, writeCanonicalMessage } = runtime;

  /** Exact equality for the fixed StoredText wire shape without serialising large prose. */
  function storedTextEqual(left: StoredText | undefined, right: StoredText | undefined): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    return (
      left.text === right.text &&
      left.truncated === right.truncated &&
      left.chars === right.chars &&
      left.assetId === right.assetId &&
      left.digest === right.digest
    );
  }

  // Creates or revises one canonical provider message by its own stable id. `seq` is the revision/cursor sequence so an incremental reader notices an update. `origin` preserves the sequence/time position where that stable website message first appeared, so revisions cannot move either a user response boundary or assistant prose through later work.
  function upsertMessageEvent(
    sessionId: string,
    event: NewMessageEvent,
    options: { preferTime?: boolean; work?: boolean } = {}
  ): Promise<{ event: MessageEvent; changed: boolean; contentChanged: boolean }> {
    const directKey = messageKey(event as MessageEvent);
    if (!directKey) throw new Error('Canonical message update requires provider messageId');
    return ensureOpen(sessionId).then((entry) => {
      const write = entry.queue.then(async () => {
        // Provider create_time can change after a tab reload while the actual message UUID stays identical. Preserve the first canonical anchor on that exact evidence; never collapse distinct authored segments by working-turn tuple or matching text. Legacy observations without a provider UUID keep their key.
        const providerMessageId = event.kind === 'assistant_message' ? event.providerMessageId : undefined;
        const providerMatches = providerMessageId
          ? [...entry.messages.entries()].filter(([, candidate]) => candidate.kind === 'assistant_message' &&
              candidate.providerMessageId === providerMessageId)
          : [];
        const key = !entry.messages.has(directKey) && providerMatches.length === 1 ? providerMatches[0]![0] : directKey;
        const candidate = entry.messages.get(key);
        const previous = candidate?.kind === 'tool_call' ? undefined : candidate;
        // A changed provider timestamp caused this alias; it is not a correction of the original anchor. Same-key DOM-to-Fiber timestamp promotion still applies.
        const preferTime = options.preferTime === true && key === directKey;
        if (previous && key !== directKey) event = { ...event, messageId: previous.messageId };
        // Final is terminal for one canonical provider message. The page can briefly re-report an older streaming DOM snapshot after settling/remounting; accepting that snapshot would turn a completed answer back into a partial one and could replace its text.
        if (
          previous?.kind === 'assistant_message' &&
          event.kind === 'assistant_message' &&
          (previous.final === true || previous.state === 'final') &&
          event.final !== true &&
          event.state !== 'final'
        ) {
          return { event: previous, changed: false, contentChanged: false };
        }

        // Message bodies can be hundreds of kilobytes. StoredText has a fixed five-field shape, so a direct comparison avoids repeated full-string serialization on every streaming observation.
        const sameMessage =
          previous?.kind === event.kind && storedTextEqual(previous.message, event.message);

        const nextEvent: NewMessageEvent =
          previous?.kind === 'assistant_message' && event.kind === 'assistant_message'
            ? {
                ...event,
                // The producer already supplied the stable website identity. Keep that exact identity through every revision; a different id is a different logical row.
                messageId: previous.messageId,
                authoredAt: authoredTimeOf(previous) ?? event.authoredAt,
                providerMessageId: event.providerMessageId ?? previous.providerMessageId,
                resolvedModel: event.resolvedModel ?? previous.resolvedModel,
                // `final` is a compatibility mirror of state, not an independent truth.
                state: event.state === 'final' || event.final === true ? 'final' : 'streaming',
                final: event.state === 'final' || event.final === true,
                // Goal eligibility is an accepted fact about this stable reply, not a property a later sparse page snapshot may retract. This is what makes a 503/reload replay re-offer the same durable obligation instead of silently dropping it.
                ...(previous.goalEligible === true ? { goalEligible: true } : {}),
              }
            : previous?.kind === 'user_message' && event.kind === 'user_message'
              ? { ...event, inputId: event.inputId ?? previous.inputId,
                  authoredAt: previous.authoredAt ?? event.authoredAt,
                  authoredText: event.authoredText ?? previous.authoredText,
                  wireTokenEstimate: event.wireTokenEstimate ?? previous.wireTokenEstimate,
                  reaction: event.reaction === undefined ? previous.reaction : event.reaction,
                  // App-owned originals/previews retain their outbox identity when the provider later observes different native attachment ids for that send.
                  attachments: previous.inputId ? previous.attachments ?? event.attachments : event.attachments ?? previous.attachments,
                  attachmentUpload: event.attachmentUpload ?? previous.attachmentUpload,
                  inputDelivery: previous.inputDelivery === 'confirmed' ? 'confirmed' : event.inputDelivery ?? previous.inputDelivery,
                  model: event.model ?? previous.model,
                  reasoningEffort: event.reasoningEffort ?? previous.reasoningEffort,
                  retiredImageAssetIds: mergedRetiredAssetIds(previous.retiredImageAssetIds,
                    deniedAssetIds(sessionId, event.assets ?? previous.assets)),
                  assets: admittedAssets(sessionId,
                    retainedAssets(event.assets ?? previous.assets, previous.retiredImageAssetIds)) }
              : event.kind === 'user_message'
                ? {
                    ...event,
                    retiredImageAssetIds: mergedRetiredAssetIds(event.retiredImageAssetIds,
                      deniedAssetIds(sessionId, event.assets)),
                    assets: admittedAssets(sessionId, event.assets)
                  }
                : event;
        // A canonical assistant message belongs to exactly one generation permanently. Ownership may still be *promoted* from "not known yet" to a durable generation id when the recorder learns it late, but a settled assistant answer may never move to another turn. User messages are different: their page-side turn marker is a boundary hint and can be revised as provider re-homes the same stable user object, so preserve that existing behaviour instead of freezing it under the first marker we happened to observe. Live 2026-08-21, session `00000019`: provider re-mounted its stop control for two seconds well after a page load, the extension minted generation `g-11kz85q585v4s-0-1` for it, and the re-observation of the already finished 08:40:34 answer re-filed that answer under a turn that started at 08:45:22. The consequences are not cosmetic — the answer is torn away from the eight tool calls that produced it, so the extension can no longer prove its reconstruction of that turn complete and drops the whole response back to provider's native rendering, and the desktop timeline draws an empty turn with a five-minute-old message inside it.
        const settledTurnId =
          previous?.kind === 'assistant_message' && nextEvent.kind === 'assistant_message'
            ? previous.turnId ?? nextEvent.turnId ?? undefined
            : nextEvent.turnId ?? undefined;
        if (
          previous &&
          previous.kind === nextEvent.kind &&
          sameMessage &&
          nextEvent.authoredAt === previous.authoredAt &&
          nextEvent.model === previous.model &&
          nextEvent.reasoningEffort === previous.reasoningEffort &&
          (previous.kind !== 'assistant_message' ||
            (nextEvent.kind === 'assistant_message' &&
              previous.state === nextEvent.state &&
              previous.final === nextEvent.final &&
              previous.goalEligible === nextEvent.goalEligible &&
              previous.providerMessageId === nextEvent.providerMessageId &&
              previous.resolvedModel === nextEvent.resolvedModel)) &&
          (nextEvent.kind !== 'user_message' || previous.kind !== 'user_message' ||
            (nextEvent.reaction === previous.reaction && nextEvent.inputId === previous.inputId && nextEvent.authoredText === previous.authoredText && nextEvent.wireTokenEstimate === previous.wireTokenEstimate && nextEvent.inputDelivery === previous.inputDelivery && nextEvent.attachmentUpload === previous.attachmentUpload && JSON.stringify(nextEvent.assets) === JSON.stringify(previous.assets) && JSON.stringify(nextEvent.retiredImageAssetIds) === JSON.stringify(previous.retiredImageAssetIds) && JSON.stringify(nextEvent.attachments) === JSON.stringify(previous.attachments))) &&
          (previous.turnId ?? undefined) === settledTurnId &&
          (nextEvent.agent === undefined || previous.agent === nextEvent.agent) &&
          (!preferTime || previous.time === nextEvent.time)
        ) {
          return { event: previous, changed: false, contentChanged: false };
        }
        const full = {
          ...nextEvent,
        // Cursor revisions publish identity without manufacturing work. A reload may reserialize an existing user bubble. Its updated text belongs in history, but only a just-authored observation may revoke its recovery. A new question identity and the first final still advance this work stamp.
          contentSeq: options.work === false &&
            ((nextEvent.kind === 'user_message' && !!previous) || (nextEvent.kind === 'assistant_message' && !nextEvent.final))
            ? previous ? workSequence(previous) : 0
            : sameMessage && previous && (nextEvent.kind !== 'assistant_message' ||
            (previous.kind === 'assistant_message' && (previous.final === true || previous.state === 'final') === nextEvent.final))
            ? workSequence(previous) : entry.nextSeq,
          ...(nextEvent.kind === 'assistant_message' && nextEvent.final
            ? { finalContentSeq: sameMessage && previous?.kind === 'assistant_message' &&
                  (previous.final === true || previous.state === 'final')
                // Older records may not carry a content revision cursor, so retain the first anchor until new final text arrives.
                ? previous.finalContentSeq ?? previous.origin ?? previous.seq
                : entry.nextSeq,
                finalObservedAt: sameMessage && previous?.kind === 'assistant_message' &&
                  (previous.final === true || previous.state === 'final')
                  ? previous.finalObservedAt : Date.now() }
            : {}),
          // First appearance is chronology; current seq is delivery cursor/revision. A page-model authored timestamp is stronger than a DOM first-sight timestamp. The recorder opts into that correction explicitly; ordinary revisions still keep the original first-seen time forever.
          time: preferTime ? nextEvent.time : previous?.time ?? nextEvent.time,
          ...(settledTurnId === undefined ? {} : { turnId: settledTurnId }),
          ...(previous?.agent && !nextEvent.agent ? { agent: previous.agent } : {}),
          ...(nextEvent.kind === 'assistant_message' || nextEvent.kind === 'user_message'
            ? { origin: previous?.kind === nextEvent.kind ? previous.origin ?? previous.seq : entry.nextSeq }
            : {}),
          seq: entry.nextSeq
        } as MessageEvent;

        await writeCanonicalMessage(sessionId, key, full);

        entry.nextSeq += 1;
        entry.messages.set(key, full);
        if (full.kind === 'user_message') refreshUserTitle(entry.summary, entry.messages.values());
        if (!previous) {
          applyToSummary(entry.summary, full);
        } else {
          // A revision is not another logical event. Only its text/token weight and recency replace what the previous snapshot contributed to the session projection.
          const delta = eventTokens(full) - eventTokens(previous);
          entry.summary.estimatedTokens = Math.max(0, entry.summary.estimatedTokens + delta);
          entry.summary.contextTokens = Math.max(0, entry.summary.contextTokens + delta);
          entry.summary.updatedAt = Math.max(entry.summary.updatedAt, nextEvent.time);
          noteFinishWork(entry.summary, full);
          if (full.kind === 'assistant_message' && (full.final === true || full.state === 'final')) {
            entry.summary.lastAssistantFinalAt = Math.max(
              entry.summary.lastAssistantFinalAt ?? 0,
              nextEvent.time
            );
          }
          if (full.agent && !entry.summary.agents.includes(full.agent)) entry.summary.agents.push(full.agent);
        }
        entry.historySeq = full.seq;
        scheduleMeta(entry);
        return { event: full, changed: true, contentChanged: !sameMessage };
      });
      entry.queue = write.then(
        () => undefined,
        (err: Error) => logError(`session message upsert failed: ${err.message}`)
      );
      return write;
    });
  }

  // Creates or enriches one provider-native generated image by exact provider tuple. Metadata is canonical before preview capture starts. A later asset revision advances the sequence cursor while retaining the first origin/time and never contributes completion, Goal, tool-call, or activity facts. Local turn ownership may strengthen once from unknown; later document-local turn hints are ignored because reload remints them, while a conflicting durable agent owner still fails closed.
  function upsertNativeImageEvent(
    sessionId: string,
    event: NewNativeImageEvent
  ): Promise<{ event: NativeImageEvent; changed: boolean; accepted: boolean }> {
    const key = messageKey(event);
    if (!key) throw new Error('Canonical native image requires provider message and asset ids');
    return ensureOpen(sessionId).then((entry) => {
      const write = entry.queue.then(async () => {
        const candidate = entry.messages.get(key);
        const previous = candidate?.kind === 'native_image' ? candidate : undefined;
        if (candidate && !previous) throw new Error('Canonical native image identity collision');
        if (
          previous &&
          (previous.providerRole !== event.providerRole ||
            (previous.agent && event.agent && previous.agent !== event.agent))
        ) return { event: previous, changed: false, accepted: false };
        // Explicit image-storage cleanup is a durable decision for this exact provider tuple. A later tab reload may rediscover and re-encode the same native image; accepting it would silently refill storage immediately after the user cleared it.
        if (previous?.previewError === 'removed' && !previous.asset) {
          return { event: previous, changed: false, accepted: false };
        }

        const incomingAsset = event.asset ? admittedAssets(sessionId, [event.asset])?.[0] : undefined;
        const staleAsset = Boolean(event.asset && !incomingAsset);
        const asset = previous?.asset ?? incomingAsset;
        const previewError = previous?.previewError === 'quota' && !asset
          ? 'quota'
          : staleAsset
            ? 'removed'
            : event.previewError ?? previous?.previewError;
        const previewStatus = asset
          ? 'available'
          : previewError
            ? 'unavailable'
            : event.previewStatus;
        const next: NewNativeImageEvent = {
          ...event,
          time: previous?.time ?? event.time,
          ...(previous?.turnId ? { turnId: previous.turnId } : event.turnId ? { turnId: event.turnId } : {}),
          ...(previous?.agent && !event.agent ? { agent: previous.agent } : {}),
          providerChannel: previous?.providerChannel ?? event.providerChannel,
          providerStatus: previous?.providerStatus === 'finished_successfully'
            ? previous.providerStatus : event.providerStatus ?? previous?.providerStatus,
          width: previous?.width ?? event.width,
          height: previous?.height ?? event.height,
          asset: undefined,
          previewStatus,
          previewError,
          ...(asset ? {
            asset,
            previewStatus: 'available',
            previewWidth: previous?.previewWidth ?? event.previewWidth,
            previewHeight: previous?.previewHeight ?? event.previewHeight,
            previewError: undefined
          } : {})
        };
        if (previous) {
          const unchanged =
            previous.turnId === next.turnId && previous.agent === next.agent &&
            previous.providerChannel === next.providerChannel && previous.providerStatus === next.providerStatus &&
            previous.width === next.width && previous.height === next.height &&
            previous.previewWidth === next.previewWidth && previous.previewHeight === next.previewHeight &&
            previous.previewStatus === next.previewStatus && previous.previewError === next.previewError &&
            previous.asset?.id === next.asset?.id && previous.asset?.mimeType === next.asset?.mimeType &&
            previous.asset?.bytes === next.asset?.bytes;
          if (unchanged) return { event: previous, changed: false, accepted: true };
        }
        const full: NativeImageEvent = {
          ...next,
          origin: previous?.origin ?? previous?.seq ?? entry.nextSeq,
          seq: entry.nextSeq
        };
        await writeCanonicalMessage(sessionId, key, full);
        entry.messages.set(key, full);
        entry.nextSeq += 1;
        entry.historySeq = full.seq;
        if (!previous) applyToSummary(entry.summary, full);
        scheduleMeta(entry);
        return { event: full, changed: true, accepted: true };
      });
      entry.queue = write.then(
        () => undefined,
        (err: Error) => logError(`session native image upsert failed: ${err.message}`)
      );
      return write;
    });
  }

  return { upsertMessageEvent, upsertNativeImageEvent };
}
