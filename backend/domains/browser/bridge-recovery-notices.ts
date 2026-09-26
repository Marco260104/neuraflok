import type { ActivityGrant } from './session-activity.js';

type Runtime = {
  logInfo(message: string): void;
  logWarn(message: string): void;
};

type FiberHealth = {
  state: 'absent' | 'empty';
  since: number;
  lastSeenAt: number;
  announced: 'absent' | 'empty' | null;
};

export function createBridgeRecoveryNotices(runtime: Runtime) {
  const { logInfo, logWarn } = runtime;
  const FIBER_HEALTH_GRACE_MS = 15_000;
  const FIBER_HEALTH_GAP_MS = 90_000;
  const fiberHealth = new Map<string, FiberHealth>();
  const REFUSAL_NOTICE_EVERY_MS = 60_000;
  const refusalNoticedAt = new Map<string, number>();
  const markedReplacementNotices = new Set<string>();
  const silenceNotes = new Set<string>();

  function noteFiberHealth(conversationId: string, raw: string | null, now = Date.now()): void {
    if (raw !== 'absent' && raw !== 'empty' && raw !== 'ok') return;
    const seen = fiberHealth.get(conversationId);
    if (raw === 'ok') {
      fiberHealth.delete(conversationId);
      if (!seen?.announced) return;
    } else {
      if (!seen || seen.state !== raw || now < seen.lastSeenAt || now - seen.lastSeenAt >= FIBER_HEALTH_GAP_MS) {
        fiberHealth.set(conversationId, { state: raw, since: now, lastSeenAt: now, announced: seen?.announced ?? null });
        if (fiberHealth.size > 200) {
          for (const old of [...fiberHealth.keys()].slice(0, 50)) fiberHealth.delete(old);
        }
        return;
      }
      seen.lastSeenAt = now;
      if (now - seen.since < FIBER_HEALTH_GRACE_MS || seen.announced === raw) return;
      seen.announced = raw;
    }
    const detail = raw === 'absent' ? 'no answer after the helper repair attempt'
      : raw === 'empty' ? 'the helper answered without readable turns; the page may still be loading'
      : 'the helper answered with readable turns';
    const message = `bridge: ${conversationId} reports its page-model helper as ${raw}: ${detail}`;
    if (raw === 'absent') logWarn(message);
    else logInfo(message);
  }

  function noticeRefusal(key: string, message: string): void {
    const now = Date.now();
    const last = refusalNoticedAt.get(key);
    if (last !== undefined && now >= last && now - last < REFUSAL_NOTICE_EVERY_MS) return;
    refusalNoticedAt.set(key, now);
    if (refusalNoticedAt.size > 500) {
      for (const old of [...refusalNoticedAt.keys()].slice(0, 100)) refusalNoticedAt.delete(old);
    }
    logInfo(message);
  }

  function noteSilence(conversationId: string, grant: ActivityGrant, reason: string): void {
    const key = `${conversationId}:${grant.turnId ?? '-'}:${grant.sessionId}:${reason}`;
    if (silenceNotes.has(key)) return;
    silenceNotes.add(key);
    if (silenceNotes.size > 500) for (const old of [...silenceNotes].slice(0, 100)) silenceNotes.delete(old);
    logInfo(`bridge: silence recovery for ${conversationId} — ${reason}`);
  }

  function noticeMarkedReplacement(conversationId: string, token: string, outcome: string): void {
    const key = `${conversationId}:${token}:${outcome}`;
    if (markedReplacementNotices.has(key)) return;
    markedReplacementNotices.add(key);
    if (markedReplacementNotices.size > 500) {
      for (const old of [...markedReplacementNotices].slice(0, 100)) markedReplacementNotices.delete(old);
    }
    logInfo(`bridge: marked replacement ${conversationId} (${token.slice(0, 8)}): ${outcome}`);
  }

  return {
    noteFiberHealth,
    noticeRefusal,
    noteSilence,
    noticeMarkedReplacement,
    state: {
      FIBER_HEALTH_GRACE_MS,
      FIBER_HEALTH_GAP_MS,
      fiberHealth,
      REFUSAL_NOTICE_EVERY_MS,
      refusalNoticedAt,
      silenceNotes,
      markedReplacementNotices
    }
  };
}
