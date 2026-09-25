import type { CompanionDiagnostics, CompanionPageDiagnostics, CompanionTabDiagnostics, CompanionTraceEntry } from '../../../contracts/types.js';
import { getConfig, updateConfig } from '../../infrastructure/settings/config.js';
import type { BrowserPreferences } from '../../../contracts/browser/preferences.js';
import { logWarn } from '../../infrastructure/settings/logger.js';

let latestDiagnostics: CompanionDiagnostics | null = null;
let diagnosticsRevision = 0;
const diagnosticsWaiters = new Set<() => void>();

function diagnosticObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function diagnosticString(value: unknown, max = 512): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

function diagnosticNumber(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : 0;
}

function diagnosticNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function diagnosticTrace(value: unknown): CompanionTraceEntry[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap(entry => {
    const row = diagnosticObject(entry);
    const requestId = diagnosticString(row?.requestId, 160);
    if (!row || !requestId) return [];
    return [{
      requestId,
      read: row.read === true,
      sent: row.sent === true,
      confirmed: row.confirmed === true,
      app: diagnosticString(row.app, 80),
      tool: diagnosticString(row.tool, 160)
    }];
  });
}

function diagnosticPage(value: unknown): CompanionPageDiagnostics | null {
  const page = diagnosticObject(value);
  if (!page) return null;
  const lastError = diagnosticObject(page.lastError);
  return {
    recorderVersion: diagnosticNullableNumber(page.recorderVersion),
    runId: diagnosticString(page.runId, 160),
    conversationId: diagnosticString(page.conversationId, 200),
    generating: page.generating === true,
    turnId: diagnosticString(page.turnId, 200),
    generations: diagnosticNumber(page.generations, 1_000_000),
    queued: diagnosticNumber(page.queued, 1_000_000),
    queueBytes: diagnosticNumber(page.queueBytes, 64 * 1024 * 1024),
    requestId: diagnosticString(page.requestId, 160),
    trace: diagnosticTrace(page.trace),
    overwrite: page.overwrite === true,
    painted: page.painted === true,
    events: diagnosticNumber(page.events, 10_000_000),
    calls: diagnosticNumber(page.calls, 10_000_000),
    sends: diagnosticNumber(page.sends, 10_000_000),
    failures: diagnosticNumber(page.failures, 10_000_000),
    session: diagnosticString(page.session, 160),
    lastError: lastError && typeof lastError.at === 'number' && Number.isFinite(lastError.at)
      ? { at: lastError.at, text: diagnosticString(lastError.text, 500) ?? '' }
      : null,
    blocked: diagnosticString(page.blocked, 160)
  };
}

function diagnosticTab(value: unknown): CompanionTabDiagnostics | null {
  const tab = diagnosticObject(value);
  if (!tab) return null;
  const delivery = diagnosticObject(tab.delivery);
  return {
    tab: diagnosticNullableNumber(tab.tab),
    isChat: tab.isChat === true,
    conversationId: diagnosticString(tab.conversationId, 200),
    bound: tab.bound === true,
    epoch: diagnosticNullableNumber(tab.epoch),
    terminal: tab.terminal === true,
    recorder: tab.recorder === true,
    page: diagnosticPage(tab.page),
    chatTabs: diagnosticNumber(tab.chatTabs, 10_000),
    pending: diagnosticNumber(tab.pending, 1_000_000),
    pendingAll: diagnosticNumber(tab.pendingAll, 1_000_000),
    pendingCloses: diagnosticNumber(tab.pendingCloses, 1_000_000),
    pendingCommandAcks: diagnosticNumber(tab.pendingCommandAcks, 1_000_000),
    delivery: {
      at: diagnosticNumber(delivery?.at),
      ok: delivery?.ok === true ? true : delivery?.ok === false ? false : null,
      events: diagnosticNumber(delivery?.events, 1_000_000),
      total: diagnosticNumber(delivery?.total, 100_000_000),
      status: diagnosticNumber(delivery?.status, 999),
      error: diagnosticString(delivery?.error, 200)
    }
  };
}

function rememberBrowserPreferences(preferences: BrowserPreferences): void {
  const kept = getConfig().ui.browserPreferences;
  if (kept?.overwrite === preferences.overwrite && kept?.durations === preferences.durations) return;
  void updateConfig(config => ({ ...config, ui: { ...config.ui, browserPreferences: { overwrite: preferences.overwrite, durations: preferences.durations } } }))
    .catch(error => logWarn(`bridge: could not keep the extension preferences: ${(error as Error).message}`));
}

function sanitiseCompanionDiagnostics(value: unknown): CompanionDiagnostics | null {
  const root = diagnosticObject(value);
  const status = diagnosticObject(root?.status);
  const preferences = diagnosticObject(root?.preferences);
  if (!root || !status || !preferences) return null;
  const pairError = diagnosticObject(status.pairError);
  return {
    capturedAt: diagnosticNumber(root.capturedAt),
    status: {
      connected: status.connected === true,
      port: diagnosticNullableNumber(status.port),
      paired: status.paired === true,
      disconnected: status.disconnected === true,
      pending: diagnosticNumber(status.pending, 1_000_000),
      pendingCommandAcks: diagnosticNumber(status.pendingCommandAcks, 1_000_000),
      compatible: status.compatible === true ? true : status.compatible === false ? false : null,
      appVersion: diagnosticString(status.appVersion, 32),
      appProtocol: diagnosticNullableNumber(status.appProtocol),
      extensionVersion: diagnosticString(status.extensionVersion, 32),
      extensionProtocol: diagnosticNullableNumber(status.extensionProtocol),
      pairError: pairError
        ? { error: diagnosticString(pairError.error, 160) ?? '', message: diagnosticString(pairError.message, 500) ?? '' }
        : null
    },
    preferences: {
      overwrite: preferences.overwrite !== false,
      durations: preferences.durations === true
    },
    tab: diagnosticTab(root.tab)
  };
}

export function recordCompanionDiagnostics(value: unknown): void {
  const next = sanitiseCompanionDiagnostics(value);
  if (!next) return;
  if (diagnosticObject(value)?.preferencesStored === true) rememberBrowserPreferences(next.preferences);
  latestDiagnostics = next;
  diagnosticsRevision += 1;
  for (const waiter of diagnosticsWaiters) waiter();
}

export function requestCompanionDiagnostics(wake: () => void, isBrowserPresent: () => boolean): Promise<CompanionDiagnostics | null> {
  const before = diagnosticsRevision;
  wake();
  if (!isBrowserPresent()) return Promise.resolve(latestDiagnostics ? structuredClone(latestDiagnostics) : null);
  return new Promise(resolve => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      diagnosticsWaiters.delete(onUpdate);
      resolve(latestDiagnostics ? structuredClone(latestDiagnostics) : null);
    };
    const onUpdate = (): void => {
      if (diagnosticsRevision > before) finish();
    };
    const timer = setTimeout(finish, 2500);
    timer.unref?.();
    diagnosticsWaiters.add(onUpdate);
    if (diagnosticsRevision > before) finish();
  });
}

export function clearCompanionDiagnostics(): void {
  latestDiagnostics = null;
  diagnosticsRevision++;
  for (const waiter of diagnosticsWaiters) waiter();
}
