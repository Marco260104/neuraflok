export type ProjectGitStatus = 'M' | 'A' | 'D' | 'R' | 'U';

export type ProjectGitChange = {
  status: ProjectGitStatus;
  path: string;
  previousPath?: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
};

export type ProjectGitBranch = {
  ref: string;
  label: string;
};

export type ProjectGitComparison = {
  ref: string;
  label: string;
  baseOid: string;
  headOid: string;
};

export type ProjectGitSnapshot = {
  projectId: string;
  state: 'ready' | 'not-repository' | 'unavailable';
  changes: ProjectGitChange[];
  truncated: boolean;
  revision: string;
  currentBranch?: string;
  branches?: ProjectGitBranch[];
  branchesTruncated?: boolean;
  comparison?: ProjectGitComparison;
  message?: string;
};

export type ProjectGitDiff = ProjectGitChange & {
  projectId: string;
  tooLarge: boolean;
  baseText: string | null;
  currentText: string | null;
  note?: string;
};

export type ProjectGitChanged = Pick<ProjectGitSnapshot, 'projectId'>;
