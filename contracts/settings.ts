import type { ReasoningEffort } from './session.js';
import type { BrowserPreferences } from './browser/preferences.js';
import type { CommandAllowlistSettings } from './command-allowlist/types.js';
export type { CommandAllowlistSettings } from './command-allowlist/types.js';
import type { Capabilities } from './capabilities/catalog.js';
/** Host family reported to the renderer. */
export type PlatformFamily = 'windows' | 'macos' | 'linux' | 'other';

export interface PlatformInfo {
  family: PlatformFamily;
  /** Friendly operating-system name for setup/help copy. */
  name: string;
  /** Whether the model-facing Desktop connector can be used on this host. */
  desktopAutomation: boolean;
}

/** Whether this host can protect the credentials/tokens the app persists. */
export interface SecureStorageInfo {
  available: boolean;
  /** Actionable explanation when unavailable; null when the backend is safe to use. */
  detail: string | null;
}

export interface Root {
  /** Virtual name exposed to the model, e.g. "project" for /project. */
  name: string;
  /** Absolute host path. Never sent to the model. */
  path: string;
}

/** `integrated` is the app-owned browser and needs no installed browser. */
export const CHAT_BROWSERS = ['chrome', 'edge', 'brave', 'integrated'] as const;
export type ChatBrowser = (typeof CHAT_BROWSERS)[number];

export interface UiPrefs {
  /** Recover an unfinished silent executor turn only while Goal and Loop are both off. */
  autoContinue?: boolean;
  /** `web` uses the app-owned provider session; `api` uses the configured OpenAI-compatible endpoint. */
  chatExecutor?: import('./chat-protocol.js').ChatExecutor;
  /** Selected browser-chat provider. This is executable only when its extension page is signed in. */
  webProvider?: import('./web-providers.js').WebProviderId;
  /** Maintenance may reuse existing tabs but cannot open helpers or missing chats. */
  browserOnly?: boolean;
  backgroundChats?: boolean;
  browserBridgePort?: import('./browser/bridge.js').BrowserBridgePort;
  /** Opt-in deterministic metadata routing for managed Skills on ordinary user input. */
  autoSelectSkills?: boolean;
  /** Actual app-owned tabs to retain; active work and drafts stay protected. Omitted uses workers + 2. */
  tabsToKeepOpen?: number;
  finishTool?: boolean;
  planBackend?: 'web' | 'api';
  finishAction?: 'notify' | 'goal';
  finishLeadMinutes?: number;
  developerMode?: boolean;
  /** Keep the chat at its end while it grows in the app and provider page, until the reader scrolls up. On unless false. */
  followOutput?: boolean;
  /** Add the NEURAFLOK Core mention to the user's own prompts sent from the app. On unless false. */
  mentionCore?: boolean;
  /** The interface language the window last reported; the browser extension follows it. */
  language?: import('./ui-language.js').UiLanguage;
  /** The version this install last started as; What's New shows once per real update. */
  lastSeenVersion?: string;
  /** The extension's own preferences as it last reported them stored. The app keeps them so a reinstalled extension, which starts with empty storage under a new id, gets them back. */
  browserPreferences?: BrowserPreferences;
  /** Set once the notice that the NEURAFLOK browser hid to the tray, still running, was shown. */
  integratedBrowserTrayHint?: boolean;
  minimizeToTray: boolean;
  startAtLogin?: boolean;
  /** Default screenshots to the active window instead of the whole primary monitor. */
  privacyScreenshots: boolean;
  /** Browser for app-originated launches; connected source tabs retain placement ownership. */
  chatBrowser?: ChatBrowser;
  /** Explicit choice, never inherited from the OS: the window looks how you left it. */
  theme: 'light' | 'dark';
  appearance?: import('./appearance-settings.js').AppearanceSettings;
}

/** Session recording is a product invariant. Legacy/wire fields remain so old configs and clients parse, but the main config boundary always publishes `record: true` and `retainDays: 0` (no age expiry). Large image bytes retain their separate bounded quota. */
export interface SessionSettings {
  record: boolean;
  /** Compatibility projection. Canonical value is 0: recordings do not expire by age. */
  retainDays: number;
  /** Estimated tokens at which the app starts suggesting a compaction. */
  advisoryTokens: number;
  /** Estimated tokens at which that suggestion becomes urgent. */
  limitTokens: number;
}

