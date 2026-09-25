import { z } from 'zod';
import { browserPreferencesSchema } from '../../../contracts/browser/preferences.js';
import { API_PROVIDERS, CAPABILITIES, CHAT_BROWSERS, GOAL_MODES, GOAL_REASONING_LEVELS, type Config } from '../../../contracts/types.js';
import { CHAT_EXECUTORS } from '../../../contracts/chat-protocol.js';
import { WEB_PROVIDER_IDS } from '../../../contracts/web-providers.js';
import { MAX_GOAL_SYSTEM_PROMPT_CHARS } from '../../../contracts/automation/goal-settings.js';
import { DEFAULT_HANDOFF_LENGTH, HANDOFF_LENGTHS, MAX_HANDOFF_PROMPT_CHARS } from '../../../contracts/sessions/continuity-brief.js';
import { MAX_COMMAND_ALLOWLIST_RULES, MAX_COMMAND_ALLOWLIST_RULE_CHARS } from '../../../contracts/command-allowlist/types.js';
import { validateCommandAllowlistRule } from '../../../contracts/command-allowlist/rules.js';
import { REASONING_EFFORTS } from '../../../contracts/session.js';
import { MAX_PROVIDER_TOOL_INSTRUCTIONS_CHARS } from '../../infrastructure/settings/config.js';
import { browserBridgePortSchema } from '../../../contracts/browser/bridge.js';
import { UI_LANGUAGES } from '../../../contracts/ui-language.js';
import { appearanceSettingsSchema } from '../../../contracts/appearance-validation.js';
import { mergeAppearance } from '../../../contracts/appearance-settings.js';
const capabilityPatch = z.object(
  Object.fromEntries(CAPABILITIES.map((c) => [c, z.boolean()])) as Record<
    (typeof CAPABILITIES)[number],
    z.ZodBoolean
  >
);

