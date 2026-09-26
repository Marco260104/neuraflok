import type { ActivitySummary, FileChange } from '../../../../contracts/session.js';
import type { CallEvidence } from '../../../infrastructure/tool-gateway/protocol/call-context.js';
import { summarizeDesktopTool } from './summary-desktop-tools.js';
import { summarizeFileTool } from './summary-file-tools.js';
import { record } from './summary-format.js';
import { ongoingTitle, summarizeOutcome } from './summary-outcomes.js';
import { summarizeProcessTool } from './summary-process-tools.js';
import { summarizeSessionTool } from './summary-session-tools.js';
import type { SummaryInput } from './summary-types.js';

export { shortPath } from './summary-format.js';
export type { SummaryInput } from './summary-types.js';

function build(input: SummaryInput, changes: readonly FileChange[] = input.evidence.changes): ActivitySummary {
  const args = record(input.args);
  return summarizeFileTool(input, args, changes)
    ?? summarizeProcessTool(input, args)
    ?? summarizeDesktopTool(input, args)
    ?? summarizeSessionTool(input, args)
    ?? { kind: 'other', tone: 'neutral', title: `Ran ${input.tool}` };
}

export function summarizeRunningCall(
  tool: string,
  args: unknown,
  evidence: CallEvidence
): { title: string; kind: ActivitySummary['kind'] } {
  let summary: ActivitySummary;
  try {
    summary = build({ tool, args, evidence, outcome: 'ok', durationMs: 0 }, []);
  } catch {
    return { title: `Running ${tool}`, kind: 'other' };
  }
  return { title: ongoingTitle(summary.title) ?? `Running ${tool}`, kind: summary.kind };
}

export function summarizeToolCall(input: SummaryInput): ActivitySummary {
  const summary = build(input);
  return summarizeOutcome(input, summary, input.evidence.changes);
}
