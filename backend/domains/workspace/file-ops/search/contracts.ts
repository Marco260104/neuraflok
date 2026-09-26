/** Skipped by default because they are large and rarely what anyone means. The model can search them by passing an explicit exclude list (including an empty one), so nothing is permanently unreachable. */
export const DEFAULT_EXCLUDES: readonly string[] = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.gradle',
  '.gradle-user',
  '.idea',
  '.vs',
  '.vscode',
  '__pycache__',
  '.venv',
  'venv',
  'coverage',
  '.cache',
  '.turbo',
  '.go-build-cache',
  '.go-module-cache',
  '.go-tools',
  '.gopath',
  '.tmp',
  '.tmp-go-cache',
  '.tmp-go-path',
  // User-profile/tooling trees that are useful when explicitly opened, but extremely noisy when a model recursively searches a broad root such as a home directory. Because exclusions apply only to child folders, explicitly searching inside one of these paths still works normally.
  '.android',
  '.bun',
  '.claude',
  '.claude-*',
  '.codex',
  '.cursor',
  '.gemini',
  '.npm',
  '.pnpm-store',
  '.yarn',
  // Packaged application output is generated and routinely contains hundreds of Electron/runtime files. Source lives elsewhere and should win the default budget.
  'release',
  'release-*',
  'appdata'
];


export interface SearchHit {
  path: string;
  /** Present for content matches only. */
  line?: number;
  /** Trimmed matching line, for content matches only. */
  text?: string;
}

export interface SearchOutcome {
  hits: SearchHit[];
  filesScanned: number;
  truncated: boolean;
  /** Why the search stopped early, if it did. */
  stoppedBecause: 'limit' | 'time' | 'files' | 'size' | null;
  elapsedMs: number;
}

export interface SearchRequest {
  realDir: string;
  virtualDir: string;
  query: string;
  mode: 'name' | 'content';
  include?: string | undefined;
  exclude: readonly string[];
  caseSensitive: boolean;
  regex?: boolean;
  maxResults: number;
  /** Absolute whole-tool deadline shared by every approved root. */
  deadline?: number;
}