const settingsPatch = z.object({
  capabilities: capabilityPatch,
  readOnly: z.boolean(),
  commandAllowlist: z.object({
    enabled: z.boolean(),
    mode: z.enum(['allow', 'deny']).optional().default('allow'),
    rules: z.array(z.string().max(MAX_COMMAND_ALLOWLIST_RULE_CHARS).superRefine((rule, ctx) => {
      const message = validateCommandAllowlistRule(rule);
      if (message) ctx.addIssue({ code: 'custom', message });
    })).max(MAX_COMMAND_ALLOWLIST_RULES)
  }),
  ui: z.object({
    appearance: appearanceSettingsSchema.optional(),
    autoContinue: z.boolean().optional(),
    chatExecutor: z.enum(CHAT_EXECUTORS).optional(),
    webProvider: z.enum(WEB_PROVIDER_IDS).optional(),
    chatBrowser: z.enum(CHAT_BROWSERS).optional(),
    developerMode: z.boolean().optional(),
    followOutput: z.boolean().optional(),
    mentionCore: z.boolean().optional(),
    language: z.enum(UI_LANGUAGES).optional(),
    browserPreferences: browserPreferencesSchema.optional(),
    integratedBrowserTrayHint: z.boolean().optional(),
    finishTool: z.boolean().optional(),
    planBackend: z.enum(['web', 'api']).optional(),
    finishAction: z.enum(['notify', 'goal']).optional(),
    finishLeadMinutes: z.number().int().min(3).max(5).optional(),
    backgroundChats: z.boolean().optional(),
    browserBridgePort: browserBridgePortSchema.optional(),
    browserOnly: z.boolean().optional(),
    autoSelectSkills: z.boolean().optional(),
    tabsToKeepOpen: z.number().int().min(1).max(50).optional(),
    minimizeToTray: z.boolean(),
    startAtLogin: z.boolean().optional(),
    privacyScreenshots: z.boolean(),
    theme: z.enum(['light', 'dark'])
  }),
  sessions: z.object({
    record: z.boolean(),
    retainDays: z.number().int().min(0).max(3650),
    advisoryTokens: z.number().int().min(10_000).max(4_000_000),
    limitTokens: z.number().int().min(10_000).max(4_000_000)
  }),
  compaction: z.object({
    auto: z.boolean(),
    // Floored well above what a fresh chat holds, so a threshold cannot be set somewhere every conversation is already past the moment it opens.
    autoTokens: z.number().int().min(10_000).max(4_000_000),
    handoffPrompt: z.string().trim().min(1).max(MAX_HANDOFF_PROMPT_CHARS),
    handoffLength: z.enum(HANDOFF_LENGTHS).optional()
  }),
  multiAgent: z.object({
    enabled: z.boolean(),
    defaultModel: z.string().max(80).optional(),
    defaultReasoning: z.enum(['', ...REASONING_EFFORTS]).optional(),
    maxWorkers: z.number().int().min(1).max(8),
    globalMaxWorkers: z.number().int().min(0).max(64).optional(),
    allowUnattributedCalls: z.boolean(),
    strictChatAllowlist: z.boolean().optional(),
    recoverAgentTabs: z.boolean(),
    waitForSubAgents: z.boolean().optional(),
    endSleepingWorkerProcesses: z.boolean().optional()
  }),
  providerTools: z.object({ instructions: z.string().trim().max(MAX_PROVIDER_TOOL_INSTRUCTIONS_CHARS) }).strict().optional(),
  controlApi: z.object({ enabled: z.boolean(), allowActions: z.boolean().optional() }).strict().optional(),
  providers: z.object({
    api: z.object({ kind: z.enum(API_PROVIDERS), baseUrl: z.string().max(2048) }).strict()
  }).strict(),
  goal: z.object({
    impulseMinutes: z.number().int().min(0).max(60).optional(),
    includeToolCalls: z.boolean().optional(),
      backend: z.enum(['api', 'web', 'templates']).optional(),
      loopBackend: z.enum(['api', 'web']).optional(),
    enabled: z.boolean(),
    // Which of the two standing modes the switch runs. One field, so the renderer has no way to describe a state where Goal and Loop are both on.
    mode: z.enum(GOAL_MODES),
    // An OpenRouter model id while the provider is openrouter, validated only as a shape: the catalogue changes weekly, and an allow-list here would mean this app deciding which models exist. The leading `~` is OpenRouter's own marker for an alias that always resolves to the newest model in a family — `~deepseek/deepseek-v4-flash-latest` and eleven others. The picker lists them because the listing does, so refusing them here meant the one kind of entry most worth choosing was the one kind that could not be saved. A custom endpoint names its own models (`llama3.1`, a deployment id), so while custom it is any non-empty id instead.
    model: z.string().min(1).max(160),
    reasoning: z.enum(GOAL_REASONING_LEVELS),
    prompt: z.string().trim().min(1).max(MAX_GOAL_SYSTEM_PROMPT_CHARS),
    objectivePrompt: z.string().trim().min(1).max(MAX_GOAL_SYSTEM_PROMPT_CHARS),
    loopPrompt: z.string().trim().min(1).max(MAX_GOAL_SYSTEM_PROMPT_CHARS)
  })
}).superRefine((settings, ctx) => {
    if (settings.providers.api.kind === 'openrouter' && !/^~?[a-z0-9._-]+\/[a-z0-9._-]+(:[a-z0-9._-]+)?$/i.test(settings.goal.model)) {
      ctx.addIssue({
        code: 'custom',
        path: ['goal', 'model'],
        message: 'Expected an OpenRouter model id like vendor/model'
      });
    }
});

export const settingsSave = z.object({ base: settingsPatch, patch: settingsPatch }).strict();
type SettingsSnapshot = z.infer<typeof settingsPatch>;

