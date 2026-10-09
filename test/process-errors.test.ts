import { expect, it } from 'vitest';
import { UnifiedExecError } from '../backend/domains/workspace/execution/process-errors.js';

it('keeps process failure messages and structured debug details stable', () => {
  const cases = [
    {
      error: UnifiedExecError.createProcess('ENOENT'),
      kind: 'create_process',
      message: 'Failed to create unified exec process: ENOENT',
      detail: 'ENOENT',
      processId: null,
      debug: 'CreateProcess { message: "ENOENT" }'
    },
    {
      error: UnifiedExecError.processFailed('exit code 7'),
      kind: 'process_failed',
      message: 'Unified exec process failed: exit code 7',
      detail: 'exit code 7',
      processId: null,
      debug: 'ProcessFailed { message: "exit code 7" }'
    },
    {
      error: UnifiedExecError.unknownProcessId(47),
      kind: 'unknown_process_id',
      message: 'Unknown process id 47',
      detail: null,
      processId: 47,
      debug: 'UnknownProcessId { process_id: 47 }'
    },
    {
      error: UnifiedExecError.writeToStdin(),
      kind: 'write_to_stdin',
      message: 'failed to write to stdin',
      detail: null,
      processId: null,
      debug: 'WriteToStdin'
    },
    {
      error: UnifiedExecError.stdinClosed(),
      kind: 'stdin_closed',
      message: 'stdin is closed for this session; rerun exec_command with tty=true to keep stdin open',
      detail: null,
      processId: null,
      debug: 'StdinClosed'
    },
    {
      error: UnifiedExecError.missingCommandLine(),
      kind: 'missing_command_line',
      message: 'missing command line for unified exec request',
      detail: null,
      processId: null,
      debug: 'MissingCommandLine'
    }
  ];

  for (const entry of cases) {
    expect(entry.error).toBeInstanceOf(Error);
    expect(entry.error).toMatchObject({
      name: 'UnifiedExecError',
      kind: entry.kind,
      message: entry.message,
      detail: entry.detail,
      processId: entry.processId
    });
    expect(entry.error.debug()).toBe(entry.debug);
  }
});
