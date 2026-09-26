// Command-result analysis keeps exit codes truthful across shells.

import {
  NO_MATCH_MEANS_EXIT_1, hasUnsupportedShellLexemes, programName, splitTopLevel, stageIsPassive,
  stageProgramToken, statusDeterminingProgram, statusDeterminingToken, tokenize, type Token
} from './exec-command-parser.js';
import type { ShellType } from './execution/shell.js';

const SHELL_REFUSED = new RegExp(
  [
    // zsh can return 1 before rg starts (unmatched glob/redirection). A path-qualified search alone therefore cannot prove that exit 1 means "no matches" on POSIX.
    String.raw`^\s*(?:[^\s:]*\/)?(?:-?bash|-?zsh|dash|ksh|sh):`,
    String.raw`^\s*At line:\d+ char:\d+`,
    String.raw`The token '[^']*' is not a valid statement separator`,
    String.raw`ParserError`,
    String.raw`CommandNotFoundException`,
    String.raw`ParameterBindingException`,
    String.raw`is not recognized as (?:the name of )?a (?:cmdlet|command)`,
    String.raw`is not recognized as an internal or external command`,
    String.raw`The string (?:is missing the terminator|starting:)`,
    String.raw`Missing (?:argument|expression|closing|\))`
  ].join('|'),
  'im'
);

/** git subcommands that only report, and therefore cannot fail after printing. Each of these exits 0 whenever it produced output at all; the ways they exit non-zero are a `fatal:` on stderr with nothing on stdout, or one of the flags below being passed to turn the command into a test. Deliberately not a general list of "read-only programs": the property being relied on is not read-onlyness, it is that a normal run has exactly one exit code. */
const GIT_SUBCOMMANDS_THAT_ONLY_REPORT = new Set(['diff', 'log', 'show', 'status', 'blame']);

/** The flags that turn one of the above into a predicate, where exit 1 is the whole point. */
const GIT_FLAGS_THAT_MAKE_THE_EXIT_MEAN_SOMETHING = /^--(?:exit-code|quiet|check)$/i;

/** The one passive stage that stops the pipeline; `-Last` and the rest must drain it first. */
const TRUNCATING_STAGE = /^(?:select-object|select)\s+-first\s+\d+$/i;

/** The generator of a deciding pipeline that `Select-Object -First` cut short, if that is what this command is. `Select-Object -First N` stops the pipeline the moment it has N objects, which kills the native program still writing into it and leaves a non-zero status behind. Measured against Windows PowerShell 5.1: `git diff -- CHANGELOG.md | Select-Object -First 5` exits 1 where the same `git diff` alone exits 0, and `-Wait` — which drains the pipeline instead of stopping it — exits 0 again. Whether the cut actually bites depends on whether the program was still running when N was reached, so a short output exits 0 and a long one exits 1 from the same command. This does not say the exit was benign; it only names the generator, so the caller can ask whether that program had any other way to exit non-zero. The rest of the pipeline must be the passive shapes `statusDeterminingToken` already trusts, for the same reason it trusts them: a stage that could have set the status itself makes the question unanswerable. */
function pipelineStopCandidate(command: string): Token | null {
  if (hasUnsupportedShellLexemes(command)) return null;
  if (splitTopLevel(command, ['&&', '||']).length > 1) return null;
  const statements = splitTopLevel(command, [';', '\n']);
  const last = statements[statements.length - 1];
  if (last === undefined) return null;
  const segments = splitTopLevel(last, ['|']);
  if (segments.length < 2) return null;
  let truncates = false;
  for (let i = 1; i < segments.length; i++) {
    const segment = (segments[i] as string).trim();
    if (!stageIsPassive(segment)) return null;
    if (TRUNCATING_STAGE.test(segment)) truncates = true;
  }
  if (!truncates) return null;
  const generator = segments[0];
  if (generator === undefined) return null;
  return stageProgramToken(generator);
}

