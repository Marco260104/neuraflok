import { PatchParseError } from './errors.js';
import {
  ADD_FILE_MARKER,
  BEGIN_PATCH_MARKER,
  CHANGE_CONTEXT_MARKER,
  DELETE_FILE_MARKER,
  EMPTY_CHANGE_CONTEXT_MARKER,
  END_PATCH_MARKER,
  EOF_MARKER,
  MOVE_TO_MARKER,
  UPDATE_FILE_MARKER,
  type Hunk,
  type UpdateFileChunk,
  type UpdateFileHunk,
  cloneHunks,
  newUpdateFileChunk,
  pushContextLine
} from './hunk.js';

const ENVIRONMENT_ID_PREFIX = '*** Environment ID:';
const INVALID_HEADER = "is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'";
const INVALID_BODY_LINE = "Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)";

type ParseStage = 'before_start' | 'inside_patch' | 'adding_file' | 'deleting_file' | 'updating_file' | 'after_end';

export class StreamingPatchParser {
  private remainder = '';
  private stage: ParseStage = 'before_start';
  private readonly hunks: Hunk[] = [];
  private environmentValue: string | null = null;
  private lineNumber = 0;
  private updateHeaderLine = 0;

  environmentId(): string | null {
    return this.environmentValue;
  }

  pushDelta(delta: string): Hunk[] {
    let start = 0;
    while (true) {
      const newline = delta.indexOf('\n', start);
      if (newline < 0) break;
      let line = this.remainder + delta.slice(start, newline);
      this.remainder = '';
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.lineNumber += 1;
      this.readLine(line);
      start = newline + 1;
    }
    this.remainder += delta.slice(start);
    return cloneHunks(this.hunks);
  }

  finish(): Hunk[] {
    if (this.remainder !== '') {
      const line = this.remainder;
      this.remainder = '';
      this.lineNumber += 1;
      if (line.trim() === END_PATCH_MARKER) {
        this.completePreviousUpdate(line.trim());
        this.stage = 'after_end';
      } else {
        this.readLine(line);
      }
    }
    if (this.stage !== 'after_end') {
      throw PatchParseError.invalidPatch("The last line of the patch must be '*** End Patch'");
    }
    return cloneHunks(this.hunks);
  }

  private latestHunk(): Hunk | undefined {
    return this.hunks.at(-1);
  }

  private latestUpdate(): UpdateFileHunk | null {
    const hunk = this.latestHunk();
    return hunk?.kind === 'update_file' ? hunk : null;
  }

  private emptyChunk(chunk: UpdateFileChunk | undefined): boolean {
    return chunk !== undefined && chunk.oldLines.length === 0 && chunk.newLines.length === 0;
  }

  private completePreviousUpdate(nextLine: string): void {
    const update = this.latestUpdate();
    if (!update) return;
    if (update.chunks.length === 0 && this.stage === 'updating_file') {
      throw PatchParseError.invalidHunk(`Update file hunk for path '${update.path}' is empty`, this.updateHeaderLine);
    }
    if (!this.emptyChunk(update.chunks.at(-1))) return;
    if (nextLine === END_PATCH_MARKER) {
      throw PatchParseError.invalidHunk('Update hunk does not contain any lines', this.lineNumber);
    }
    throw PatchParseError.invalidHunk(
      `Unexpected line found in update hunk: '${nextLine}'. ${INVALID_BODY_LINE}`,
      this.lineNumber
    );
  }

  private consumeDirective(line: string): boolean {
    if (this.stage === 'inside_patch' && line.startsWith(ENVIRONMENT_ID_PREFIX)) {
      if (this.environmentValue !== null) {
        throw PatchParseError.invalidPatch('apply_patch environment_id cannot be specified more than once');
      }
      const value = line.slice(ENVIRONMENT_ID_PREFIX.length).trim();
      if (value === '') throw PatchParseError.invalidPatch('apply_patch environment_id cannot be empty');
      this.environmentValue = value;
      return true;
    }
    if (line === END_PATCH_MARKER) {
      this.completePreviousUpdate(line);
      this.stage = 'after_end';
      return true;
    }
    if (line.startsWith(ADD_FILE_MARKER)) {
      this.completePreviousUpdate(line);
      this.hunks.push({ kind: 'add_file', path: line.slice(ADD_FILE_MARKER.length), contents: '' });
      this.stage = 'adding_file';
      return true;
    }
    if (line.startsWith(DELETE_FILE_MARKER)) {
      this.completePreviousUpdate(line);
      this.hunks.push({ kind: 'delete_file', path: line.slice(DELETE_FILE_MARKER.length) });
      this.stage = 'deleting_file';
      return true;
    }
    if (line.startsWith(UPDATE_FILE_MARKER)) {
      this.completePreviousUpdate(line);
      this.hunks.push({ kind: 'update_file', path: line.slice(UPDATE_FILE_MARKER.length), movePath: null, chunks: [] });
      this.updateHeaderLine = this.lineNumber;
      this.stage = 'updating_file';
      return true;
    }
    return false;
  }

