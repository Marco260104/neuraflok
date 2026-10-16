export type UnifiedExecErrorKind =
  | 'create_process'
  | 'process_failed'
  | 'unknown_process_id'
  | 'write_to_stdin'
  | 'stdin_closed'
  | 'missing_command_line';

type ErrorPresentation = (detail: string | null, processId: number | null) => string;

interface ErrorDefinition {
  message: ErrorPresentation;
  debug: ErrorPresentation;
}

const ERROR_DEFINITIONS: Record<UnifiedExecErrorKind, ErrorDefinition> = {
  create_process: {
    message: detail => `Failed to create unified exec process: ${detail ?? ''}`,
    debug: detail => `CreateProcess { message: ${JSON.stringify(detail ?? '')} }`
  },
  process_failed: {
    message: detail => `Unified exec process failed: ${detail ?? ''}`,
    debug: detail => `ProcessFailed { message: ${JSON.stringify(detail ?? '')} }`
  },
  unknown_process_id: {
    message: (_detail, processId) => `Unknown process id ${processId ?? 0}`,
    debug: (_detail, processId) => `UnknownProcessId { process_id: ${processId ?? 0} }`
  },
  write_to_stdin: {
    message: () => 'failed to write to stdin',
    debug: () => 'WriteToStdin'
  },
  stdin_closed: {
    message: () => 'stdin is closed for this session; rerun exec_command with tty=true to keep stdin open',
    debug: () => 'StdinClosed'
  },
  missing_command_line: {
    message: () => 'missing command line for unified exec request',
    debug: () => 'MissingCommandLine'
  }
};

export class UnifiedExecError extends Error {
  readonly kind: UnifiedExecErrorKind;
  readonly processId: number | null;
  readonly detail: string | null;

  private constructor(kind: UnifiedExecErrorKind, detail: string | null = null, processId: number | null = null) {
    super(ERROR_DEFINITIONS[kind].message(detail, processId));
    this.name = 'UnifiedExecError';
    this.kind = kind;
    this.detail = detail;
    this.processId = processId;
  }

  static createProcess(detail: string): UnifiedExecError {
    return new UnifiedExecError('create_process', detail);
  }

  static processFailed(detail: string): UnifiedExecError {
    return new UnifiedExecError('process_failed', detail);
  }

  static unknownProcessId(processId: number): UnifiedExecError {
    return new UnifiedExecError('unknown_process_id', null, processId);
  }

  static writeToStdin(): UnifiedExecError {
    return new UnifiedExecError('write_to_stdin');
  }

  static stdinClosed(): UnifiedExecError {
    return new UnifiedExecError('stdin_closed');
  }

  static missingCommandLine(): UnifiedExecError {
    return new UnifiedExecError('missing_command_line');
  }

  debug(): string {
    return ERROR_DEFINITIONS[this.kind].debug(this.detail, this.processId);
  }
}
