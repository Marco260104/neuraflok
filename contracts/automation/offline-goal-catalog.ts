export const OFFLINE_GOAL_MARKER_INSTRUCTION = '\n\nFor this NEURAFLOK Goal decision, end with exactly one standalone marker: [[NEURAFLOK_GOAL:COMPLETE]] only after every requested outcome is verified, or [[NEURAFLOK_GOAL:CONTINUE]] while authorized work remains. If progress requires user input, name the missing detail and omit both markers.';

const NEXT_STEPS = [
  'Resume from the last verified checkpoint and complete the requested outcome',
  'Continue with the highest-priority unfinished requirement',
  'Use the current repository and conversation evidence to finish the task',
  'Complete the remaining implementation before describing the result',
  'Turn the next required action into a checked change in the worktree',
  'Advance the active request while respecting every constraint already given',
  'Work through the outstanding requirements in their original order',
  'Continue from the latest completed step toward the full result',
  'Resolve the open issue that most directly blocks completion',
  'Apply the required change and confirm its effect on existing behavior',
  'Use the task record and current files to identify what remains',
  'Finish the work already authorized before reporting its status',
  'Keep the original objective intact and complete its pending parts',
  'Implement from the verified requirements rather than making another plan',
  'Make the next requested outcome concrete in the project',
  'Review the acceptance conditions and complete the next unmet one',
  'Do the remaining work needed to satisfy the supplied requirements',
  'Keep progressing until the requested result is ready for review',
  'Complete every outstanding part supported by the task requirements',
  'Close the unfinished work before giving a final report'
] as const;

const QUALITY_CHECKS = [
  'Preserve the requested behavior while changing its implementation.',
  'Check consumers and tests before editing a shared contract.',
  'Verify the modified path with focused checks.',
  'Keep changes tied to the stated product objective.',
  'Ask only if a missing fact prevents safe progress.',
  'Record verified results and return to implementation.',
  'Recheck the result against the original acceptance conditions.',
  'Report completion only when every required item is satisfied.',
  'Use current filesystem and runtime evidence as the source of truth.',
  'Stop only after the full requested result is complete.'
] as const;

function buildContinuationCatalog(): readonly string[] {
  const entries: string[] = [];
  for (const nextStep of NEXT_STEPS) {
    for (const qualityCheck of QUALITY_CHECKS) entries.push(`${nextStep}. ${qualityCheck}`);
  }
  return Object.freeze(entries);
}

export const OFFLINE_GOAL_CONTINUATIONS = buildContinuationCatalog();
