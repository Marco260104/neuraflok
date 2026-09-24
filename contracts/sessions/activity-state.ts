import { CHAT_ACTIVE_MS, type SessionSummary } from '../session.js';

function projectedActivity(summary: SessionSummary, now: number): boolean | undefined {
  if (summary.activityExpiresAt === undefined) return undefined;
  return summary.activityExpiresAt !== null && now < summary.activityExpiresAt;
}

function mostRecentWork(summary: SessionSummary): number {
  return Math.max(summary.startedAt, summary.lastToolCallAt ?? 0);
}

function mostRecentCompletion(summary: SessionSummary): number {
  return Math.max(summary.lastAssistantFinalAt ?? 0, summary.lastTurnEndAt ?? 0);
}

function hasUnfinishedRecentWork(summary: SessionSummary, now: number): boolean {
  const workAt = mostRecentWork(summary);
  return workAt > mostRecentCompletion(summary) && now - workAt < CHAT_ACTIVE_MS;
}

export function recentChatActivity(summary: SessionSummary, now = Date.now()): boolean {
  return projectedActivity(summary, now) ?? hasUnfinishedRecentWork(summary, now);
}

export function workerReportedFinish(summary: SessionSummary): boolean {
  const finishAt = summary.lastFinishReportAt;
  return summary.origin?.kind === 'worker' && typeof finishAt === 'number' &&
    finishAt >= (summary.lastToolCallAt ?? 0);
}

export function sessionWorkingAt(summary: SessionSummary, now: number): boolean {
  return !workerReportedFinish(summary) && recentChatActivity(summary, now);
}
