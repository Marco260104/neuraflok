import { programName, tokenize, type Token } from '../../workspace/exec-command-parser.js';
import { locatedPath, locatedTitle } from './summary-format.js';

const READERS = new Set(['cat', 'type', 'get-content', 'gc', 'more', 'less', 'head', 'tail', 'bat']);
const LISTERS = new Set(['ls', 'dir', 'get-childitem', 'gci', 'll', 'tree']);
const SEARCHERS = new Set(['rg', 'ripgrep', 'grep', 'egrep', 'fgrep', 'findstr', 'find', 'select-string', 'sls']);
const WRITERS = new Set(['set-content', 'add-content', 'out-file', 'tee-object', 'tee']);
const DELETERS = new Set(['rm', 'del', 'remove-item', 'rmdir', 'rd', 'erase', 'unlink']);
const MAKERS = new Set(['mkdir', 'md']);
const COPIERS = new Set(['cp', 'copy', 'copy-item', 'xcopy']);
const MOVERS = new Set(['mv', 'move', 'move-item', 'ren', 'rename', 'rename-item']);
const PACKAGE_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx']);
const TEST_RUNNERS = new Set(['pytest', 'vitest', 'jest', 'mocha', 'ava']);

function firstLine(script: string): string {
  for (const line of script.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) return trimmed.replace(/\s+/g, ' ');
  }
  return '';
}

function operandPath(tokens: Token[]): string | null {
  for (const token of tokens.slice(1)) {
    if (!token.quoted && token.value.startsWith('-')) continue;
    if (!token.quoted && token.value.startsWith('/')) {
      if (/^\/[a-z]$/i.test(token.value)) continue;
    }
    if (token.value.startsWith('-') && !token.quoted) continue;
    if (/[*?]/.test(token.value) && !token.quoted) continue;
    if (/[\\/]/.test(token.value) || /\.[A-Za-z0-9]{1,8}$/.test(token.value)) return token.value;
  }
  return null;
}

function locate(path: string): string {
  return locatedTitle('', path).trim();
}

function listingFolder(path: string | null): string | null {
  if (!path) return null;
  const { file, folder } = locatedPath(path);
  if (/\.[A-Za-z0-9]{1,8}$/.test(file)) return folder;
  return file || folder;
}

/** Past-tense activity line for a shell command. Never returns the raw argv. */
export function commandActivityTitle(script: string | null): string {
  const line = firstLine(script ?? '');
  if (!line) return 'Ran a command';
  const tokens = tokenize(line);
  const program = programName(tokens[0]);
  const path = operandPath(tokens);
  const located = path ? locate(path) : '';

  if (READERS.has(program) && located) return `Read ${located}`;
  if (LISTERS.has(program)) {
    const folder = listingFolder(path);
    return folder ? `Listed files in ${folder}` : 'Listed files';
  }
  if (SEARCHERS.has(program)) return located ? `Searched ${located}` : 'Searched files';
  if (WRITERS.has(program) && located) return `Edited ${located}`;
  if (DELETERS.has(program) && located) return `Deleted ${located}`;
  if (DELETERS.has(program)) return 'Deleted files';
  if (MAKERS.has(program)) return located ? `Created ${located}` : 'Created a folder';
  if (COPIERS.has(program) && located) return `Copied ${located}`;
  if (MOVERS.has(program) && located) return `Moved ${located}`;

  if (PACKAGE_RUNNERS.has(program)) {
    const args = tokens.slice(1).map((token) => token.value.toLowerCase());
    if (args[0] === 'test' || (args[0] === 'run' && args[1] === 'test')) return 'Ran tests';
    if (args[0] === 'run' && args[1] === 'build') return 'Ran the build';
    if (args[0] === 'run' && args[1]) return `Ran the ${args[1]} script`;
    if (args[0] === 'i' || args[0] === 'install' || args[0] === 'ci') return 'Ran package install';
    return 'Ran a package command';
  }
  if (TEST_RUNNERS.has(program) || (program === 'go' && tokens[1]?.value === 'test')) return 'Ran tests';
  if (program === 'python' || program === 'python3' || program === 'py') {
    const args = tokens.slice(1).map((token) => token.value.toLowerCase());
    if (args.includes('pytest') || (args[0] === '-m' && args[1] === 'pytest')) return 'Ran tests';
  }
  if (program === 'cargo') {
    const sub = tokens[1]?.value.toLowerCase() ?? '';
    if (sub === 'test') return 'Ran tests';
    if (sub === 'build') return 'Ran the build';
  }
  if (program === 'make' || program === 'ninja' || program === 'cmake' || program === 'msbuild') return 'Ran the build';
  if (program === 'git') {
    const sub = tokens[1]?.value.toLowerCase() ?? '';
    if (sub === 'status') return 'Checked git status';
    if (sub === 'diff') return 'Checked git diff';
    if (sub === 'log') return 'Read git history';
    if (sub === 'add') return 'Staged git files';
    return sub ? `Ran git ${sub}` : 'Ran git';
  }
  if (program === 'get-process') return 'Listed processes';
  if (program === 'write-output' || program === 'echo') return 'Wrote output';
  return 'Ran a command';
}
