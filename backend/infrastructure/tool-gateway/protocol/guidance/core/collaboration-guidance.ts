import type { ToolContext } from '../../kernel.js';
import type { getConfig } from '../../../../settings/config.js';
import type { CoreWorkspaceContext } from './workspace-context.js';

export function collaborationGuidance(
  ctx: ToolContext,
  config: ReturnType<typeof getConfig>,
  workspace: CoreWorkspaceContext
): string[] {
  const lines: string[] = [];
  if (workspace.sessionTools) lines.push(
    '',
    '# Task plan',
    'Use update_plan for tasks with several meaningful steps; skip it for simple tasks. Give each step a short user-facing headline and concrete details about the approach, constraints or checks. Send the complete plan on every update, preserving useful details. Keep at most one step in_progress.',
    'Update the plan when a step is completed or the approach changes. Mark steps completed only when their work is done. Do not repeat the full plan in chat: the app shows the headlines with expandable details above queued messages.',
    'The plan does not execute steps or mark queued instructions done. New user instructions extend the work; update the plan accordingly.'
  );
  if (workspace.agentTools) lines.push(
    '',
    '# Workers',
    'Use agents for independent subtasks while continuing useful work yourself. Reuse a sleeping worker for related follow-up work before spawning a replacement. Only terminal workers whose context is full need replacing.',
    'When spawning workers, omit model and reasoning_effort unless the user explicitly requests an override. The app uses saved worker defaults; do not ask the user to choose or confirm them.',
    'A worker sees only what you send it. In spawn, put shared repository/folder instructions, constraints and validation requirements in context once; put the objective and assigned files in each task. Explicitly say what each worker may change. Do not repeat the shared context in every task.',
    'Use action=message to steer a worker; batch messages when sending several. Reports arrive only with tool results; they do not restart an idle prime. Use status once to collect pending reports before finalizing; do not repeatedly poll. If a report has not arrived, state that review is pending; do not claim delegated verification is complete before reading its report. Check findings and changes before relying on them.',
    'Workers communicate with the prime, keep working while replies are pending, and use action=finish when done with RESULT / CHANGES / VALIDATION / BLOCKERS. A finished reusable worker sleeps and can be messaged again.'
  );
  if (ctx.exposedFinishTool ?? config.ui.finishTool) lines.push(
    '',
    'Use session_finish only when the user prompt explicitly requests it, with any model. Follow that prompt’s finish timing after implementation; complete newly delivered work. It is not a plan/progress update or a way to collect queued tasks. Workers use agents action=finish instead.'
  );
  return lines;
}
