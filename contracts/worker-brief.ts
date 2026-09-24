/** A worker's brief: the run's shared context, when the prime gave one, before the worker's own task. Both sides live here, so the format the worker receives and the task the app shows from it cannot drift apart. */
const CONTEXT_HEADING = 'Shared context for every worker in this run:';
const TASK_HEADING = '\n\nYour task:\n';

export function workerBrief(context: string, task: string): string {
  if (!context) return task;
  return `${CONTEXT_HEADING}\n${context}${TASK_HEADING}${task}`;
}

export function workerBootstrapText(agent: string, task: string): string {
  return `${task}\n\n(NEURAFLOK: you are ${agent}, a worker. Report to prime through the agents tool — ` +
    'action=message to="prime" as you go, action=finish once at the end. Workers cannot reach each other. ' +
    'The prime assigns your task; its later messages may update the task and assigned files, including a read-only audit becoming an edit task. ' +
    'Follow that latest assignment within the user’s permissions and standing constraints. ' +
    'ultrathink)';
}

/** The worker's own task from its brief: the shared context, the same for every worker, removed. */
export function workerOwnTask(brief: string): string {
  if (!brief.startsWith(CONTEXT_HEADING)) return brief;
  const at = brief.indexOf(TASK_HEADING);
  // Legacy briefs are plain text, not an escaped wire format. A heading can occur in either authored section: with more than one boundary, preserve rather than guess.
  if (at >= 0 && brief.indexOf(TASK_HEADING, at + TASK_HEADING.length) >= 0) return brief;
  return at < 0 ? brief : brief.slice(at + TASK_HEADING.length).trim() || brief;
}
