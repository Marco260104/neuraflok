import { RIPGREP_NAMES, RG_BOOLEAN_FLAGS, RG_NO_PATTERN_FLAGS, RG_PATTERN_FLAGS, RG_VALUE_FLAGS, programName, tokenize, type Token } from '../exec-command-parser.js';

/** Whether a token is a glob this file is willing to expand. A quoted glob was deliberately protected from the shell and is left exactly as protected. A relative child path may name one exact directory beneath the command workdir; absolute paths, parent traversal and globs in the directory portion remain ineligible so normalization never pre-reads a broader or guessed location. */
function isExpandableGlob(token: Token): boolean {
  if (token.quoted) return false;
  if (!/[*?]/.test(token.value)) return false;
  if (token.value.startsWith('-')) return false;
  // A bracket class is pathname expansion this does not implement — the matcher below escapes `[` and `]` into literals, so `a[12]*.ts` would match a file actually *named* with those brackets while the shell would have matched `a1.ts` and `a2.ts`. Answering a different question and reporting success is worse than not answering, so it is not answered.
  if (/[[\]]/.test(token.value)) return false;
  // `$env:X` and other expansions are the shell's business, not ours.
  return !token.value.includes('$');
}

interface GlobLocation {
  /** Normalized relative directory handed to the trusted lister. */
  directory: string;
  /** Original spelling, including its final slash, preserved in the rebuilt arguments. */
  prefix: string;
  /** Filename-only glob matched against that directory's immediate entries. */
  leaf: string;
}

/** The one exact directory and filename pattern a bounded operand names. */
function globLocation(pattern: string): GlobLocation | null {
  const slash = Math.max(pattern.lastIndexOf('/'), pattern.lastIndexOf('\\'));
  if (slash < 0) return { directory: '.', prefix: '', leaf: pattern };

  const prefix = pattern.slice(0, slash + 1);
  const rawDirectory = pattern.slice(0, slash);
  const leaf = pattern.slice(slash + 1);
  // Drive/UNC/rooted paths are outside this pre-execution convenience's authority. The command still runs unchanged and may access them under the command capability's existing contract.
  if (/^(?:[A-Za-z]:|[\\/])/.test(pattern)) return null;
  if (leaf === '' || /[\\/]/.test(leaf)) return null;

  const segments = rawDirectory.split(/[\\/]/);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === '' || segment === '..' || /[*?\[\]{}$:'"`]/.test(segment))
  ) {
    return null;
  }
  const directory = segments.filter((segment) => segment !== '.').join('/');
  return { directory: directory === '' ? '.' : directory, prefix, leaf };
}