  private readLine(raw: string): void {
    const normalized = raw.trim();
    if (this.stage === 'before_start') {
      if (normalized !== BEGIN_PATCH_MARKER) {
        throw PatchParseError.invalidPatch("The first line of the patch must be '*** Begin Patch'");
      }
      this.stage = 'inside_patch';
      return;
    }
    if (this.stage === 'after_end') {
      if (normalized !== '') throw PatchParseError.invalidPatch("The last line of the patch must be '*** End Patch'");
      return;
    }

    const directive = this.stage === 'updating_file' ? raw.trimEnd() : normalized;
    if (this.consumeDirective(directive)) return;

    if (this.stage === 'inside_patch') {
      throw PatchParseError.invalidHunk(`'${normalized}' ${INVALID_HEADER}`, this.lineNumber);
    }
    if (this.stage === 'adding_file') {
      const hunk = this.latestHunk();
      if (raw.startsWith('+') && hunk?.kind === 'add_file') {
        hunk.contents += `${raw.slice(1)}\n`;
        return;
      }
      throw PatchParseError.invalidHunk(`'${normalized}' ${INVALID_HEADER}`, this.lineNumber);
    }
    if (this.stage === 'deleting_file') {
      throw PatchParseError.invalidHunk(`'${normalized}' ${INVALID_HEADER}`, this.lineNumber);
    }
    const update = this.latestUpdate();
    if (!update) {
      throw PatchParseError.invalidHunk(`Unexpected line found in update hunk: '${raw}'. ${INVALID_BODY_LINE}`, this.lineNumber);
    }
    this.readUpdateLine(update, raw, directive);
  }

  private readUpdateLine(update: UpdateFileHunk, raw: string, directive: string): void {
    const chunks = update.chunks;
    const last = chunks.at(-1);
    if (last?.isEndOfFile) {
      if (directive === '') return;
      if (directive !== EMPTY_CHANGE_CONTEXT_MARKER && !directive.startsWith(CHANGE_CONTEXT_MARKER)) {
        throw PatchParseError.invalidHunk(
          `Expected update hunk to start with a @@ context marker, got: '${raw}'`,
          this.lineNumber
        );
      }
    }
    if (chunks.length === 0 && update.movePath === null && directive.startsWith(MOVE_TO_MARKER)) {
      update.movePath = directive.slice(MOVE_TO_MARKER.length);
      return;
    }
    if ((directive === EMPTY_CHANGE_CONTEXT_MARKER || directive.startsWith(CHANGE_CONTEXT_MARKER)) && this.emptyChunk(last)) {
      throw PatchParseError.invalidHunk(
        `Unexpected line found in update hunk: '${raw}'. ${INVALID_BODY_LINE}`,
        this.lineNumber
      );
    }
    if (directive === EMPTY_CHANGE_CONTEXT_MARKER) {
      chunks.push(newUpdateFileChunk());
      return;
    }
    if (directive.startsWith(CHANGE_CONTEXT_MARKER)) {
      chunks.push({ ...newUpdateFileChunk(), changeContext: directive.slice(CHANGE_CONTEXT_MARKER.length) });
      return;
    }
    if (directive === EOF_MARKER) {
      if (this.emptyChunk(last)) throw PatchParseError.invalidHunk('Update hunk does not contain any lines', this.lineNumber);
      if (last) last.isEndOfFile = true;
      return;
    }
    const prefix = raw[0] ?? '';
    if (prefix === '' || prefix === ' ' || prefix === '+' || prefix === '-') {
      let chunk = chunks.at(-1);
      if (!chunk) {
        chunk = newUpdateFileChunk();
        chunks.push(chunk);
      }
      if (prefix === '+' || prefix === '-') {
        (prefix === '+' ? chunk.newLines : chunk.oldLines).push(raw.slice(1));
      } else {
        pushContextLine(chunk, raw.slice(1));
      }
      return;
    }
    if (last && (last.oldLines.length > 0 || last.newLines.length > 0)) {
      throw PatchParseError.invalidHunk(
        `Expected update hunk to start with a @@ context marker, got: '${raw}'`,
        this.lineNumber
      );
    }
    throw PatchParseError.invalidHunk(
      `Unexpected line found in update hunk: '${raw}'. ${INVALID_BODY_LINE}`,
      this.lineNumber
    );
  }
}
