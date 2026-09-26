import type { ActivitySummary } from '../../../../contracts/session.js';
import type { SummaryInput } from './summary-types.js';
import { arr, plural, record, str } from './summary-format.js';

export function summarizeSessionTool(input: SummaryInput, args: Record<string, unknown>): ActivitySummary | null {
  const evidence = input.evidence;
  switch (input.tool) {
    case 'update_plan': {
      const steps = arr(args['plan']);
      const completed = steps.filter(step => record(step)['status'] === 'completed').length;
      return {
        kind: 'session',
        tone: 'neutral',
        title: steps.length ? 'Updated the task plan' : 'Cleared the task plan',
        ...(steps.length ? { detail: `${completed} / ${steps.length} completed` } : {})
      };
    }
    case 'session': {
      const action = str(args['action']) ?? 'search';
      const query = str(args['query']);
      if (action === 'search') {
        return {
          kind: 'session',
          tone: 'neutral',
          title: query ? `Searched recordings ${JSON.stringify(query.slice(0, 40))}` : 'Listed recent recordings',
          ...(evidence.count !== null ? { detail: plural(evidence.count, 'session') } : {})
        };
      }
      const toolCall = str(args['tool_call']);
      const cursor = str(args['cursor']);
      return {
        kind: 'session',
        tone: 'neutral',
        title: toolCall
          ? 'Opened one recorded tool call'
          : cursor
            ? 'Continued reading a recorded session'
            : 'Read a recorded session',
        ...(evidence.count !== null ? { detail: plural(evidence.count, 'entry', 'entries') } : {})
      };
    }
    case 'agents': {
      const action = str(args['action']) ?? 'status';
      switch (action) {
        case 'spawn':
          return { kind: 'agent', tone: 'good', title: `Created ${plural(arr(args['workers']).length, 'worker agent')}` };
        case 'message': {
          const batch = arr(args['messages']);
          if (batch.length > 1) return { kind: 'agent', tone: 'neutral', title: `Messaged ${plural(batch.length, 'agent')}` };
          const only = batch.length === 1 ? batch[0] as Record<string, unknown> : args;
          return { kind: 'agent', tone: 'neutral', title: `Messaged ${str(only['to']) ?? 'the prime agent'}` };
        }
        case 'finish':
          return { kind: 'agent', tone: 'good', title: 'Reported the finished task' };
        default:
          return {
            kind: 'agent',
            tone: 'neutral',
            title: 'Checked agent status',
            ...(evidence.count !== null ? { detail: plural(evidence.count, 'message') } : {})
          };
      }
    }
    default:
      return null;
  }
}
