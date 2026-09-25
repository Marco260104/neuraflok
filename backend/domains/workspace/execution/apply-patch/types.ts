export interface AffectedPaths {
  added: string[];
  modified: string[];
  deleted: string[];
}

export type AppliedPatchFileChange =
  | { kind: 'add'; content: string; overwrittenContent: string | null }
  | { kind: 'delete'; content: string }
  | {
      kind: 'update';
      movePath: string | null;
      oldContent: string;
      overwrittenMoveContent: string | null;
      newContent: string;
    };

export interface AppliedPatchChange {
  path: string;
  change: AppliedPatchFileChange;
}

export interface AppliedPatchDelta {
  changes: AppliedPatchChange[];
  // False when a partial write makes the recorded changes uncertain.
  exact: boolean;
}
