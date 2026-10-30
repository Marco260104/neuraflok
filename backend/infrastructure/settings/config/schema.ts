import { z } from 'zod';
import { UI_LANGUAGES } from '../../../../contracts/ui-language.js';
import { REASONING_EFFORTS } from '../../../../contracts/session.js';
import { appearanceSettingsSchema } from '../../../../contracts/appearance-validation.js';
import { browserBridgePortSchema } from '../../../../contracts/browser/bridge.js';
import { WEB_PROVIDER_IDS, selectableWebProviderOrDefault } from '../../../../contracts/web-providers.js';
import { CHAT_EXECUTORS } from '../../../../contracts/chat-protocol.js';
import { browserPreferencesSchema } from '../../../../contracts/browser/preferences.js';
import {
  API_PROVIDERS, API_PROTOCOLS, CAPABILITIES, CHAT_BROWSERS, DEFAULT_CAPABILITIES, GOAL_MODES, GOAL_REASONING_LEVELS,
  type Capabilities, type Root
} from '../../../../contracts/types.js';
import { MAX_GOAL_SYSTEM_PROMPT_CHARS } from '../../../../contracts/automation/goal-settings.js';
import { DEFAULT_HANDOFF_LENGTH, HANDOFF_LENGTHS, MAX_HANDOFF_PROMPT_CHARS } from '../../../../contracts/sessions/continuity-brief.js';
import {
  DEFAULT_API_PROVIDER, DEFAULT_COMMAND_ALLOWLIST, DEFAULT_COMPACTION, DEFAULT_CONTROL_API,
  DEFAULT_GOAL, DEFAULT_MULTI_AGENT, DEFAULT_PROVIDER_TOOLS, DEFAULT_SESSIONS
} from './defaults.js';
import { MAX_COMMAND_ALLOWLIST_RULES, MAX_COMMAND_ALLOWLIST_RULE_CHARS } from '../../../../contracts/command-allowlist/types.js';
import { validateCommandAllowlistRule } from '../../../../contracts/command-allowlist/rules.js';
import { RESERVED_ROOT_NAMES } from '../sandbox.js';

const rootSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Root names are lowercase letters, digits, dot, dash, underscore'),
  path: z.string().min(2).max(4096)
});

/** Repairs root names from older/hand-edited configs without ever publishing an ambiguous virtual namespace. Reserved names and duplicates are renamed deterministically in input order, preserving the first usable spelling and suffixing later collisions. */
function uniqueStoredRoots(roots: Root[]): Root[] {
  const used = new Set<string>();
  const nextFree = (wanted: string): string => {
    const reserved = RESERVED_ROOT_NAMES.has(wanted);
    const base = reserved ? `${wanted}-folder` : wanted;
    let candidate = base.slice(0, 32);
    for (let suffix = 2; RESERVED_ROOT_NAMES.has(candidate) || used.has(candidate); suffix++) {
      const tail = `-${suffix}`;
      candidate = `${base.slice(0, Math.max(1, 32 - tail.length))}${tail}`;
    }
    return candidate;
  };
  return roots.map((root) => {
    const name = nextFree(root.name);
    used.add(name);
    return name === root.name ? root : { ...root, name };
  });
}

/** Migrates configs written before the tools were consolidated. `powershell` and `command` used to be one tool each and are now the single `exec_command`, so a user who had granted only PowerShell keeps the ability they chose. `deleteFolder` is dropped rather than folded into `deleteFile`: they were never the same permission, and quietly turning one into the other would widen what the user approved. Both keys are removed afterwards so the file stops carrying dead permissions. */
function migrateCapabilities(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const caps = { ...(value as Record<string, unknown>) };
  if (caps['powershell'] === true) caps['command'] = true;
  delete caps['powershell'];
  delete caps['deleteFolder'];
  return caps;
}

// New optional capability keys receive conservative defaults while saved choices remain intact.
const capabilitiesSchema = z
  .preprocess(
    migrateCapabilities,
    z.object(
      Object.fromEntries(CAPABILITIES.map((c) => [c, z.boolean().optional()])) as Record<
        (typeof CAPABILITIES)[number],
        z.ZodOptional<z.ZodBoolean>
      >
    )
  )
  .transform((caps) => ({ ...DEFAULT_CAPABILITIES, ...caps }) as Capabilities);

/** The user's own MCP instructions. Empty by default, and deliberately so: the connector instructions are how the app explains its own tools, and inventing text on the user's behalf there would put words the app cannot honour in front of the model. */
export const MAX_PROVIDER_TOOL_INSTRUCTIONS_CHARS = 4000;
const commandAllowlistRuleSchema = z.string().max(MAX_COMMAND_ALLOWLIST_RULE_CHARS).superRefine((rule, ctx) => {
  const message = validateCommandAllowlistRule(rule);
  if (message) ctx.addIssue({ code: 'custom', message });
});

