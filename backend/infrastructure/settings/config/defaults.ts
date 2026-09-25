import { CAPABILITIES, DEFAULT_CAPABILITIES, DESKTOP_CAPABILITIES } from '../../../../contracts/types.js';
import type { ApiProviderSettings, Capabilities, CompactionSettings, Config, GoalSettings, MultiAgentSettings, SessionSettings } from '../../../../contracts/types.js';
import { DEFAULT_GOAL_MODEL } from '../../../../contracts/automation/goal-settings.js';
import { DEFAULT_GOAL_LOOP_SYSTEM_PROMPT, DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT, DEFAULT_GOAL_SYSTEM_PROMPT } from '../../../../contracts/automation/goal-prompts.js';
import { DEFAULT_HANDOFF_LENGTH, DEFAULT_HANDOFF_PROMPT } from '../../../../contracts/sessions/continuity-brief.js';
import { capabilitiesForPlatform } from '../platform.js';
export { DEFAULT_GOAL_MODEL };

/** Defaults for the newer sections, in one place so the schema and defaultConfig() cannot drift apart. Recording is always ON and retained without an age limit. Everything the app is actually for — the readable timeline, Compact & resume, and agent attribution — reads that durable history. It writes only to this app's own data folder and uploads nothing. The separate bounded image store keeps its own quota and explicit cleanup controls. Existing configs still keep every explicit permission choice. Fresh installs are different: the Home screen is meant to start fully usable, so every tool permission and the agents surface begin enabled. The migration defaults below remain conservative so an upgrade never widens an older config merely because a field did not exist when that config was written. */
/** The pressure meter estimates usage from retained events, while the provider's context limit also includes hidden instructions, memory, attachments, and reasoning. Defaults reflect observed sessions and remain configurable per provider. */
const DEFAULT_CONTEXT_WINDOW = 400_000;
export const DEFAULT_SESSIONS: SessionSettings = {
  record: true,
  retainDays: 0,
  advisoryTokens: DEFAULT_CONTEXT_WINDOW,
  // Derived, never typed. The Chat panel writes `limit = threshold × 4/3` on every save, so a default that did not already satisfy that relation would be a state the UI cannot produce: the red line would move the first time anyone opened the panel and saved.
  limitTokens: Math.round((DEFAULT_CONTEXT_WINDOW * 4) / 3)
};

export const DEFAULT_COMPACTION: CompactionSettings = {
  // On, at the advisory line. Automatic compaction is edge-triggered since 1.8: an old chat that merely opens above this number does nothing. That is what makes the advisory line usable as the trigger — the crossing turn still finishes and still writes its handoff, rather than the app waiting for a chat that is already over the line and compacting it on sight.
  auto: true,
  autoTokens: DEFAULT_SESSIONS.advisoryTokens,
  handoffPrompt: DEFAULT_HANDOFF_PROMPT,
  handoffLength: DEFAULT_HANDOFF_LENGTH
};
/** Goal and Loop default to the selected browser provider; API endpoint and model settings apply only when API is selected. */
/** The shipped Goal baseline. Keep the exact OpenRouter model id here rather than a provider fallback or a local alias: changing providers after one failed request would also change the protocol behaviour the Goal loop is validating. Existing user-selected models remain stored verbatim; this value is only the fresh/repair default. */
export const DEFAULT_GOAL: GoalSettings = {
  backend: 'web',
  loopBackend: 'web',
  impulseMinutes: 0,
  includeToolCalls: false,
  enabled: false,
  // The mode a fresh install runs the moment somebody flips the switch. Goal, because it is the one that can end by itself: a loop that never stops is a deliberate choice, not a default anybody should discover by turning something on.
  mode: 'goal',
  model: DEFAULT_GOAL_MODEL,
  reasoning: 'default',
  prompt: DEFAULT_GOAL_SYSTEM_PROMPT,
  objectivePrompt: DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT,
  loopPrompt: DEFAULT_GOAL_LOOP_SYSTEM_PROMPT
};
export const DEFAULT_API_PROVIDER: ApiProviderSettings = { kind: 'openrouter', baseUrl: '' };
// Two workers avoid provider rate limits that can strand a multi-agent run.
export const DEFAULT_MULTI_AGENT: MultiAgentSettings = {
  enabled: false,
  maxWorkers: 2,
  // Preserve the historical behavior unless the user explicitly opts into a cap shared by independent prime families. Existing per-family maxWorkers remains authoritative too.
  globalMaxWorkers: 0,
  allowUnattributedCalls: false,
  strictChatAllowlist: false,
  // Off: Goal/Loop chats are always recovered, and reopening anything else — a worker, a prime, a plain chat that once called a tool — is the user's choice to make.
  recoverAgentTabs: false,
  // Off: waiting for a run's own workers before its next automatic step is a deliberate choice. A chat that delegated nothing, and a chat with no run, never wait either way.
  waitForSubAgents: false,
  // Off: ending an OS process is a real side effect even though the worker identity survives. The user must opt in before sleeping-worker runtime maintenance can terminate anything.
  endSleepingWorkerProcesses: false
};
/** Fresh-install exposure. Kept separate from migration defaults on purpose. */
const ALL_FIRST_LAUNCH_CAPABILITIES: Capabilities = Object.fromEntries(
  CAPABILITIES.map((capability) => [capability, true])
) as Capabilities;
// Unattributed calls start permitted on a fresh install for the same reason recording does: the ambiguity fences refuse work when the extension cannot *prove* the caller, and a new install is exactly where that evidence path is least likely to be healthy yet. Off, the first thing a user sees is CALLER_IDENTITY_REQUIRED; on, the work runs and its activity is still labelled Unattributed rather than guessed onto a chat. This relaxes only the fences — a positively known dormant/retired/ended worker is refused either way. `DEFAULT_MULTI_AGENT` keeps `false` so an upgrade never relaxes an older config merely because the field was absent when that config was written.
const FIRST_LAUNCH_MULTI_AGENT: MultiAgentSettings = {
  ...DEFAULT_MULTI_AGENT,
  enabled: true,
  allowUnattributedCalls: true
};

