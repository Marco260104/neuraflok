import { defaultUserShell, isWindowsPowerShell5 } from './shell.js';

const IS_WINDOWS = process.platform === 'win32';

// Detect legacy Windows PowerShell separately from newer shells.
export const LAUNCHES_WINDOWS_POWERSHELL_5 = IS_WINDOWS && isWindowsPowerShell5(defaultUserShell().shellPath);

export const WINDOWS_SHELL_GUIDANCE = `Windows command guidance:
- Use one shell for a destructive file operation. Check the resolved target before recursively deleting or moving files.
- Prefer PowerShell file commands with \`-LiteralPath\` when operating on paths.
- Start background helpers with \`-WindowStyle Hidden\` unless the user asked to see an interactive window.`;

// Keep browser automation within a small set of reusable windows.
export const BROWSER_LAUNCH_GUIDANCE =
  'Browser work: reuse an existing window and profile when possible. Avoid opening a new browser or debug port for each retry.';

export const EXEC_COMMAND_DESCRIPTION = IS_WINDOWS
  ? `Runs a local shell command. Short commands return output; long-running commands return a session ID for follow-up with write_stdin.\n\n${WINDOWS_SHELL_GUIDANCE}\n\n${BROWSER_LAUNCH_GUIDANCE}`
  : `Runs a local shell command. Short commands return output; long-running commands return a session ID for follow-up with write_stdin.\n\n${BROWSER_LAUNCH_GUIDANCE}`;

export const EXEC_COMMAND_CMD_DESCRIPTION = LAUNCHES_WINDOWS_POWERSHELL_5
  ? 'One shell command. Use read to inspect files. Windows PowerShell 5.1 does not support && or ||; use cmds for a sequence or a PowerShell conditional.'
  : 'One shell command. Use read to inspect files instead of printing file contents through the shell.';

export const EXEC_COMMAND_CMDS_DESCRIPTION =
  'Run several commands in order in one shell session. Choose cmd or cmds, not both. Ordinary non-zero exits do not stop the sequence; the first non-zero exit code becomes the overall status.';

export const EXEC_COMMAND_WORKDIR_DESCRIPTION = 'Working directory for the command. Defaults to the current turn directory.';

export const EXEC_COMMAND_TTY_DESCRIPTION =
  'True allocates a pseudo-terminal for interactive commands; false or omitted uses plain pipes.';

export const EXEC_COMMAND_YIELD_TIME_DESCRIPTION = IS_WINDOWS
  ? 'Initial wait in milliseconds. Defaults to 10000 and is clamped to 250-30000. Finished commands return immediately; long-running commands return a session ID.'
  : 'Initial wait in milliseconds. Defaults to 10000 and is clamped to 250-30000. Finished commands return immediately; long-running commands return a session ID.';

// Describe the model-visible limit while retaining the workspace safety ceiling.
export const MAX_OUTPUT_TOKENS_DESCRIPTION =
  'Maximum model-visible output tokens. Defaults to 10000 and is capped by workspace policy.';

export const EXEC_COMMAND_SHELL_DESCRIPTION = "Shell binary to launch. Defaults to the user's configured shell.";

export const EXEC_COMMAND_LOGIN_DESCRIPTION =
  IS_WINDOWS
    ? 'Load the shell profile when true. Defaults to false on Windows for repeatable commands.'
    : 'Run the shell as a login or interactive shell when true. Defaults to true.';

export const WRITE_STDIN_DESCRIPTION =
  'Poll or write to a returned session ID. Empty chars read available output; completed sessions retain their final output and reject input. This tool never reruns a command.';

export const WRITE_STDIN_SESSION_ID_DESCRIPTION = 'Session ID returned by exec_command.';

export const WRITE_STDIN_CHARS_DESCRIPTION =
  'Text to write to the process input. Leave empty to poll without writing.';

export const WRITE_STDIN_YIELD_TIME_DESCRIPTION =
  'Wait for output before returning. Writes default to 250 ms and cap at 30000 ms; empty polls wait longer and return early when output arrives.';

// Describe the patch syntax accepted by the JSON-based tool input.
export const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF`;

export const APPLY_PATCH_DESCRIPTION = `The \`apply_patch\` tool edits files within the approved workspace. Pass the patch body in the \`patch\` field and follow this grammar.

Within each Update File block, put edits in file order. Quote the current file text for old/context lines; matching searches forward and does not reconstruct reformatted code. On a mismatch, use the diagnostic to correct the patch before retrying.

The patch must match this grammar:

${APPLY_PATCH_LARK_GRAMMAR}`;

export const APPLY_PATCH_ARGUMENT_DESCRIPTION =
  'Complete patch text, including the Begin Patch and End Patch markers.';