export const configSchema = z.object({
  // A config written by hand — or by a build before `/skills` was reserved — must not be able to claim a reserved virtual root. Renamed rather than rejected: a single bad root name is not a reason to throw away the whole config and every other approved folder.
  roots: z
    .array(rootSchema)
    .max(32)
    .transform(uniqueStoredRoots),
  capabilities: capabilitiesSchema,
  providers: z.object({
    api: z.object({
      kind: z.enum(API_PROVIDERS).optional().default(DEFAULT_API_PROVIDER.kind).catch(DEFAULT_API_PROVIDER.kind),
      baseUrl: z.string().max(2048).optional().default(DEFAULT_API_PROVIDER.baseUrl),
      protocol: z.enum(API_PROTOCOLS).optional(),
      name: z.string().max(80).optional(),
      chatPath: z.string().max(500).optional(),
      modelsPath: z.string().max(500).optional(),
      authHeader: z.string().max(128).optional(),
      authPrefix: z.string().max(64).optional()
    }).optional().default({ ...DEFAULT_API_PROVIDER })
  }).optional().default({ api: { ...DEFAULT_API_PROVIDER } }),
  readOnly: z.boolean(),
  commandAllowlist: z.object({
    enabled: z.boolean(),
    mode: z.enum(['allow', 'deny']).optional().default('allow'),
    rules: z.array(commandAllowlistRuleSchema).max(MAX_COMMAND_ALLOWLIST_RULES)
  }).optional().default({ ...DEFAULT_COMMAND_ALLOWLIST, rules: [] }),
  ui: z.object({
    appearance: appearanceSettingsSchema.optional().catch(undefined),
    autoContinue: z.boolean().optional().default(true),
    // Legacy executor values migrate to the configured API route.
    chatExecutor: z.preprocess(value => value === 'chatgpt' ? 'api' : value === 'deepseek' || value === undefined ? 'web' : value,
      z.enum(CHAT_EXECUTORS).default('web')).catch('web'),
    webProvider: z.enum(WEB_PROVIDER_IDS).optional().transform(selectableWebProviderOrDefault),
    chatBrowser: z.preprocess(value => value === 'chrome' || value === 'edge' || value === 'brave' ? 'integrated' : value,
      z.enum(CHAT_BROWSERS).optional().catch('integrated').default('integrated')),
    developerMode: z.boolean().optional(),
    /** Keep the chat at its end while it grows, in the app and on the selected provider page. */
    followOutput: z.boolean().optional().default(true),
    mentionCore: z.boolean().optional().default(true),
    language: z.enum(UI_LANGUAGES).optional(),
    // The version this install last started as; What's New shows once per real update.
    lastSeenVersion: z.string().trim().min(1).max(40).optional().catch(undefined),
    browserPreferences: browserPreferencesSchema.optional(),
    integratedBrowserTrayHint: z.boolean().optional(),
    finishTool: z.boolean().optional(),
    planBackend: z.enum(['web', 'api']).optional(),
    finishAction: z.enum(['notify', 'goal']).optional(),
    finishLeadMinutes: z.number().int().min(3).max(5).optional(),
    backgroundChats: z.boolean().optional().default(true),
    browserBridgePort: browserBridgePortSchema.optional().default('auto'),
    browserOnly: z.boolean().optional().default(false),
    autoSelectSkills: z.boolean().optional().default(false),
    tabsToKeepOpen: z.number().int().min(1).max(50).optional(),
    minimizeToTray: z.boolean(),
    startAtLogin: z.boolean().optional().default(false),
    privacyScreenshots: z.boolean().optional().default(false),
    // Dark is the design the app is drawn for, and a config written before the theme existed has no stored answer to override — so it is the default rather than the fallback. An explicit `light` is somebody's own choice and is never touched.
    theme: z.enum(['light', 'dark']).optional().default('dark')
  }),
  // Whole sections are optional, so a config written by an older build keeps working and simply gains the new features switched off. The default object is spelled out rather than left as {} because zod 4 returns a default as-is instead of parsing it.
  sessions: z
    .object({
      record: z.boolean().optional().default(DEFAULT_SESSIONS.record),
      retainDays: z.number().int().min(0).max(3650).optional().default(DEFAULT_SESSIONS.retainDays),
      advisoryTokens: z
        .number()
        .int()
        .min(10_000)
        .max(4_000_000)
        .optional()
        .default(DEFAULT_SESSIONS.advisoryTokens),
      limitTokens: z.number().int().min(10_000).max(4_000_000).optional().default(DEFAULT_SESSIONS.limitTokens)
    })
    // `record` and `retainDays` remain readable for old configs and wire compatibility, but they are no longer user choices. Normalizing here covers disk load, renderer saves, browser-extension/config writers and direct updateConfig callers at one boundary.
    .transform((sessions) => ({ ...sessions, record: true, retainDays: 0 }))
    .optional()
    .default({ ...DEFAULT_SESSIONS }),
  compaction: z
    .object({
      auto: z.boolean().optional().default(DEFAULT_COMPACTION.auto),
      // The floor is high enough that the threshold cannot be set somewhere a fresh chat is already past, which would compact every conversation the moment it started.
      autoTokens: z
        .number()
        .int()
        .min(10_000)
        .max(4_000_000)
        .optional()
        .default(DEFAULT_COMPACTION.autoTokens),
      // Existing configs predate this editor. Blank/oversized hand edits recover to the shipped content policy; protocol framing remains outside this user-authored field.
      handoffPrompt: z
        .string()
        .max(MAX_HANDOFF_PROMPT_CHARS)
        .optional()
        .default(DEFAULT_COMPACTION.handoffPrompt)
        .transform((prompt) => prompt.trim() === '' ? DEFAULT_COMPACTION.handoffPrompt : prompt.trim())
        .catch(DEFAULT_COMPACTION.handoffPrompt),
      // Absent in every config before 2.1.27: those keep the shipped 10k–30k brief.
      handoffLength: z.enum(HANDOFF_LENGTHS).optional().default(DEFAULT_HANDOFF_LENGTH).catch(DEFAULT_HANDOFF_LENGTH)
    })
    .optional()
    .default({ ...DEFAULT_COMPACTION, handoffLength: DEFAULT_HANDOFF_LENGTH }),
  multiAgent: z
    .object({
      enabled: z.boolean().optional().default(DEFAULT_MULTI_AGENT.enabled),
    defaultModel: z.string().max(80).optional(),
    defaultReasoning: z.enum(['', ...REASONING_EFFORTS]).optional(),
      maxWorkers: z.number().int().min(1).max(8).optional().default(DEFAULT_MULTI_AGENT.maxWorkers),
      globalMaxWorkers: z.number().int().min(0).max(64).optional().default(DEFAULT_MULTI_AGENT.globalMaxWorkers ?? 0),
      allowUnattributedCalls: z.boolean().optional().default(DEFAULT_MULTI_AGENT.allowUnattributedCalls),
      strictChatAllowlist: z.boolean().optional().default(DEFAULT_MULTI_AGENT.strictChatAllowlist ?? false),
      recoverAgentTabs: z.boolean().optional().default(DEFAULT_MULTI_AGENT.recoverAgentTabs),
      waitForSubAgents: z.boolean().optional().default(DEFAULT_MULTI_AGENT.waitForSubAgents ?? false),
      endSleepingWorkerProcesses: z.boolean().optional().default(DEFAULT_MULTI_AGENT.endSleepingWorkerProcesses ?? false)
    })
    .optional()
    .default({
      enabled: DEFAULT_MULTI_AGENT.enabled,
      maxWorkers: DEFAULT_MULTI_AGENT.maxWorkers,
      globalMaxWorkers: DEFAULT_MULTI_AGENT.globalMaxWorkers ?? 0,
      allowUnattributedCalls: DEFAULT_MULTI_AGENT.allowUnattributedCalls,
      strictChatAllowlist: DEFAULT_MULTI_AGENT.strictChatAllowlist ?? false,
      recoverAgentTabs: DEFAULT_MULTI_AGENT.recoverAgentTabs,
      waitForSubAgents: DEFAULT_MULTI_AGENT.waitForSubAgents ?? false,
      endSleepingWorkerProcesses: DEFAULT_MULTI_AGENT.endSleepingWorkerProcesses ?? false
    }),
  // An empty model id is repaired rather than rejected: the id is free text from a provider listing that changes weekly, and a config that lost it must still load with every root and permission in it intact.
  goal: z
    .object({
      impulseMinutes: z.number().int().min(0).max(60).optional().default(0).catch(0),
      includeToolCalls: z.boolean().optional().default(false),
      enabled: z.boolean().optional().default(DEFAULT_GOAL.enabled),
      backend: z.enum(['api', 'web', 'templates']).optional().default('web'),
      loopBackend: z.enum(['api', 'web']).optional().default('web'),
      // Repaired rather than rejected for the same reason `reasoning` below is: a config written by a version that knows one more mode than this one must not send every root and permission in the file through conservative recovery over a single word.
      mode: z.enum(GOAL_MODES).optional().default(DEFAULT_GOAL.mode).catch(DEFAULT_GOAL.mode),
      model: z
        .string()
        .max(160)
        .optional()
        .default(DEFAULT_GOAL.model)
        .transform((model) => (model.trim() === '' ? DEFAULT_GOAL.model : model.trim())),
      // Repaired for the same reason, and one this section is specifically exposed to: the set of levels is a provider's vocabulary, so a config written by a version that knows one more of them than this one does is a config this app will meet. Rejecting it would send the whole file — every root, every permission — through conservative recovery over a word in one field nobody would miss.
      reasoning: z
        .enum(GOAL_REASONING_LEVELS)
        .optional()
        .default(DEFAULT_GOAL.reasoning)
        .catch(DEFAULT_GOAL.reasoning),
      // Existing configs predate the editor, and a hand-edited blank prompt must not turn Goal Mode into an unconstrained continuation model. Both adopt the strong default.
      prompt: z
        .string()
        .max(MAX_GOAL_SYSTEM_PROMPT_CHARS)
        .optional()
        .default(DEFAULT_GOAL.prompt)
        .transform((prompt) => (prompt.trim() === '' ? DEFAULT_GOAL.prompt : prompt.trim()))
        .catch(DEFAULT_GOAL.prompt),
      // Repaired exactly like `prompt` above, and for the same reason: a config predating the second editor, or hand-edited to blank, must not leave the goal driver running with no instruction at all. Both fall back to the shipped default rather than to emptiness.
      objectivePrompt: z
        .string()
        .max(MAX_GOAL_SYSTEM_PROMPT_CHARS)
        .optional()
        .default(DEFAULT_GOAL.objectivePrompt)
        .transform((prompt) =>
          prompt.trim() === '' ? DEFAULT_GOAL.objectivePrompt : prompt.trim()
        )
        .catch(DEFAULT_GOAL.objectivePrompt),
      // The third editor, repaired exactly like the two above. Loop is the mode that cannot stop on its own, so an empty instruction here would be an unconstrained model typing into somebody's chat forever — the one shape this section must never load in.
      loopPrompt: z
        .string()
        .max(MAX_GOAL_SYSTEM_PROMPT_CHARS)
        .optional()
        .default(DEFAULT_GOAL.loopPrompt)
        .transform((prompt) => (prompt.trim() === '' ? DEFAULT_GOAL.loopPrompt : prompt.trim()))
        .catch(DEFAULT_GOAL.loopPrompt)
    })
    .optional()
    .default({
      backend: 'web',
      loopBackend: 'web',
      impulseMinutes: 0,
      includeToolCalls: false,
      enabled: false,
      mode: DEFAULT_GOAL.mode,
      model: DEFAULT_GOAL.model,
      reasoning: DEFAULT_GOAL.reasoning,
      prompt: DEFAULT_GOAL.prompt,
      objectivePrompt: DEFAULT_GOAL.objectivePrompt,
      loopPrompt: DEFAULT_GOAL.loopPrompt
    }),
  providerTools: z
    .object({
      // Repaired rather than rejected, like the Goal prompts above: this is free text a person typed, and one over-long or malformed field must not send the whole config — every root, every permission — through conservative recovery.
      instructions: z
        .string()
        .optional()
        .default(DEFAULT_PROVIDER_TOOLS.instructions)
        .transform((value) => value.slice(0, MAX_PROVIDER_TOOL_INSTRUCTIONS_CHARS).trim())
        .catch(DEFAULT_PROVIDER_TOOLS.instructions)
    })
    .optional()
    .default({ ...DEFAULT_PROVIDER_TOOLS })
    .catch({ ...DEFAULT_PROVIDER_TOOLS }),
  // A malformed value falls back to off rather than to conservative recovery: the switches can only ever widen access, so "off" is the safe repair and the rest of the file stays valid. Each field repairs on its own, so a bad `allowActions` cannot switch the API itself off, and actions never outlive the API: a hand-edited `{ enabled: false, allowActions: true }` loads as off.
  controlApi: z
    .object({
      enabled: z.boolean().optional().default(DEFAULT_CONTROL_API.enabled).catch(DEFAULT_CONTROL_API.enabled),
      allowActions: z.boolean().optional().default(DEFAULT_CONTROL_API.allowActions).catch(DEFAULT_CONTROL_API.allowActions)
    })
    .transform((value) => ({ enabled: value.enabled, allowActions: value.enabled && value.allowActions }))
    .optional()
    .default({ ...DEFAULT_CONTROL_API })
    .catch({ ...DEFAULT_CONTROL_API })
});

