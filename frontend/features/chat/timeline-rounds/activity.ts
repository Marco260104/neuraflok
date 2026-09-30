import type { SessionEvent } from '../../../../contracts/session.js';

export function isActivity(event: SessionEvent | undefined): boolean {
  if (!event) return false;
  if (event.kind === 'tool_call' || event.kind === 'page_tool' || event.kind === 'agent_message') return true;
  if (event.kind === 'progress') return event.source !== 'app' && !event.progressId?.startsWith('approval');
  return event.kind === 'assistant_message' && !event.final && event.state !== 'final';
}
