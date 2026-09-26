import type { ActivitySummary } from '../../../../contracts/session.js';
import type { SummaryInput } from './summary-types.js';
import { commandActivityTitle } from './summary-command-intent.js';
import { formatDuration, str } from './summary-format.js';

export function summarizeProcessTool(input: SummaryInput, args: Record<string, unknown>): ActivitySummary | null {
  const evidence = input.evidence;
  switch (input.tool) {
    case 'exec_command': {
      const commands = Array.isArray(args['cmds']) ? args['cmds'].filter((item): item is string => typeof item === 'string') : [];
      const activity = commandActivityTitle(commands.length ? commands.join('\n') : str(args['cmd']));
      const rest = activity.replace(/^(Read|Edited|Deleted|Created|Copied|Moved|Listed|Searched|Checked|Ran)\s+/, '');
      const failed = evidence.timedOut || (!evidence.benignExit && evidence.exitCode !== null && evidence.exitCode !== 0);
      const running = evidence.running === true ||
        (evidence.running === null && !evidence.timedOut && evidence.exitCode === null && evidence.durationMs !== null);
      const took = evidence.durationMs ?? input.durationMs;
      return {
        kind: 'run',
        tone: failed ? 'bad' : running ? 'neutral' : 'good',
        title: failed ? `Command failed ${rest}` : running ? `Started ${rest}` : activity,
        metric: running
          ? 'started'
          : evidence.timedOut
            ? '✕ timed out'
            : failed ? `✕ exit ${evidence.exitCode}` : `✓ ${formatDuration(took)}`
      };
    }
    case 'write_stdin': {
      const id = typeof args['session_id'] === 'number' ? String(args['session_id']) : str(args['session_id']) ?? '';
      const signal = str(args['signal']);
      const title = signal === 'kill'
        ? `Stopped session ${id}`.trim()
        : signal === 'int'
          ? `Interrupted session ${id}`.trim()
          : str(args['chars']) ? `Wrote to session ${id}`.trim() : `Waited on session ${id}`.trim();
      const failed = !evidence.benignExit && evidence.exitCode !== null && evidence.exitCode !== 0;
      return {
        kind: 'process',
        tone: signal === 'kill' ? 'warn' : failed ? 'bad' : 'neutral',
        title,
        ...(evidence.exitCode === null ? {} : { metric: failed ? `✕ exit ${evidence.exitCode}` : '✓ finished' })
      };
    }
    default:
      return null;
  }
}
