export type ProjectPlanAction = 'approved' | 'cancel' | null;

/** Only a clear, stand-alone approval unlocks project tools after planning. */
export function projectPlanAction(text: string): ProjectPlanAction {
  const value = text.trim().replace(/[.!\s]+$/g, '').toLocaleLowerCase();
  if (/^(?:approve|approve the plan|approved|yes,? (?:proceed|continue|start|execute)|go ahead|proceed|execute the plan|start now|aprobar|aprobado|aprobada|sí|si|sí,? (?:procede|continúa|empieza|ejecuta)|si,? (?:procede|continua|empieza|ejecuta)|adelante|empieza ahora|ejecuta el plan)$/.test(value)) return 'approved';
  if (/^(?:cancel|cancel plan|stop planning|cancelar|cancelar plan|detén el plan|detener el plan|olvida el plan)$/.test(value)) return 'cancel';
  return null;
}

export function projectPlanContext(state: { request: string; plan: string }, action: 'draft' | 'review' | 'approved' | 'cancel'): string {
  if (action === 'draft') return [
    'PLAN MODE: First inspect relevant existing project files with read-only tools.',
    'Do not edit or create files, run commands, start agents, or make any changes.',
    'Then give a concise, natural plan in the configured language and ask for explicit approval. No work may begin before approval.'
  ].join('\n');
  if (action === 'review') return [
    '# Plan awaiting approval',
    `Original request:\n${state.request}`,
    `Current proposed plan:\n${state.plan}`,
    'The user has not approved this plan. Answer their current message or revise the plan using read-only file tools only. Do not edit files, run commands, start agents, or make changes. Ask for explicit approval before work begins.'
  ].join('\n\n');
  if (action === 'approved') return [
    '# User-approved project plan',
    `Original request:\n${state.request}`,
    `Approved plan:\n${state.plan}`,
    'The user explicitly approved this plan. Carry it out now in the selected project, following all project instructions and current permissions.'
  ].join('\n\n');
  return 'The user cancelled the pending project plan. Make no project changes; acknowledge the cancellation briefly.';
}
