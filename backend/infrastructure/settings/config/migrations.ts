import type { Config } from '../../../../contracts/types.js';
import { adoptShippedAppearance } from '../../../../contracts/appearance-settings.js';
import { GOAL_PROMPT_FINGERPRINTS } from '../../../../contracts/automation/goal-prompt-fingerprints.js';
import { DEFAULT_GOAL_LOOP_SYSTEM_PROMPT, DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT, DEFAULT_GOAL_SYSTEM_PROMPT } from '../../../../contracts/automation/goal-prompts.js';
import { migrateGoalPrompt } from '../goal-prompt-migration.js';
import { DEFAULT_COMPACTION, DEFAULT_SESSIONS } from './defaults.js';

const OLD_TOKEN_DEFAULTS = [
  { advisoryTokens: 180_000, limitTokens: 200_000 },
  { advisoryTokens: 300_000, limitTokens: 400_000 }
];

/** Moves any exactly-as-shipped Goal prompt, from any past version, onto the current default. All three prompts — the gate, the driver and the loop — are editable and persisted, so changing a source constant alone would leave an existing untouched install on the old behaviour forever. Exact equality is the fence: any user customization, even a one-character change, is preserved verbatim. Each list is walked rather than compared against one predecessor, so an install that skipped a release still migrates instead of being stranded on a default two generations old. */
export function adoptCurrentGoalPrompt(config: Config, fingerprints = GOAL_PROMPT_FINGERPRINTS): Config {
  const goal = { ...config.goal };
  goal.prompt = migrateGoalPrompt(goal.prompt, DEFAULT_GOAL_SYSTEM_PROMPT, fingerprints.system);
  goal.objectivePrompt = migrateGoalPrompt(goal.objectivePrompt, DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT, fingerprints.objective);
  goal.loopPrompt = migrateGoalPrompt(goal.loopPrompt, DEFAULT_GOAL_LOOP_SYSTEM_PROMPT, fingerprints.loop);
  return { ...config, goal };
}

function migrateLegacyApiSettings(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const config = value as Record<string, unknown>;
  if (!config.goal || typeof config.goal !== 'object' || Array.isArray(config.goal)) return value;
  const goal = config.goal as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(goal, 'provider')) return value;
  const { provider: legacyProvider, ...currentGoal } = goal;
  const currentProviders = config.providers && typeof config.providers === 'object' && !Array.isArray(config.providers)
    ? config.providers as Record<string, unknown>
    : {};
  const api = Object.prototype.hasOwnProperty.call(currentProviders, 'api') ? currentProviders.api : legacyProvider;
  return { ...config, goal: currentGoal, providers: { ...currentProviders, api } };
}

function migrateLegacyProviderToolSettings(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const config = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(config, 'mcp')) return value;
  const { mcp: legacySettings, ...current } = config;
  const providerTools = Object.prototype.hasOwnProperty.call(current, 'providerTools') ? current.providerTools : legacySettings;
  return { ...current, ...(providerTools === undefined ? {} : { providerTools }) };
}

function migrateLegacyGoalSettings(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const config = value as Record<string, unknown>;
  let migrated = config;
  const ui = config.ui;
  if (ui && typeof ui === 'object' && !Array.isArray(ui)) {
    const settings = ui as Record<string, unknown>;
    if (settings.planBackend === 'chatgpt') migrated = { ...migrated, ui: { ...settings, planBackend: 'api' } };
  }
  const goal = migrated.goal;
  if (goal && typeof goal === 'object' && !Array.isArray(goal)) {
    const settings = goal as Record<string, unknown>;
    const next = { ...settings };
    if (next.backend === 'chatgpt') next.backend = 'api';
    if (next.loopBackend === 'chatgpt') next.loopBackend = 'api';
    delete next.helperModel;
    delete next.helperReasoning;
    migrated = { ...migrated, goal: next };
  }
  return migrated;
}

/** Applies any superseded pair in OLD_TOKEN_DEFAULTS → DEFAULT_SESSIONS, untouched pairs only. */
function recalibrateTokens(config: Config): Config {
  const { advisoryTokens, limitTokens } = config.sessions;
  const untouched = OLD_TOKEN_DEFAULTS.some(
    (old) => advisoryTokens === old.advisoryTokens && limitTokens === old.limitTokens
  );
  if (!untouched) {
    return config;
  }
  return {
    ...config,
    sessions: {
      ...config.sessions,
      advisoryTokens: DEFAULT_SESSIONS.advisoryTokens,
      limitTokens: DEFAULT_SESSIONS.limitTokens
    }
  };
}

/** What automatic compaction used to default to, for the same one-time move as above. A config written before 1.7.5 spells the old answer out, so raising the default alone would only ever reach a fresh install. A stored pair that is *exactly* the old default was never a decision — it is what the app wrote for itself — so it moves. Anything the user actually chose is left alone, including switching it off on purpose, which is why `auto: true` with the old threshold is not touched: that is somebody's own setting. */
const OLD_AUTO_DEFAULTS = { auto: false, autoTokens: 300_000 };

function adoptAutoCompaction(config: Config): Config {
  const { auto, autoTokens } = config.compaction;
  if (auto !== OLD_AUTO_DEFAULTS.auto || autoTokens !== OLD_AUTO_DEFAULTS.autoTokens) return config;
  return {
    ...config,
    compaction: { ...config.compaction, auto: DEFAULT_COMPACTION.auto, autoTokens: DEFAULT_COMPACTION.autoTokens }
  };
}

/** The 1.8 automatic default, moved up with the window. This is the third time a stored number that was never chosen has had to follow a default, and it is the one case where the file's own rule is uncomfortable. `adoptAutoCompaction` above deliberately leaves `auto: true` at the old threshold alone, on the grounds that switching it on was a decision — but that was written when `auto: false` was the shipped default. Since 1.8 the app writes `auto: true` at 300k for itself, so the two populations are no longer distinguishable in the file, and the larger of them never decided anything. They move. A threshold that is any other number was typed by somebody and stays. There is no matching migration downward: 400k is what this now defaults to, so a config that already holds it, whether from 1.7 or from a person, simply keeps it. */
const SUPERSEDED_AUTO_DEFAULTS = { auto: true, autoTokens: 300_000 };

function adoptWiderWindow(config: Config): Config {
  const { auto, autoTokens } = config.compaction;
  if (auto !== SUPERSEDED_AUTO_DEFAULTS.auto || autoTokens !== SUPERSEDED_AUTO_DEFAULTS.autoTokens) return config;
  return {
    ...config,
    compaction: { ...config.compaction, autoTokens: DEFAULT_COMPACTION.autoTokens }
  };
}

export function migrateStoredConfig(value: unknown): unknown {
  return migrateLegacyGoalSettings(migrateLegacyProviderToolSettings(migrateLegacyApiSettings(value)));
}

function adoptCurrentAppearance(config: Config): Config {
  const appearance = adoptShippedAppearance(config.ui.appearance);
  if (appearance === config.ui.appearance) return config;
  return { ...config, ui: { ...config.ui, appearance } };
}

export function upgradeConfigDefaults(config: Config): Config {
  return adoptCurrentAppearance(adoptCurrentGoalPrompt(adoptWiderWindow(adoptAutoCompaction(recalibrateTokens(config)))));
}