/** Three-way merge for the renderer's settings form. The Chrome extension is a second writer for Goal/Auto Compact. The renderer previously sent a blind full snapshot for every checkbox/theme edit, so a snapshot captured just before an extension write could land just after it and silently undo that newer value. A field which is unchanged between `base` and `wanted` was not edited by this renderer save and therefore keeps the current main-process value. A field that differs was deliberately edited here and wins. */
export function mergeSettings(current: Config, base: SettingsSnapshot, wanted: SettingsSnapshot): Omit<SettingsSnapshot, 'controlApi'> & { controlApi: Config['controlApi'] } {
  const pick = <T>(live: T, before: T, next: T): T => (Object.is(before, next) ? live : next);
  const pickRules = (live: string[], before: string[], next: string[]): string[] =>
    before.length === next.length && before.every((rule, index) => rule === next[index]) ? live : next;
  const capabilities = Object.fromEntries(
    CAPABILITIES.map((capability) => [
      capability,
      pick(current.capabilities[capability], base.capabilities[capability], wanted.capabilities[capability])
    ])
  ) as Config['capabilities'];
  // The two switches merge independently, and actions never outlive the API. A form that omits `allowActions` leaves it as it is.
  let controlApi = current.controlApi;
  if (wanted.controlApi) {
    const enabled = pick(current.controlApi.enabled, base.controlApi?.enabled ?? false, wanted.controlApi.enabled);
    const allowActions = wanted.controlApi.allowActions === undefined
      ? current.controlApi.allowActions
      : pick(current.controlApi.allowActions, base.controlApi?.allowActions ?? false, wanted.controlApi.allowActions);
    controlApi = { enabled, allowActions: enabled && allowActions === true };
  }
  return {
    providerTools: wanted.providerTools
      ? { instructions: pick(current.providerTools.instructions, base.providerTools?.instructions ?? '', wanted.providerTools.instructions) }
      : current.providerTools,
    controlApi,
    capabilities,
    readOnly: pick(current.readOnly, base.readOnly, wanted.readOnly),
    commandAllowlist: {
      enabled: pick(current.commandAllowlist.enabled, base.commandAllowlist.enabled, wanted.commandAllowlist.enabled),
      mode: pick(current.commandAllowlist.mode, base.commandAllowlist.mode, wanted.commandAllowlist.mode),
      rules: pickRules(current.commandAllowlist.rules, base.commandAllowlist.rules, wanted.commandAllowlist.rules)
    },
    ui: {
      appearance: mergeAppearance(current.ui.appearance, base.ui.appearance, wanted.ui.appearance),
      autoContinue: pick(current.ui.autoContinue, base.ui.autoContinue, wanted.ui.autoContinue),
      chatExecutor: pick(current.ui.chatExecutor, base.ui.chatExecutor, wanted.ui.chatExecutor),
      webProvider: pick(current.ui.webProvider, base.ui.webProvider, wanted.ui.webProvider),
      chatBrowser: pick(current.ui.chatBrowser, base.ui.chatBrowser, wanted.ui.chatBrowser),
      developerMode: pick(current.ui.developerMode, base.ui.developerMode, wanted.ui.developerMode),
      followOutput: pick(current.ui.followOutput, base.ui.followOutput, wanted.ui.followOutput),
      mentionCore: pick(current.ui.mentionCore, base.ui.mentionCore, wanted.ui.mentionCore),
      // Not part of the settings form: reported by the window and the extension, carried through.
      language: current.ui.language,
      browserPreferences: current.ui.browserPreferences,
      integratedBrowserTrayHint: current.ui.integratedBrowserTrayHint,
      finishTool: pick(current.ui.finishTool, base.ui.finishTool, wanted.ui.finishTool),
      planBackend: pick(current.ui.planBackend, base.ui.planBackend, wanted.ui.planBackend),
      finishAction: pick(current.ui.finishAction, base.ui.finishAction, wanted.ui.finishAction),
      finishLeadMinutes: pick(current.ui.finishLeadMinutes, base.ui.finishLeadMinutes, wanted.ui.finishLeadMinutes),
      backgroundChats: pick(current.ui.backgroundChats, base.ui.backgroundChats, wanted.ui.backgroundChats),
      browserBridgePort: wanted.ui.browserBridgePort === undefined ? current.ui.browserBridgePort
        : pick(current.ui.browserBridgePort ?? 'auto', base.ui.browserBridgePort ?? 'auto', wanted.ui.browserBridgePort),
      browserOnly: pick(current.ui.browserOnly, base.ui.browserOnly, wanted.ui.browserOnly),
      autoSelectSkills: pick(current.ui.autoSelectSkills, base.ui.autoSelectSkills, wanted.ui.autoSelectSkills),
      tabsToKeepOpen: pick(current.ui.tabsToKeepOpen, base.ui.tabsToKeepOpen, wanted.ui.tabsToKeepOpen),
      minimizeToTray: pick(current.ui.minimizeToTray, base.ui.minimizeToTray, wanted.ui.minimizeToTray),
      startAtLogin: pick(current.ui.startAtLogin, base.ui.startAtLogin, wanted.ui.startAtLogin),
      privacyScreenshots: pick(
        current.ui.privacyScreenshots,
        base.ui.privacyScreenshots,
        wanted.ui.privacyScreenshots
      ),
      theme: pick(current.ui.theme, base.ui.theme, wanted.ui.theme)
    },
    sessions: {
      record: pick(current.sessions.record, base.sessions.record, wanted.sessions.record),
      retainDays: pick(current.sessions.retainDays, base.sessions.retainDays, wanted.sessions.retainDays),
      advisoryTokens: pick(
        current.sessions.advisoryTokens,
        base.sessions.advisoryTokens,
        wanted.sessions.advisoryTokens
      ),
      limitTokens: pick(current.sessions.limitTokens, base.sessions.limitTokens, wanted.sessions.limitTokens)
    },
    compaction: {
      auto: pick(current.compaction.auto, base.compaction.auto, wanted.compaction.auto),
      autoTokens: pick(current.compaction.autoTokens, base.compaction.autoTokens, wanted.compaction.autoTokens),
      handoffPrompt: pick(
        current.compaction.handoffPrompt,
        base.compaction.handoffPrompt,
        wanted.compaction.handoffPrompt
      ),
      handoffLength: pick(
        current.compaction.handoffLength ?? DEFAULT_HANDOFF_LENGTH,
        base.compaction.handoffLength ?? DEFAULT_HANDOFF_LENGTH,
        wanted.compaction.handoffLength ?? DEFAULT_HANDOFF_LENGTH
      )
    },
    multiAgent: {
      defaultModel: pick(current.multiAgent.defaultModel, base.multiAgent.defaultModel, wanted.multiAgent.defaultModel),
      defaultReasoning: pick(current.multiAgent.defaultReasoning, base.multiAgent.defaultReasoning, wanted.multiAgent.defaultReasoning),
      enabled: pick(current.multiAgent.enabled, base.multiAgent.enabled, wanted.multiAgent.enabled),
      maxWorkers: pick(current.multiAgent.maxWorkers, base.multiAgent.maxWorkers, wanted.multiAgent.maxWorkers),
      globalMaxWorkers: pick(
        current.multiAgent.globalMaxWorkers ?? 0,
        base.multiAgent.globalMaxWorkers ?? 0,
        wanted.multiAgent.globalMaxWorkers ?? 0
      ),
      allowUnattributedCalls: pick(
        current.multiAgent.allowUnattributedCalls,
        base.multiAgent.allowUnattributedCalls,
        wanted.multiAgent.allowUnattributedCalls
      ),
      strictChatAllowlist: pick(
        current.multiAgent.strictChatAllowlist ?? false,
        base.multiAgent.strictChatAllowlist ?? false,
        wanted.multiAgent.strictChatAllowlist ?? false
      ),
      recoverAgentTabs: pick(
        current.multiAgent.recoverAgentTabs,
        base.multiAgent.recoverAgentTabs,
        wanted.multiAgent.recoverAgentTabs
      ),
      waitForSubAgents: pick(
        current.multiAgent.waitForSubAgents,
        base.multiAgent.waitForSubAgents,
        wanted.multiAgent.waitForSubAgents
      ),
      endSleepingWorkerProcesses: pick(
        current.multiAgent.endSleepingWorkerProcesses ?? false,
        base.multiAgent.endSleepingWorkerProcesses ?? false,
        wanted.multiAgent.endSleepingWorkerProcesses ?? false
      )
    },
    providers: {
      api: {
        kind: pick(current.providers.api.kind, base.providers.api.kind, wanted.providers.api.kind),
        baseUrl: pick(current.providers.api.baseUrl, base.providers.api.baseUrl, wanted.providers.api.baseUrl)
      }
    },
    goal: {
      impulseMinutes: pick(current.goal.impulseMinutes, base.goal.impulseMinutes, wanted.goal.impulseMinutes),
      includeToolCalls: pick(current.goal.includeToolCalls, base.goal.includeToolCalls, wanted.goal.includeToolCalls),
      backend: pick(current.goal.backend, base.goal.backend, wanted.goal.backend),
      loopBackend: pick(current.goal.loopBackend, base.goal.loopBackend, wanted.goal.loopBackend),
      enabled: pick(current.goal.enabled, base.goal.enabled, wanted.goal.enabled),
      mode: pick(current.goal.mode, base.goal.mode, wanted.goal.mode),
      model: pick(current.goal.model, base.goal.model, wanted.goal.model),
      reasoning: pick(current.goal.reasoning, base.goal.reasoning, wanted.goal.reasoning),
      prompt: pick(current.goal.prompt, base.goal.prompt, wanted.goal.prompt),
      objectivePrompt: pick(
        current.goal.objectivePrompt,
        base.goal.objectivePrompt,
        wanted.goal.objectivePrompt
      ),
      loopPrompt: pick(current.goal.loopPrompt, base.goal.loopPrompt, wanted.goal.loopPrompt)
    }
  };
}

