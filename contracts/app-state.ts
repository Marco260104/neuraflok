import type { Config, PlatformInfo, SecureStorageInfo } from './settings.js';
export interface LogEntry {
  time: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  /** Agent that caused this line, in multi-agent mode only. Absent otherwise. */
  agent?: string;
}

/** What the renderer needs to know about the extension bridge, without any secrets. */
export interface BridgeStatus {
  /** Effective environment override, independent of the saved Settings choice. */
  portOverridden?: boolean;
  /** Last startup failure; a rejected settings change keeps the working bridge status. */
  error?: string | null;
  running: boolean;
  port: number | null;
  /** Durable authorization: true once a browser extension has been issued this app's token. */
  paired: boolean;
  /** Live presence: true only while this app process has heard from the extension recently. */
  present: boolean;
  /** Epoch ms of the last message from the extension, or null. */
  lastSeenAt: number | null;
  /** Version of the connected browser extension, learned from its own authenticated requests. This is the only place that fact lives. It is null before an extension has ever spoken to this app process, which is why "no extension version" never means "outdated extension". */
  extensionVersion: string | null;
  /** Presence and installed version for a separately installed companion extension. */
  externalExtension?: {
    present: boolean; version: string | null; lastSeenAt: number | null;
    proof?: { version: string } | null;
  } | null;
  /** The NEURAFLOK browser's own copy of the extension, connected right now. */
  integratedExtension?: { present: boolean };
  /** Live, page-verified web model sessions. A provider is selectable only while open and signed in. */
  webProviders?: import('./web-providers.js').WebProviderPresenceMap;
}

/** Read-only companion diagnostics mirrored from the browser extension's own popup. This is deliberately diagnostics-only: ids, counters and transport state. It never carries transcript prose, page text, credentials or file contents. The extension popup reads the same underlying status/page projections; the desktop popover merely gives that otherwise-hidden UI a native home inside the app. */
export interface CompanionDiagnostics {
  capturedAt: number;
  status: {
    connected: boolean;
    port: number | null;
    paired: boolean;
    disconnected: boolean;
    pending: number;
    pendingCommandAcks: number;
    compatible: boolean | null;
    appVersion: string | null;
    appProtocol: number | null;
    extensionVersion: string | null;
    extensionProtocol: number | null;
    pairError: { error: string; message: string } | null;
  };
  preferences: {
    overwrite: boolean;
    durations: boolean;
  };
  tab: CompanionTabDiagnostics | null;
}

export interface CompanionTraceEntry {
  requestId: string;
  read: boolean;
  sent: boolean;
  confirmed: boolean;
  app: string | null;
  tool: string | null;
}

export interface CompanionPageDiagnostics {
  recorderVersion: number | null;
  runId: string | null;
  conversationId: string | null;
  generating: boolean;
  turnId: string | null;
  generations: number;
  queued: number;
  queueBytes: number;
  requestId: string | null;
  trace: CompanionTraceEntry[];
  overwrite: boolean;
  painted: boolean;
  events: number;
  calls: number;
  sends: number;
  failures: number;
  session: string | null;
  lastError: { at: number; text: string } | null;
  blocked: string | null;
}

export interface CompanionTabDiagnostics {
  tab: number | null;
  isChat: boolean;
  conversationId: string | null;
  bound: boolean;
  epoch: number | null;
  terminal: boolean;
  recorder: boolean;
  page: CompanionPageDiagnostics | null;
  chatTabs: number;
  pending: number;
  pendingAll: number;
  pendingCloses: number;
  pendingCommandAcks: number;
  delivery: {
    at: number;
    ok: boolean | null;
    events: number;
    total: number;
    status: number;
    error: string | null;
  };
}

/** Whether a newer release of this app exists, and what has been done about it. One record for the whole update subsystem — see backend/update.ts. `latest` is a version only when it is genuinely newer than `current`, so nothing downstream compares versions. `stage` says what this installation is doing about it, and the pair reads as: - `latest === null` — up to date, or nothing checked yet. - `latest` set, `stage: 'idle'` — a new version exists that this installation cannot apply for itself (a Linux `.deb`, macOS, a development tree, an unsupported architecture). It is a manual download. - `downloading` / `ready` — it is being fetched, or is fetched and installs on the next start. - `failed` — the check or the download stopped; `error` says why, and the next check tries again. Nothing about the running app is affected either way. `checkedAt` is what separates the two silences: null means GitHub has not answered yet in this run, and only a timestamp lets the UI say "up to date" rather than "nothing to report". */
export interface UpdateStatus {
  current: string;
  latest: string | null;
  stage: 'unconfigured' | 'idle' | 'checking' | 'downloading' | 'ready' | 'failed';
  error: string | null;
  /** When the release API last answered, as epoch ms. Null until it has. */
  checkedAt: number | null;
}

/** Where an installation that cannot update itself gets the new version by hand. */
/** Set when NEURAFLOK has a public release repository. No upstream project is used as a fallback. */
export const RELEASES_PAGE: string | null = null;

/** Whether `candidate` is a later release than `current`, compared as three numbers. String inequality is not enough: a downgrade published by mistake, or a pre-release tag left as `latest`, would otherwise make this app install an older build over a newer one. It lives here because the renderer asks the same question of the connected extension's version, and two copies of a comparison are two chances to read a version difference the wrong way round. */
export function isNewer(candidate: string, current: string): boolean {
  const left = candidate.split('.').map(Number);
  const right = current.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

export type MacOSPermissionState = 'granted' | 'missing' | 'unknown';
export interface MacOSDesktopAccessStatus {
  /** Live preflights from the Swift backend executing inside the Electron process. */
  screen: MacOSPermissionState;
  accessibility: MacOSPermissionState;
  checkedAt: number;
  error: string | null;
}

/** Whether the enabled product surface currently needs the companion browser extension. Recording is always on and consumes browser observations, so the extension bridge is an unconditional product dependency. Keep the parameter for source compatibility with callers that already pass their config snapshot. */
export function browserExtensionRequired(_config: Pick<Config, 'sessions' | 'multiAgent'> & Partial<Pick<Config, 'capabilities'>>): boolean {
  return true;
}

export interface AppState {
  config: Config;
  platform: PlatformInfo;
  /** Only packaged Windows builds may change the login item. */
  loginStartupAvailable?: boolean;
  secureStorage: SecureStorageInfo;
  /** True when an OpenRouter key is stored, which is what the goal loop spends on that provider. Same rule: the key stays here. */
  hasGoalKey: boolean;
  /** True when a credential for direct OpenAI model requests is stored. */
  hasOpenAiModelKey?: boolean;
  /** True when a custom-provider key is stored. Only meaningful beside a custom endpoint, which may also run keyless. */
  hasCustomProviderKey: boolean;
  bridge: BridgeStatus;
  update: UpdateStatus;
  /** Present only on macOS once the in-process native backend has reported its live TCC state. */
  desktopAccess?: MacOSDesktopAccessStatus | null;
  /** This run's settings file could not be read, so the app started read-only; cleared once read-only is off. */
  settingsRecovered?: boolean;
}


