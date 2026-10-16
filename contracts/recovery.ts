// Project an existing recovery deadline without authorizing an action.
export type RecoveryCountdown = {
  kind: 'unattributed' | 'unattributed-wait' | 'assistant-error' | 'tab-recovery' | 'thinking-failed' | 'native-busy' | 'silence' | 'post-reload' | 'pickup' | 'pickup-stopped';
  deadline: number;
  // Attempts already spent for a pickup that reached its durable limit.
  attempts?: number;
  // The existing UI clock reveals this row without a new backend event.
  visibleAt?: number;
  next?: 'queue' | 'goal' | 'loop' | 'continue';
  // The original attribution retry conditions are currently satisfied.
  reload?: true;
  // NEURAFLOK holds the source turn open during the existing post-reload wait.
  generating?: true;
};

// Offer a browser pickup at most three times after 2, 5 and 10 minutes.
export const BROWSER_PICKUP_MAX_ATTEMPTS = 3;
export const BROWSER_PICKUP_BACKOFF_MS = [2, 5, 10].map(minutes => minutes * 60_000) as [number, ...number[]];

const CONTINUE_TEXTS = [
  'Complete the remaining work and deliver the requested result.',
  'Finish every outstanding part of the current request.',
  'Continue from the current state until the task is complete.',
  'Bring the active work to completion, including its final checks.',
  'Work through the unfinished requirements and provide the result.',
  'Close the remaining gaps in the current task before responding.',
  'Finish the implementation and report what remains, if anything.',
  'Proceed with the pending work until the requested outcome is ready.',
  'Complete the open items and then give a concise status.',
  'Carry the current task through implementation and final review.'
] as const;

const RECOVERY_NOTES = [
  'The prior session ended before summarizing its work. Inspect the repository and continue only with requirements that are still open.',
  'Review the current files and recent changes first, then pick up any unfinished part of the request.',
  'Earlier work may already be present in the workspace. Verify its state before making overlapping changes.',
  'Check the active branch and generated artifacts to determine which parts are complete and which still need attention.',
  'The visible conversation may not include the full work history. Use the current project state to guide the next step.',
  'Inspect existing changes and preserve completed work while addressing the remaining requirements.',
  'Establish what is already implemented from the repository itself before resuming the task.',
  'Some updates may have landed before the interruption. Review them and avoid repeating completed steps.',
  'Use the current workspace as the source of truth, then continue with the work that remains.',
  'Check the implementation and its verification state before deciding what to do next.'
] as const;

// Build a recovery prompt that resumes the original task without unrelated asides.
export function recoveryMessage(): string {
  const pick = (values: readonly string[]) => values[Math.floor(Math.random() * values.length)]!;
  return `${pick(CONTINUE_TEXTS)} ${pick(RECOVERY_NOTES)}`;
}

// Give a busy native page one half-window on the existing silence clock.
export const recoveryBusyMs = (pro: boolean): number => (pro ? 5 : 1) * 60_000;
