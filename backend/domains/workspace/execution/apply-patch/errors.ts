export type ParseFailureKind = 'invalid_patch' | 'invalid_hunk';

export class PatchParseError extends Error {
  readonly kind: ParseFailureKind;
  readonly detail: string;
  readonly lineNumber: number;

  private constructor(kind: ParseFailureKind, detail: string, lineNumber: number, message: string) {
    super(message);
    this.name = 'PatchParseError';
    this.kind = kind;
    this.detail = detail;
    this.lineNumber = lineNumber;
  }

  static invalidPatch(detail: string): PatchParseError {
    return new PatchParseError('invalid_patch', detail, 0, `invalid patch: ${detail}`);
  }

  static invalidHunk(detail: string, lineNumber: number): PatchParseError {
    return new PatchParseError(
      'invalid_hunk',
      detail,
      lineNumber,
      `invalid hunk at line ${lineNumber}, ${detail}`
    );
  }
}

export type PatchFailureKind = 'parse' | 'io' | 'compute_replacements' | 'path' | 'implicit_invocation';

export class ApplyPatchError extends Error {
  readonly kind: PatchFailureKind;
  readonly context: string | undefined;
  readonly sourceContext: string | undefined;

  private constructor(
    kind: PatchFailureKind,
    message: string,
    context?: string,
    cause?: unknown,
    sourceContext?: string
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ApplyPatchError';
    this.kind = kind;
    this.context = context;
    this.sourceContext = sourceContext;
  }

  static fromParseError(error: PatchParseError): ApplyPatchError {
    return new ApplyPatchError('parse', error.message, undefined, error);
  }

  static io(context: string, source: unknown): ApplyPatchError {
    const detail = source instanceof Error ? source.message : String(source);
    return new ApplyPatchError('io', `${context}: ${detail}`, context, source);
  }

  static computeReplacements(message: string, sourceContext?: string): ApplyPatchError {
    return new ApplyPatchError('compute_replacements', message, undefined, undefined, sourceContext);
  }

  static path(message: string, cause?: unknown): ApplyPatchError {
    return new ApplyPatchError('path', message, undefined, cause);
  }

  static implicitInvocation(): ApplyPatchError {
    return new ApplyPatchError(
      'implicit_invocation',
      'patch detected without explicit call to apply_patch. Rerun as ["apply_patch", "<patch>"]'
    );
  }
}
