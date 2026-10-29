import { userTitle } from './title.js';
import { recordNativeImage } from './recorder-images.js';
import type { ChatObservation, LiveConversation, ObservationRuntime } from './recorder-observation-types.js';
import { pageToolKey } from './recorder-observation-tools.js';
import { appendEvent, conversationWasSuperseded, findSessionByConversation, MAX_USER_MESSAGE_CHARS, upsertMessageEvent } from './store.js';
// Keep native activity row identity stable across label changes and renderer generations.
export async function recordPageTool(
  sessionId: string,
  live: LiveConversation | undefined,
  item: ChatObservation,
  base: { time: number; source: 'extension'; turnId?: string; internalWarmup?: true; agent?: string }
): Promise<boolean> {
  const id = item.messageId;
  const label = (item.text ?? '').slice(0, 300).trim();
  if (!id || !label) return false;
  if (!live) {
    await appendEvent(sessionId, { ...base, kind: 'page_tool', messageId: id, label });
    return true;
  }

  const held = live.pageTools.get(pageToolKey(id));
  if (held && held.text === label) return false;

  const event = await appendEvent(sessionId, {
    ...base,
    ...(held?.turnId ? { turnId: held.turnId } : {}),
    time: held ? held.time : base.time,
    kind: 'page_tool',
    messageId: id,
    label,
    ...(held?.contentSeq !== undefined ? { contentSeq: held.contentSeq } : item.activeNow === false && !held ? { contentSeq: 0 } : {}),
    ...(held ? { origin: held.seq } : {})
  });
  live.pageTools.set(pageToolKey(id), {
    seq: held ? held.seq : event.seq,
    time: held ? held.time : base.time,
    updatedAt: base.time,
    text: label,
    turnId: held?.turnId ?? base.turnId,
    contentSeq: event.kind === 'page_tool' ? event.contentSeq : undefined
  });
  return true;
}


export function observedUserTitle(first?: string): string | undefined {
  return first ? userTitle(first) || undefined : undefined;
}

export function observationTitle(observations: readonly ChatObservation[]): string | undefined {
  const title = observations.find((item) => item.kind === 'conversation_title')?.text?.trim();
  const first = observations.find((item) => item.kind === 'user_message')?.text;
  return title || observedUserTitle(first);
}


// Only a superseded conversation may write into its original session history.
export async function supersededLineage(conversationId: string): Promise<string | null> {
  if (!conversationId || !(await conversationWasSuperseded(conversationId))) return null;
  if (await findSessionByConversation(conversationId)) return null;
  const lineage = await findSessionByConversation(conversationId, { includeHistorical: true });
  return lineage && lineage.conversationId !== conversationId ? lineage.id : null;
}


// A superseded conversation may add messages only; it cannot change live session state.
export async function recordSupersededMessages(
  runtime: ObservationRuntime,
  sessionId: string,
  observations: readonly ChatObservation[]
): Promise<number> {
  const { storeText, notifyChanged } = runtime;
  let stored = 0;
  for (const item of observations) {
    if (!item.messageId) continue;
    const base = {
      time: item.time,
      ...(item.authoredAt !== undefined ? { authoredAt: item.authoredAt } : {}),
      source: 'extension' as const,
      ...(item.turnId ? { turnId: item.turnId } : {})
    };
    let written: { changed: boolean } | null = null;
    if (item.kind === 'user_message') {
      written = await upsertMessageEvent(
        sessionId,
        {
          ...base,
          kind: 'user_message',
          message: await storeText(sessionId, item.text ?? '', MAX_USER_MESSAGE_CHARS),
          ...(item.attachments?.length ? { attachments: item.attachments } : {}),
          ...(item.reaction !== undefined ? { reaction: item.reaction } : {}),
          ...(item.model ? { model: item.model } : {}),
          messageId: item.messageId
        },
        { preferTime: item.authoredTime === true, work: false }
      );
    } else if (item.kind === 'assistant_message') {
      const state = item.state ?? (item.final === true ? 'final' : 'streaming');
      written = await upsertMessageEvent(
        sessionId,
        {
          ...base,
          kind: 'assistant_message',
          message: await storeText(sessionId, item.text ?? '', 256_000),
          messageId: item.messageId,
          state,
          ...(item.providerMessageId ? { providerMessageId: item.providerMessageId } : {}),
          ...(item.resolvedModel ? { resolvedModel: item.resolvedModel } : {}),
          final: state === 'final'
        },
        { preferTime: item.authoredTime === true }
      );
    } else if (item.kind === 'native_image') {
      stored += await recordNativeImage(sessionId, item, base);
      continue;
    }
    if (written?.changed) stored++;
  }
  if (stored > 0) notifyChanged(sessionId);
  return stored;
}