/** The subcommand a `git …` generator names, when the generator is git and the name is usable. The subcommand must be the token straight after `git`. `git -C dir diff` reads the same to a person and is refused here, because proving which token is the subcommand means knowing which of git's own options take a value, and being wrong about that is how `git -c x=y --exit-code` would slip through. Withholding the exemption from a form nobody recorded costs nothing. Null when a predicate flag is present, because exit 1 is then the answer the caller asked for rather than an absence of output, and no caller of this may treat it as one. Command-name lookup cannot be intercepted on this surface: exec.ts launches every exec_command through `powershell -NoProfile`, so unlike the bare `rg` case there is no profile function that could be answering to the name `git`. */
function gitGeneratorSubcommand(command: string): string | null {
  const statements = splitTopLevel(command, [';', '\n']);
  const last = statements[statements.length - 1];
  if (last === undefined) return null;
  const generator = splitTopLevel(last, ['|'])[0];
  if (generator === undefined) return null;
  const tokens = tokenize(generator);
  if (programName(tokens[0]) !== 'git') return null;
  const subcommand = tokens[1];
  if (subcommand === undefined) return null;
  if (tokens.some((argument) => GIT_FLAGS_THAT_MAKE_THE_EXIT_MEAN_SOMETHING.test(argument.value))) return null;
  return subcommand.value.toLowerCase();
}

/** Whether a cut pipeline's generator is a git command with no second reason to exit non-zero. */
function cutPipelineGeneratorOnlyReports(command: string): boolean {
  const token = pipelineStopCandidate(command);
  if (token === null) return false;
  if (programName(token) !== 'git') return cutPipelineGeneratorIsProvenSearch(token);
  const subcommand = gitGeneratorSubcommand(command);
  return subcommand !== null && GIT_SUBCOMMANDS_THAT_ONLY_REPORT.has(subcommand);
}

/** Whether the first pipeline stage is the one whose status the shell reported. `statusDeterminingToken` walks in from the right and stops at the first stage that could have set the status itself, so a generator only decides when everything after it is one of PowerShell's own passive shapes. Asking this separately is what keeps a git-subcommand read off the generator honest: without it, `git grep foo | git diff --exit-code` would have its predicate failure filed as a search that found nothing. */
function generatorDecidesStatus(command: string): boolean {
  const statements = splitTopLevel(command, [';', '\n']);
  const last = statements[statements.length - 1];
  if (last === undefined) return false;
  return splitTopLevel(last, ['|'])
    .slice(1)
    .every((segment) => stageIsPassive(segment.trim()));
}

/** A path-proven search generator whose own failures are visible in its output. */
function cutPipelineGeneratorIsProvenSearch(token: Token): boolean {
  if (!NO_MATCH_MEANS_EXIT_1.has(programName(token))) return false;
  return /[\\/]/.test(token.value);
}

/** Observed PowerShell native-pipeline cut statuses, including unsigned -1. */
const CUT_PIPELINE_EXIT_CODES = new Set([1, -1, 0xff_ff_ff_ff]);

/** A diagnostic line a search program printed about itself, rather than a match. */
const SEARCH_DIAGNOSTIC = /^\s*(rg|ripgrep|grep|egrep|fgrep|findstr):/im;

/** Command output with single-command response framing removed when present. */
function commandOutputBody(outputText: string): string[] {
  const lines = outputText.split('\n').map((line) => line.replace(/\r$/, ''));
  const start = lines.indexOf('Output:');
  return (start < 0 ? lines : lines.slice(start + 1)).filter(
    (line) => line.trim() !== '' && !line.startsWith('---') && !line.startsWith('Warning: truncated output')
  );
}

/** Whether a non-zero exit is a reported result rather than a failure. Both conditions matter. The program must be one that spends exit 1 on "no matches", and it must not have printed an error of its own — ripgrep given an unexpandable glob prints `rg: …: IO error …` and still exits 1, and that call really did fail. Checking the output is what keeps this from laundering the very failures fix (2) exists to surface. */
export function nonZeroExitIsBenign(
  command: string,
  exitCode: number | null,
  outputText: string
): boolean {
  if (exitCode === null) return false;
  // A shell refusal means the status cannot be interpreted as the child's result.
  if (SHELL_REFUSED.test(outputText)) return false;
  // A proven reporting generator cut by `Select-Object -First` can leave a native non-zero status.
  if (
    CUT_PIPELINE_EXIT_CODES.has(exitCode) &&
    cutPipelineGeneratorOnlyReports(command) &&
    commandOutputBody(outputText).length > 0 &&
    !/^\s*(?:fatal|error):/im.test(outputText) &&
    !SEARCH_DIAGNOSTIC.test(outputText)
  ) {
    return true;
  }
  // Partial matches cannot prove the requested search completed. Exit 2 includes missing/unreadable paths and read failures even when other paths yielded matches.
  if (exitCode !== 1) return false;
  const token = statusDeterminingToken(command);
  const program = programName(token ?? undefined);
  // `git grep` spends exit 1 on "found nothing" for the same reason ripgrep does, and is the spelling a model reaches for once it is already running git. It needs no path-qualified form to prove itself: `powershell -NoProfile` leaves no way for a profile function to be answering to the name `git`. It does need to be the stage that decided the status, and to have printed no diagnostic of its own — a bad pathspec is `fatal:` and exit 128, so this withholds nothing git actually produces, and costs nothing if git ever changes its mind.
  if (program === 'git') {
    return (
      gitGeneratorSubcommand(command) === 'grep' &&
      generatorDecidesStatus(command) &&
      !/^\s*(?:fatal|error):/im.test(outputText)
    );
  }
  if (!NO_MATCH_MEANS_EXIT_1.has(program)) return false;
  // A bare command name is not proof of which implementation ran. PowerShell profiles can define functions/aliases named `rg` and even `rg.exe`; cmd.exe searches the current directory before PATH and can pick up a local rg.cmd; POSIX shells have functions/aliases of their own. Any of those may exit 1 with no diagnostic for a reason unrelated to search results. A path-qualified token is the one representation the command text can actually prove. tools-core binds ordinary PowerShell/POSIX `rg` calls to the bundled executable before they reach this classifier, preserving the common no-match case without trusting names.
  const pathQualified = token !== null && /[\\/]/.test(token.value);
  if (!pathQualified) return false;
  return !/^\s*(rg|ripgrep|grep|egrep|fgrep|findstr):/im.test(outputText);
}

