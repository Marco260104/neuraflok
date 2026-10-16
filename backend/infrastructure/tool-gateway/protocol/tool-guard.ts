import { AgentError, IdentityLostError } from '../../../domains/automation/agents.js';
import { FsOpError } from '../../../domains/workspace/fsops.js';
import { ExecError } from '../../../domains/workspace/exec.js';
import { ComputerError } from '../../device-control/native/index.js';
import { logInfo, logWarn } from '../../settings/logger.js';
import { SandboxError } from '../../settings/sandbox.js';
import { fail } from './tool-contracts.js';
import { failIdentity } from './identity-notices.js';
import { noteOutcome } from './call-context.js';
import type { ToolContent, ToolResult } from './tool-contracts.js';
import type { ToolOutcome } from '../../../../contracts/session.js';

export function friendlyError(err: unknown): string {
  if (err instanceof SandboxError || err instanceof ComputerError) return err.message;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'Not found';
  if (code === 'EACCES' || code === 'EPERM') return 'Access denied by the operating system';
  if (code === 'EBUSY') return 'The file is in use by another program';
  if (code === 'ENOTEMPTY') return 'Directory is not empty';
  if (code === 'EEXIST') return 'Already exists';
  if (typeof code === 'string' && code.length > 0) return `Filesystem error (${code})`;
  return err instanceof Error ? err.message : String(err);
}

function noteOutcomeSafely(outcome: ToolOutcome): void {
  try {
    noteOutcome(outcome);
  } catch {
    // Tool guard also runs outside tracked call contexts.
  }
}

export async function guard(name: string, fn: () => Promise<ToolResult>, started = Date.now()): Promise<ToolResult> {
  try {
    const result = await fn();
    const elapsed = Date.now() - started;
    if (result.isError) {
      const summary = result.content
        .find((item): item is Extract<ToolContent, { type: 'text' }> => item.type === 'text')
        ?.text.split(/\r?\n/, 1)[0]
        ?.slice(0, 500);
      noteOutcomeSafely('tool_rejected');
      logInfo(`tool ${name} rejected in ${elapsed} ms${summary ? `: ${summary}` : ''}`);
    } else {
      noteOutcomeSafely('ok');
      logInfo(`tool ${name} ok in ${elapsed} ms`);
    }
    return result;
  } catch (err) {
    const message = friendlyError(err);
    const elapsed = Date.now() - started;
    if (
      err instanceof SandboxError ||
      err instanceof ComputerError ||
      err instanceof FsOpError ||
      err instanceof ExecError ||
      err instanceof AgentError
    ) {
      noteOutcomeSafely('tool_rejected');
      logInfo(`tool ${name} rejected in ${elapsed} ms: ${message}`);
    } else {
      noteOutcomeSafely('tool_internal_error');
      logWarn(`tool ${name} failed in ${elapsed} ms: ${message}`);
    }
    return err instanceof IdentityLostError ? failIdentity(message) : fail(message);
  }
}
