import { PatchParseError } from './errors.js';
import { BEGIN_PATCH_MARKER, END_PATCH_MARKER, type Hunk } from './hunk.js';
import { StreamingPatchParser } from './streaming-parser.js';

export interface ApplyPatchArgs {
  patch: string;
  hunks: Hunk[];
  workdir: string | null;
  environmentId: string | null;
}

type InputMode = 'strict' | 'lenient';

function readLines(input: string): string[] {
  const lines = input.trim().split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
}

function validatePatchBounds(lines: readonly string[]): readonly string[] {
  const first = lines.at(0)?.trim();
  const last = lines.at(-1)?.trim();
  if (first === BEGIN_PATCH_MARKER && last === END_PATCH_MARKER) return lines;
  if (first !== undefined && first !== BEGIN_PATCH_MARKER) {
    throw PatchParseError.invalidPatch("The first line of the patch must be '*** Begin Patch'");
  }
  throw PatchParseError.invalidPatch("The last line of the patch must be '*** End Patch'");
}

function removeHereDocument(lines: readonly string[]): readonly string[] | null {
  const opening = lines[0];
  const closing = lines.at(-1);
  const supportedOpeners = ['<<EOF', "<<'EOF'", '<<"EOF"'];
  if (lines.length < 4 || opening === undefined || !supportedOpeners.includes(opening)) return null;
  if (closing === undefined || !closing.endsWith('EOF')) return null;
  return lines.slice(1, -1);
}

function readPatchLines(input: string, mode: InputMode): readonly string[] {
  const lines = readLines(input);
  try {
    return validatePatchBounds(lines);
  } catch (error) {
    if (mode !== 'lenient' || !(error instanceof PatchParseError)) throw error;
    const unwrapped = removeHereDocument(lines);
    if (unwrapped === null) throw error;
    return validatePatchBounds(unwrapped);
  }
}

export function parsePatch(patch: string): ApplyPatchArgs {
  return parsePatchText(patch, 'lenient');
}

export function parsePatchText(patch: string, mode: InputMode): ApplyPatchArgs {
  const lines = readPatchLines(patch, mode);
  const normalized = lines.join('\n');
  const parser = new StreamingPatchParser();
  parser.pushDelta(normalized);

  return {
    patch: normalized,
    hunks: parser.finish(),
    workdir: null,
    environmentId: parser.environmentId()
  };
}
