import { getConfig, MAX_PROVIDER_TOOL_INSTRUCTIONS_CHARS } from '../../../settings/config.js';

/** Appends bounded user instructions after the current connector contract. */
export function userInstructions(): string[] {
  const text = getConfig().providerTools.instructions.trim();
  if (!text) return [];
  return ['', "The user's own standing instructions for local tools:", text.slice(0, MAX_PROVIDER_TOOL_INSTRUCTIONS_CHARS)];
}