/** Automatic Compact & Resume. The whole of it: whether it fires, and at what size. There is no provider to choose and no model to configure, because there is one way a session is compacted — the chat writes its own brief and the app moves the session to a fresh chat carrying it. */
export interface CompactionSettings {
  /** Compact without being asked, once a conversation grows past `autoTokens`. On, at the ceiling. Compaction ends the chat someone is working in and opens a fresh one; that is the right trade when the alternative is hitting the ceiling mid-thought. */
  auto: boolean;
  /** Estimated recorded tokens at which automatic compaction fires. */
  autoTokens: number;
  /** Editable content instructions for the brief; protocol/recovery framing stays code-owned. */
  handoffPrompt: string;
  /** How long the brief should be; absent means 'thorough', the shipped 10k–30k rules. */
  handoffLength?: 'thorough' | 'standard' | 'short';
}

/** The reasoning budget asked of the goal model, in OpenRouter's own vocabulary. `default` omits effort selection; reasoning text is still excluded from driver output. OpenRouter's model catalogue determines which explicit efforts the UI offers. */
export const GOAL_REASONING_LEVELS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type GoalReasoning = (typeof GOAL_REASONING_LEVELS)[number];

/** The goal loop uses a second model to continue a chat on the user's behalf. When the active assistant finishes a turn, the recorded conversation — every user message and final assistant answer — is sent to the configured provider with an editable continuation-gate instruction. A completion claim produces `NO_REPLY`; only a concrete requested item left unfinished becomes a user message. The feature is off by default and requires a provider key, except for a custom local endpoint. */
/** Which of the two standing modes the switch runs. One field rather than two booleans, because Goal and Loop are mutually exclusive by construction here: there is nothing to keep in step and no state where both are on. `enabled` stays the master switch it has always been, so everything that only wants to know whether a second model may type into a chat keeps reading exactly that. */
export const GOAL_MODES = ['goal', 'loop'] as const;
export type GoalMode = (typeof GOAL_MODES)[number];

export type GoalBackend = 'api' | 'web' | 'templates';
// API endpoint settings are shared by chat execution and automation helpers.
export const API_PROVIDERS = ['openrouter', 'openai', 'custom'] as const;
export type ApiProviderKind = (typeof API_PROVIDERS)[number];
export const API_PROTOCOLS = ['openai-compatible', 'anthropic-messages'] as const;
export type ApiProtocol = (typeof API_PROTOCOLS)[number];

export interface ApiProviderSettings {
  kind: ApiProviderKind;
  baseUrl: string;
  /** Wire protocol used by a custom provider. */
  protocol?: ApiProtocol;
  /** Optional label for a user-configured OpenAI-compatible service. */
  name?: string;
  /** Relative path under baseUrl. Defaults to chat/completions. */
  chatPath?: string;
  /** Relative path under baseUrl. Empty disables model discovery. */
  modelsPath?: string;
  /** Custom authentication header name; defaults to Authorization. */
  authHeader?: string;
  /** Text placed before the API key; defaults to Bearer. Empty sends the key as-is. */
  authPrefix?: string;
}

export function isApiProviderSettings(value: unknown): value is ApiProviderSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const provider = value as Record<string, unknown>;
  if (!(API_PROVIDERS as readonly unknown[]).includes(provider.kind) ||
      typeof provider.baseUrl !== 'string' || provider.baseUrl.length > 2048) return false;
  if (provider.protocol !== undefined && !(API_PROTOCOLS as readonly unknown[]).includes(provider.protocol)) return false;
  if (provider.name !== undefined && (typeof provider.name !== 'string' || provider.name.length > 80)) return false;
  for (const field of ['chatPath', 'modelsPath'] as const) {
    if (provider[field] !== undefined && (typeof provider[field] !== 'string' || provider[field].length > 500)) return false;
  }
  if (provider.authHeader !== undefined && (typeof provider.authHeader !== 'string' || provider.authHeader.length > 128)) return false;
  if (provider.authPrefix !== undefined && (typeof provider.authPrefix !== 'string' || provider.authPrefix.length > 64 || /[\r\n\u0000]/.test(provider.authPrefix))) return false;
  return true;
}