/** Re-quotes an expanded name for the shell, so it reaches the program verbatim. */
export function quoteArgument(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The expanded names, as a note can carry them. Naming them is what lets the caller check what the search actually ran against, and a hundred filenames on one line is not checkable — so past a dozen the note gives the count and the head. Only the note is shortened; the command received every name. */
const NAMES_SHOWN_IN_NOTE = 12;
function listExpandedNames(names: readonly string[]): string {
  if (names.length <= NAMES_SHOWN_IN_NOTE) return names.join(', ');
  return `${names.slice(0, NAMES_SHOWN_IN_NOTE).join(', ')} … and ${names.length - NAMES_SHOWN_IN_NOTE} more`;
}

/** One brace group of plain alternatives, e.g. `src/{main,test}/x`. Deliberately one group and nothing clever inside it. A brace group is also PowerShell's script-block syntax, so the pattern has to be narrow enough that `Where-Object { $_ -eq 1 }` can never match it: no whitespace (the tokenizer already split on that), no `$`, no nested braces, no quotes, and a comma is required — a lone `{...}` is far more likely to be a block than a path. Anything outside that shape is left exactly as written. */
const BRACE_ALTERNATIVES = /^([^{}$'"`|;]*)\{([^{}$'"`|;,]*(?:,[^{}$'"`|;,]*)+)\}([^{}$'"`|;]*)$/;

/** The paths a bash-style brace group stands for, in the order bash would produce them. Purely textual, exactly as the shell it stands in for: the names are not checked against the disk, because bash does not check either and a caller who typed a path that is not there is owed ripgrep's own "no such file" rather than a silently shortened list. Which is also why a group holding a wildcard is refused outright. bash expands braces and *then* expands the wildcards in what came out; this does only the first half, and quotes what it produces so it reaches the program verbatim. Half of a two-stage expansion is not a smaller fix, it is a worse failure: `{*.ts,*.js}` would become two quoted wildcards that ripgrep cannot open, where the untouched group at least fails as the shell's own. */
function expandBraces(token: Token): string[] | null {
  if (token.quoted) return null;
  if (token.value.startsWith('-')) return null;
  const match = BRACE_ALTERNATIVES.exec(token.value);
  if (!match) return null;
  const [, prefix = '', body = '', suffix = ''] = match;
  const parts = body.split(',');
  if (parts.length < 2 || parts.length > MAX_EXPANDED_NAMES) return null;
  const names = parts.map((part) => `${prefix}${part}${suffix}`);
  // The second stage is not ours to run, so a group that would still need it is not ours to touch. Both halves of the group are judged, not just the one that happens to carry the wildcard: expanding `{main,test/*}` partly would be the same trap. A bracket class is pathname expansion too — `{[ab].ts,c.ts}` needs the same second stage as a `*` does.
  if (names.some((name) => /[*?[]/.test(name))) return null;
  return names;
}

/** The most names one glob may turn into. The bound is the command line's length limit, and 48 was well under it: a test directory of 71 files made `test/*.test.ts` fall past this, and what the caller then got was not the hint but ripgrep's `os error 123` on a literal asterisk — the exact failure this expansion exists to remove. 128 quoted relative paths is a few KB against PowerShell's ~32 KB, so the limit now sits where the real constraint is rather than ahead of it. The wall-of-filenames problem was the *note's*, and `listExpandedNames` is where that belongs. */
const MAX_EXPANDED_NAMES = 128;

/** Lists one validated relative directory's immediate entry names for glob expansion. */
export type DirectoryLister = (relativeDirectory?: string) => readonly string[];

/** The entries of the exact relative directory this glob names, in shell expansion order. The directory portion is validated by `globLocation`: it cannot be absolute, traverse a parent, or contain expansion syntax of its own. Leading dots are excluded unless the leaf pattern itself begins with one, which is the POSIX rule the caller was writing to. An empty result is not an expansion. A shell that matches nothing passes the pattern through untouched, and so does this: the command then fails exactly as it would have, and the hint explains it. Substituting nothing would instead silently search the whole tree. */
function expandGlob(pattern: string, list: DirectoryLister): { hits: string[]; directory: string } | null {
  const location = globLocation(pattern);
  if (location === null) return null;
  let entries: readonly string[];
  try {
    entries = list(location.directory);
  } catch {
    return null;
  }
  const source = location.leaf
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^\\\\/]*')
    .replace(/\?/g, '[^\\\\/]');
  // Case-insensitively, which is how Windows matches filenames and therefore how the shell being stood in for would have matched them.
  const matcher = new RegExp(`^${source}$`, 'i');
  // POSIX hides a leading dot from a pattern that does not have one, and only then. A pattern written with the dot is asking for those files by name.
  const hidden = location.leaf.startsWith('.');
  const hits = entries
    .filter((entry) => !/[\\/]/.test(entry) && (hidden || !entry.startsWith('.')) && matcher.test(entry))
    .sort()
    .map((entry) => `${location.prefix}${entry}`);
  if (hits.length === 0 || hits.length > MAX_EXPANDED_NAMES) return null;
  return { hits, directory: location.directory };
}

/** `allowGlob` is false for every statement after the first. A glob has to be expanded against the directory the shell would have used, and one statement later that is a guess about what the statements before it did. Brace expansion carries no such debt — it is pure text, cwd and filesystem play no part — so it stays on for the whole command line. */
export function normalizeRipgrepSegment(
  segment: string,
  list: DirectoryLister,
  allowGlob: boolean
): { segment: string; notes: string[] } {
  const tokens = tokenize(segment);
  if (!RIPGREP_NAMES.has(programName(tokens[0]))) return { segment, notes: [] };

  const notes: string[] = [];
  const out: string[] = [tokens[0]?.raw ?? ''];
  let seenPattern = false;
  let skipValue = false;
  let optionsEnded = false;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i] as Token;
    if (skipValue) {
      skipValue = false;
      out.push(token.raw);
      continue;
    }
    if (!optionsEnded && token.value === '--') {
      // Unlike an unknown flag, `--` has exact arity: it consumes nothing and makes every following token positional. Refusing the whole segment here left the most explicit spelling of `rg -- pattern *.ts` broken on PowerShell even though the token boundaries after the delimiter are *more* knowable than without it.
      optionsEnded = true;
      out.push(token.raw);
      continue;
    }
    if (!optionsEnded && token.value.startsWith('-')) {
      const flag = token.value.split('=')[0] as string;
      // An option this table does not know may or may not swallow the next argument, and the two readings disagree about which token is the pattern and which is a path. Neither reading is safe to act on, so nothing in this segment is rewritten. A bare `-` still lands here because it names stdin; `--` is handled above because its arity and effect on every following token are exact.
      if (!RG_VALUE_FLAGS.has(flag) && !RG_BOOLEAN_FLAGS.has(flag)) return { segment, notes: [] };
      // `--glob=*.md` carries its value inline and consumes nothing after it.
      if (RG_VALUE_FLAGS.has(token.value) && !token.value.includes('=')) skipValue = true;
      if (RG_PATTERN_FLAGS.has(flag) || RG_NO_PATTERN_FLAGS.has(flag)) seenPattern = true;
      out.push(token.raw);
      continue;
    }
    if (!seenPattern) {
      // The search pattern itself. `*` is a regex quantifier here, never a filename glob.
      seenPattern = true;
      out.push(token.raw);
      continue;
    }
    const braced = expandBraces(token);
    if (braced) {
      out.push(...braced.map(quoteArgument));
      notes.push(
        `PowerShell has no brace expansion, so \`${token.value}\` reached ripgrep as one literal name. ` +
          `It was expanded here to the ${braced.length} paths bash would have produced: ${listExpandedNames(braced)}.`
      );
      continue;
    }
    const expanded = allowGlob && isExpandableGlob(token) ? expandGlob(token.value, list) : null;
    if (expanded) {
      out.push(...expanded.hits.map(quoteArgument));
      notes.push(
        `PowerShell does not expand globs for native programs, so \`${token.value}\` was expanded here to ` +
          `${expanded.hits.length === 1 ? 'the one entry' : `the ${expanded.hits.length} entries`} of the ` +
          `${expanded.directory === '.' ? 'working directory' : `relative directory ${expanded.directory}`} ` +
          `matching it: ${listExpandedNames(expanded.hits)}. Sub-directories were not searched, exactly as ` +
          `the glob asked; use \`-g '${token.value}'\` if a recursive match was what you meant.`
      );
      continue;
    }
    out.push(token.raw);
  }

  return { segment: out.join(' '), notes };
}
