import {
  emptyEvidence,
  noteExec,
  noteOutcome,
  runInCallContext,
} from './context.js';
import type {
  CallContext,
  ToolOutcome,
} from './context.js';
import {
  describe,
  expect,
  it,
} from 'vitest';

describe('the outcome a shell command is recorded with', () => {
  /** Runs `noteExec` the way a tool does, and reports what the recorder would store. */
  const outcomeOf = (
    result: { exitCode: number | null; timedOut?: boolean },
    preset: ToolOutcome | null = null
  ) => {
    const context: CallContext = {
      startedAt: Date.now(),
      transportKey: null,
      agent: null,
      caller: { transportKey: null, requestId: null, conversationId: null },
      outcome: preset,
      evidence: emptyEvidence()
    };
    runInCallContext(context, () => noteExec(result));
    // Nothing set means the dispatcher's fallback applies, and for a non-error tool result that fallback is `ok` — which is exactly the bug this covers.
    return context.outcome ?? 'ok';
  };

  it('calls a completed non-zero exit the child’s own failure, not a success', () => {
    expect(outcomeOf({ exitCode: 1 })).toBe('process_exit_nonzero');
    expect(outcomeOf({ exitCode: 3 })).toBe('process_exit_nonzero');
  });

  it('leaves a clean exit and a still-running process alone', () => {
    expect(outcomeOf({ exitCode: 0 })).toBe('ok');
    // Still running: it has not failed yet, and saying it did would be a lie about a dev server that is doing exactly what was asked of it.
    expect(outcomeOf({ exitCode: null })).toBe('ok');
  });

  it('blames this connector for a timeout, not the child', () => {
    expect(outcomeOf({ exitCode: null, timedOut: true })).toBe('tool_internal_error');
    expect(outcomeOf({ exitCode: 1, timedOut: true })).toBe('tool_internal_error');
  });

  it('never overwrites an outcome the tool layer set deliberately', () => {
    expect(outcomeOf({ exitCode: 1 }, 'tool_rejected')).toBe('tool_rejected');
  });

  it('does not let the guard downgrade a command error back to ok', () => {
    const context: CallContext = {
      startedAt: Date.now(),
      transportKey: null,
      agent: null,
      caller: { transportKey: null, requestId: null, conversationId: null },
      outcome: null,
      evidence: emptyEvidence()
    };
    runInCallContext(context, () => {
      noteExec({ exitCode: 7 });
      // This is what guard() does when the tool returns a normal ToolResult whose text says the child exited non-zero. The more specific process outcome must survive it.
      noteOutcome('ok');
    });
    expect(context.outcome).toBe('process_exit_nonzero');
  });
});
