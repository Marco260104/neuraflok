import { isAstraModel, isProModel } from '../model-capabilities.js';
import type { InputAutomation } from '../input.js';
import type { ReasoningEffort } from '../session.js';

export function supportsFinishAutomation(mode: InputAutomation, model: string | null | undefined, effort?: ReasoningEffort): boolean {
  if (mode === 'off') return false;
  if (isAstraModel(model, effort)) return true;
  return mode === 'loop' && isProModel(model, effort);
}

export function finishInstruction(leadMinutes?: number): string {
  const verificationWindow = leadMinutes === 3 ? 3 : 5;
  return `Complete the requested implementation and follow-up corrections before calling this tool. Use session_finish only when the requested implementation is complete and about ${verificationWindow} minutes of final verification remain. New instructions extend the work; they do not require another finish call. Do not use this tool for progress updates or to collect queued tasks.`;
}
