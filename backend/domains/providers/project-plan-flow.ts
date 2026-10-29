import { WEB_CHAT_PLAN_DECISION_TOOL_NAMES } from '../../../contracts/chat-protocol.js';

export type ProjectPlanStage = 'draft' | 'review' | 'approved' | 'cancel' | null;

/** The model emits one of these workflow-only tool calls after judging the user's meaning. */
export function projectPlanDecisionFromTool(name: string): 'approved' | 'cancel' | 'revise' | null {
  if (name === WEB_CHAT_PLAN_DECISION_TOOL_NAMES[0]) return 'approved';
  if (name === WEB_CHAT_PLAN_DECISION_TOOL_NAMES[1]) return 'cancel';
  if (name === WEB_CHAT_PLAN_DECISION_TOOL_NAMES[2]) return 'revise';
  return null;
}

export function hasEmptyProjectPlanDecisionArguments(raw: string): boolean {
  try {
    const value: unknown = JSON.parse(raw);
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
  } catch {
    return false;
  }
}

export function projectPlanRevisionFromTool(raw: string): string | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as { plan?: unknown };
    const plan = typeof row.plan === 'string' ? row.plan.trim() : '';
    return Object.keys(value).length === 1 && plan.length > 0 && plan.length <= 32_000 ? plan : null;
  } catch {
    return null;
  }
}

export function projectPlanContext(state: { request: string; plan: string }, action: 'draft' | 'review' | 'approved' | 'cancel'): string {
  if (action === 'draft') return [
    'PLAN MODE: This is a temporary planning gate, separate from the app-wide access setting. First inspect relevant existing project files with read-only tools; do not describe the app as globally read-only.',
    'Do not edit or create files, run commands, start agents, or make any changes.',
    'Then give a concise, natural plan in the configured language and ask for explicit approval. No work may begin before approval.'
  ].join('\n');
  if (action === 'review') return [
    '# Plan awaiting approval',
    `Original request:\n${state.request}`,
    `Current proposed plan:\n${state.plan}`,
    'This is a temporary approval gate for the pending plan, not the app-wide access setting. Do not claim that NEURAFLOK is globally in read-only mode or ask the user to change their access setting. Judge the latest user-authored message by its meaning, not by a fixed list of words. If it clearly authorizes carrying out this plan, call approve_project_plan by itself; if it clearly cancels the plan, call cancel_project_plan by itself; if it asks to revise the plan, call revise_project_plan alone with the complete revised plan. Questions and uncertainty are not approval; answer or ask a concise clarification. These workflow signals have no file or command side effects. Until the user clearly approves, do not edit files, run commands, start agents, or make changes. Respond naturally and directly in the configured language.'
  ].join('\n\n');
  if (action === 'approved') return [
    '# User-approved project plan',
    `Original request:\n${state.request}`,
    `Approved plan:\n${state.plan}`,
    'The user explicitly approved this plan. Carry it out now in the selected project using the tools allowed by the current app permissions. The earlier planning gate is cleared; do not describe the app as read-only or ask the user to change access settings.'
  ].join('\n\n');
  return 'The user cancelled the pending project plan. Make no project changes; acknowledge the cancellation briefly.';
}
