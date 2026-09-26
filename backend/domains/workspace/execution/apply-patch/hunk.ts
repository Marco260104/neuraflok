export const BEGIN_PATCH_MARKER = '*** Begin Patch';
export const END_PATCH_MARKER = '*** End Patch';
export const ADD_FILE_MARKER = '*** Add File: ';
export const DELETE_FILE_MARKER = '*** Delete File: ';
export const UPDATE_FILE_MARKER = '*** Update File: ';
export const MOVE_TO_MARKER = '*** Move to: ';
export const EOF_MARKER = '*** End of File';
export const CHANGE_CONTEXT_MARKER = '@@ ';
export const EMPTY_CHANGE_CONTEXT_MARKER = '@@';

export interface UpdateFileChunk {
  changeContext: string | null;
  oldLines: string[];
  newLines: string[];
  contextLineIndices: Array<[number, number]>;
  isEndOfFile: boolean;
}

export function newUpdateFileChunk(): UpdateFileChunk {
  return {
    changeContext: null,
    oldLines: [],
    newLines: [],
    contextLineIndices: [],
    isEndOfFile: false
  };
}

export function pushContextLine(chunk: UpdateFileChunk, line: string): void {
  chunk.contextLineIndices.push([chunk.oldLines.length, chunk.newLines.length]);
  chunk.oldLines.push(line);
  chunk.newLines.push(line);
}

export interface AddFileHunk {
  kind: 'add_file';
  path: string;
  contents: string;
}

export interface DeleteFileHunk {
  kind: 'delete_file';
  path: string;
}

export interface UpdateFileHunk {
  kind: 'update_file';
  path: string;
  movePath: string | null;
  chunks: UpdateFileChunk[];
}

export type Hunk = AddFileHunk | DeleteFileHunk | UpdateFileHunk;

export function hunkPath(hunk: Hunk): string {
  return hunk.kind === 'update_file' && hunk.movePath !== null ? hunk.movePath : hunk.path;
}

export function cloneHunks(hunks: readonly Hunk[]): Hunk[] {
  return hunks.map(hunk => {
    if (hunk.kind !== 'update_file') return { ...hunk };
    return {
      ...hunk,
      chunks: hunk.chunks.map(chunk => ({
        ...chunk,
        oldLines: [...chunk.oldLines],
        newLines: [...chunk.newLines],
        contextLineIndices: chunk.contextLineIndices.map(([oldIndex, newIndex]): [number, number] => [oldIndex, newIndex])
      }))
    };
  });
}
