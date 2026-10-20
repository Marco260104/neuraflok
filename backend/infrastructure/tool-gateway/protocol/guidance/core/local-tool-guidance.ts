import { LAUNCHES_WINDOWS_POWERSHELL_5 } from '../../../../../domains/workspace/execution/tool-specs.js';
import type { ToolContext } from '../../kernel.js';
import type { getConfig } from '../../../../settings/config.js';
import type { CoreWorkspaceContext } from './workspace-context.js';

export function localToolGuidance(
  ctx: ToolContext,
  config: ReturnType<typeof getConfig>,
  workspace: CoreWorkspaceContext
): string[] {
  const lines = [
    '# Local tools',
    'Use the local tools listed in this provider conversation for files, terminal, plans and workers.',
    `Host: ${workspace.host}. Roots: ${workspace.roots}`,
    `Current Core authority (informational; live guards decide): ${workspace.authority}; read-only=${ctx.readOnly ? 'on' : 'off'}; plans=${workspace.sessionTools ? 'on' : 'off'}; workers=${workspace.agentTools ? 'on' : 'off'}.`,
    ctx.readOnly ? 'The local tools are read-only.' : 'Use the tools listed in this conversation.',
    ...(workspace.writable || workspace.executable ? [`You can always use ${[workspace.writable && 'file writing', workspace.executable && 'exec_command'].filter(Boolean).join(' and ')} in NEURAFLOK. Report the exact refusal instead of guessing which system blocked a call.`] : []),
    'Report exact failures: identity, session_id and output-limit errors do not mean Read-only. Never replay successful patches or commands to recover a terminal.',
    'A provider or local tool may refuse an action. Preserve the exact error, check for side effects, and never replay an ambiguous mutation.',
    'Unattributed is recording status, not permission. With Allow unattributed calls enabled, the request id owns its workspace, plan, terminals and agent family until exact chat proof arrives. A missing target limits that operation only; keep using enabled tools.',
    'Use full project paths under an approved root, including intermediate folders. Virtual or absolute native paths work; linked projects also accept relative paths.'
  ];
  const { caps } = ctx;
  if (caps.read || caps.browse || caps.metadata) lines.push(
    'read batches paths, lists folders, expands globs and returns numbered text. Read whole files for orientation; otherwise use known regions. A start_line/end_line range applies to every file the call reads.'
  );
  if (caps.read) lines.push('view_image inspects a local image. Use it when visual evidence matters.');
  if (caps.command) {
    lines.push(
      'Use rg or rg --files for searches; if unavailable, use the next best tool. Prefer rg -g \'*.ts\' backend over shell globs.',
      'exec_command is enabled. Batch checks with exec_command cmds: [...]: one shell, per-command output and exit codes.',
      'Set workdir to the project virtual path. Inside cmd use relative or native paths only. Never put the virtual project path inside cmd.',
      'write_stdin accepts session_id (running) or completed_session_id (finished). Completed reads replay output without rerunning work. Inspect exit/output; benign_exit marks an expected non-zero result.',
      'If output is truncated, narrow the command or read the relevant region.'
    );
    if (workspace.windows) lines.push(
      'PowerShell does not expand * or ? for native programs. Regex \\x22 matches double quotes. Use script files for complex JavaScript; nested -Command/-e can corrupt quotes or expand variables. Pipe loops as @(foreach (...) { ... }) | Format-Table.',
      'rg/ripgrep uses the bundled executable. Omit 2>&1 on native programs in PowerShell: stderr is captured; redirecting it can leave $? false after exit 0.',
      ...(LAUNCHES_WINDOWS_POWERSHELL_5 ? ['This is Windows PowerShell 5.1, without && or ||. Use cmds or A; if ($?) { B }.'] : [])
    );
    else lines.push('exec_command uses the host’s normal POSIX shell (zsh/bash/sh unless requested otherwise). The bundled ripgrep directory is first on PATH.');
    if (config.commandAllowlist.enabled) lines.push(
      `Command launch policy is enabled in ${config.commandAllowlist.mode === 'deny' ? 'denylist' : 'allowlist'} mode. COMMAND_NOT_ALLOWED is the user\'s launch policy, not Read-only mode or an internal failure. Do not evade it through another tool, alternate spelling or apply_patch interception; ask the user to change Settings. Programs permitted to start remain trusted after launch, including stdin, child processes and project code.`
    );
  } else if (ctx.exposedFind ?? caps.search) {
    lines.push('find searches filenames or file contents without a shell. Narrow path and include patterns to the relevant area.');
  }
  if (caps.create || caps.edit || caps.move || caps.deleteFile) lines.push(
    'apply_patch enables atomic add/update/move/delete within approved roots and permissions. Never copy read’s line-number prefixes into a patch.'
  );
  return lines;
}
