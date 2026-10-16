export { defaultConfig, DEFAULT_GOAL_MODEL } from './config/defaults.js';
export { adoptCurrentGoalPrompt } from './config/migrations.js';
export { MAX_PROVIDER_TOOL_INSTRUCTIONS_CHARS } from './config/schema.js';
export {
  effectiveCapabilities, getConfig, initConfigPath, loadConfig, saveConfig,
  settingsRecovered, updateConfig
} from './config/store.js';