export interface ProvidersSettings {
  api: ApiProviderSettings;
}

export interface GoalSettings {
  /** Optional active-turn Goal impulses; zero disables them. */
  impulseMinutes?: number;
  /** Include tool details in handoff briefs only; Goal/Loop always use authored conversation text. */
  includeToolCalls?: boolean;
  backend?: GoalBackend;
  loopBackend?: 'api' | 'web';
  enabled: boolean;
  /** `goal` stops when the job is done; `loop` never stops on its own. Only consulted while `enabled` is true. A chat driven solely by its own saved objective with the switch off runs as `goal`, because Loop is a thing the user switches on. */
  mode: GoalMode;
  /** A model id from the active provider's model list. */
  model: string;
  reasoning: GoalReasoning;
  /** Editable continuation-gate instruction sent as the OpenRouter system message. */
  prompt: string;
  /** Editable driver instruction used instead of `prompt` once a chat carries its own goal. Two prompts rather than one switch, because the two jobs disagree about where the finish line comes from: the gate infers it from the conversation, the driver is handed it. Both are editable for the same reason the gate always was — the shipped wording is a starting point, and the person whose chat gets typed into is the one who should own it. */
  objectivePrompt: string;
  /** Editable loop instruction, used instead of both of the above while the mode is `loop`. A third prompt rather than a flag on the other two, because the job is a different one: the gate and the driver decide whether to speak, and this one only ever decides what to say. It is combined with a chat's own goal when it has one, exactly as the driver is. */
  loopPrompt: string;
}

/** Controls concurrent workers whose provider pages can use local tools. */
export interface MultiAgentSettings {
  defaultModel?: string;
  defaultReasoning?: ReasoningEffort | '';
  enabled: boolean;
  /** Upper bound on simultaneous slot-holding workers in one prime family. */
  maxWorkers: number;
  /** Optional admission cap shared by every prime family. Zero means no global cap, preserving the historical per-family-only behavior. This limits worker admission only; it does not queue ordinary prompts, switch Goal work, or evict workers that are already running. */
  globalMaxWorkers?: number;
  /** Permit self-contained calls when browser evidence cannot identify their conversation. */
  allowUnattributedCalls: boolean;
  /** Default-deny local tools to exact trusted conversations. */
  strictChatAllowlist?: boolean;
  /** Reopen/reload chats that are not Goal/Loop driven — workers, primes, plain chats that have called tools — once when their tab disappears or goes silent. Goal/Loop chats are always recovered, whatever this says. */
  recoverAgentTabs: boolean;
  /** Hold a Goal/Loop chat's next automatic step until the workers it delegated to have stopped. Their reports land in the same chat, so deciding or sending before that reads a context that is about to change. Off by default; a chat with no workers is never held. */
  waitForSubAgents?: boolean;
  /** Reclaim only terminal processes owned by an exactly identified worker that has remained sleeping beyond the runtime-retention threshold. Off by default; durable worker/chat identity and history are never reclaimed by this switch. */
  endSleepingWorkerProcesses?: boolean;
}

/** The user's own guidance for local tools sent with provider requests. */
export interface ProviderToolSettings {
  /** Appended to provider tool guidance, or empty for none. */
  instructions: string;
}

/** The opt-in local control API for an agent watching this app (`backend/control-api.ts`). */
export interface ControlApiSettings {
  /** Serve the loopback API and write its token to userData. Off unless the user turns it on. */
  enabled: boolean;
  /** Also let a caller with the token send and cancel messages through the outbox. Off unless the user turns it on, and never on while `enabled` is off: turning the API off revokes it. */
  allowActions: boolean;
}

export interface Config {
  roots: Root[];
  capabilities: Capabilities;
  providers: ProvidersSettings;
  readOnly: boolean;
  ui: UiPrefs;
  sessions: SessionSettings;
  compaction: CompactionSettings;
  multiAgent: MultiAgentSettings;
  commandAllowlist: CommandAllowlistSettings;
  goal: GoalSettings;
  providerTools: ProviderToolSettings;
  controlApi: ControlApiSettings;
}