export const DEFAULT_PROVIDER_TOOLS = { instructions: '' } as const;
/** Off for fresh installs and for every config written before the switches existed. */
export const DEFAULT_CONTROL_API = { enabled: false, allowActions: false } as const;
export const DEFAULT_COMMAND_ALLOWLIST = { enabled: false, mode: 'allow', rules: [] } as const;
/** Fresh-install Desktop exposure differs by host. Windows starts the Desktop group on. macOS has a native backend too, but it starts **off** and is switched on by the user: every Desktop action there also needs Screen Recording / Accessibility consent from System Settings, and a fresh install must not publish a second connector nobody can use yet. Unsupported hosts mask the group at the platform boundary while preserving stored choices for a moved config. */
function firstLaunchCapabilities(platform: NodeJS.Platform, release?: string): Capabilities {
  const capabilities = capabilitiesForPlatform({ ...ALL_FIRST_LAUNCH_CAPABILITIES }, platform, release);
  if (platform === 'darwin') for (const capability of DESKTOP_CAPABILITIES) capabilities[capability] = false;
  return capabilities;
}

export function defaultConfig(platform: NodeJS.Platform = process.platform, release?: string): Config {
  return {
    roots: [],
    capabilities: firstLaunchCapabilities(platform, release),
    readOnly: false,
    providers: { api: { ...DEFAULT_API_PROVIDER } },
    commandAllowlist: { ...DEFAULT_COMMAND_ALLOWLIST, rules: [] },
    ui: { minimizeToTray: true, startAtLogin: false, privacyScreenshots: false, theme: 'dark', autoSelectSkills: false, backgroundChats: true, browserBridgePort: 'auto', autoContinue: true, followOutput: true, mentionCore: true,
      // The provider browser is loaded on demand, then kept available for hidden signed-in tabs.
      chatBrowser: 'integrated',
      chatExecutor: 'web', webProvider: 'deepseek' },
    sessions: { ...DEFAULT_SESSIONS },
    compaction: { ...DEFAULT_COMPACTION },
    multiAgent: { ...FIRST_LAUNCH_MULTI_AGENT },
    goal: { ...DEFAULT_GOAL },
    providerTools: { ...DEFAULT_PROVIDER_TOOLS },
    controlApi: { ...DEFAULT_CONTROL_API }
  };
}

/** Recovery for a config file that exists but cannot be trusted. A missing file is a real first launch and intentionally gets the fully-enabled defaults above. A malformed/corrupt existing file is different: treating damage as consent would widen filesystem/desktop/process access merely because parsing failed. Keep that path on the historical narrow capability set and read-only mode until the user saves settings again. */
export function conservativeRecoveryConfig(): Config {
  return {
    ...defaultConfig(),
    capabilities: { ...DEFAULT_CAPABILITIES },
    readOnly: true,
    multiAgent: { ...DEFAULT_MULTI_AGENT },
    // Keep the provider browser profile stable even when another preference is damaged.
    ui: { ...defaultConfig().ui, autoContinue: false, chatBrowser: 'integrated' },
    // A config file that could not be trusted is not consent to have a second model typing into the user's chat, whatever the unreadable file said.
    goal: { ...DEFAULT_GOAL }
  };
}

