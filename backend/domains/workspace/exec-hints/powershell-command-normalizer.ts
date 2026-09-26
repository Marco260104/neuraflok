import type { ShellType } from '../execution/shell.js';
import { hasUnsupportedShellLexemes } from '../exec-command-parser.js';
import { normalizeRipgrepSegment, type DirectoryLister } from './powershell-globs.js';
import type { NormalizedCommand } from './types.js';
import { rebuild } from './text-rebuild.js';

export function normalizeShellCommand(
  cmd: string,
  shellType: ShellType,
  list: DirectoryLister | null = null
): NormalizedCommand {
  if (shellType !== 'powershell') return { cmd, notes: [] };
  if (!/[*?{]/.test(cmd)) return { cmd, notes: [] };
  // This tokenizer intentionally does not implement PowerShell's backtick escape grammar. That is fine only while a backtick is absent. With one present, a visually separate token may actually be part of the same argument (`foo`<backtick>` bar*.ts`), a newline may be a continuation rather than a statement boundary, and an escaped quote/separator can change every split this normalizer makes. Rewriting around any of those would be silent command corruption, so the safe answer is to leave the entire line alone. A missed convenience rewrite costs one retry; a guessed parse can make a different command succeed.
  if (hasUnsupportedShellLexemes(cmd)) return { cmd, notes: [] };
  // Without a directory there is nothing to expand a glob against, and guessing is not available here: the point of the exercise is that the answer must be the shell's own. Brace expansion needs no directory — it is textual — so it still runs, against a listing that reports the one honest thing it can, which is that it knows of no entries.
  const entries: DirectoryLister = list ?? ((): readonly string[] => []);

  const notes: string[] = [];
  let changed = false;
  let statementIndex = 0;

  // Statements and pipeline segments are rebuilt with their own separators intact, so only the segments this file actually rewrote differ from the original text.
  const rebuilt = rebuild(cmd, [';', '&&', '||', '\n'], (statement) => {
    // Globs are expanded in the first statement only. Nothing has run yet at that point, so the directory listed here is the directory the shell would have expanded against; one statement later it is a guess about what the statements before it did to the cwd and to the files in it. Brace groups are not asking the filesystem anything and run throughout.
    const first = statementIndex++ === 0;
    return rebuild(statement, ['|'], (segment) => {
      const result = normalizeRipgrepSegment(segment.trim(), entries, first);
      if (result.notes.length === 0) return segment;
      changed = true;
      notes.push(...result.notes);
      // Keep the caller's surrounding whitespace so the rebuilt line still reads naturally.
      const [, lead = '', , trail = ''] = /^(\s*)([\s\S]*?)(\s*)$/.exec(segment) ?? [];
      return `${lead}${result.segment}${trail}`;
    });
  });

  return changed ? { cmd: rebuilt, notes: [...new Set(notes)] } : { cmd, notes: [] };
}