/** Binds a bare PowerShell/POSIX `rg`/`ripgrep` invocation to the binary the app deliberately ships. This project already parses ripgrep arguments against the bundled version's option table and prepends that binary's directory to child PATH. Leaving shell command-name lookup in front of it broke that contract: a function/alias named `rg` can win before PATH and both receive rewrites intended for ripgrep 15.2.0 and make its exit status impossible to attribute safely. A shell-quoted absolute path (plus PowerShell's call operator where needed) makes the intended binary explicit. Only a literal bare program token at a top-level statement/pipeline head is changed. Dynamic invocations, already-qualified paths, quoted strings and commands containing backtick escapes stay untouched; the latter cannot be split safely by this lightweight parser. */

/** What to say about a non-zero exit that was a reported result rather than a failure. The classification already existed and was spent only on the session's error count, so the model still read `Process exited with code 1` under an empty body and drew the obvious wrong conclusion — the measured consequence being re-runs of searches that had already answered. Both benign shapes are named, because nothing in the exit code tells them apart. */
export function benignExitNote(
  command: string,
  shellType: ShellType = 'powershell',
  exitCode?: number | null,
  outputText?: string
): string {
  // A search cut is only the better explanation once it actually printed matches.
  const cutGenerator =
    shellType === 'powershell' && cutPipelineGeneratorOnlyReports(command)
      ? pipelineStopCandidate(command)
      : null;
  const cutIsTheBetterStory =
    cutGenerator !== null &&
    (!cutPipelineGeneratorIsProvenSearch(cutGenerator) ||
      (outputText !== undefined && commandOutputBody(outputText).length > 0));
  if (cutGenerator !== null && cutIsTheBetterStory) {
    const program = programName(cutGenerator);
    return (
      `Exit code ${exitCode ?? 1} here is \`Select-Object -First\` stopping the pipeline, not a ` +
      `failure: it closes the pipe while \`${program}\` is still writing, and \`${program}\` has no other ` +
      'way to exit non-zero once it has printed. The output above is the first N objects and is ' +
      'complete for that window, so the command does not need to be run again. Add `-Wait` to ' +
      'the same stage to keep the exit code meaningful, at the cost of letting the command run ' +
      'to the end.'
    );
  }
  // Name the search the caller actually wrote. `git grep` decides its status as `git`, and a note reading "exit code 1 from `git`" would generalise to the git commands where 1 means something else entirely — which is the belief this note exists to prevent, not to spread.
  const deciding = statusDeterminingProgram(command);
  const program = deciding === 'git' ? `git ${gitGeneratorSubcommand(command) ?? ''}`.trim() : deciding;
  if (shellType !== 'powershell') {
    return (
      `Exit code 1 from \`${program}\` is a result, not a failure: this search program uses it ` +
      'when it finds no matches. Nothing went wrong, and the command does not need to be run again.'
    );
  }
  return (
    `Exit code 1 from \`${program}\` is a result, not a failure: it is what a search reports ` +
    'when it finds no matches, and also what it reports when a later stage such as ' +
    '`Select-Object -First` stops the pipeline early. Nothing went wrong, and the command does ' +
    'not need to be run again.'
  );
}

