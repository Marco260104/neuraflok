import { isGitRepository } from '../../../../../domains/workspace/toolchain.js';
import type { ToolContext } from '../../kernel.js';
import type { getConfig } from '../../../../settings/config.js';

export interface CoreWorkspaceContext {
  host: string;
  roots: string;
  authority: string;
  writable: boolean;
  executable: boolean;
  windows: boolean;
  sessionTools: boolean;
  agentTools: boolean;
}

export function describeCoreWorkspace(
  ctx: ToolContext,
  platform: NodeJS.Platform,
  config: ReturnType<typeof getConfig>
): CoreWorkspaceContext {
  const { caps } = ctx;
  const windows = platform === 'win32';
  const host = platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : windows ? 'Windows' : 'local';
  const roots = ctx.roots.length
    ? ctx.roots.map(root => `/${root.name}${isGitRepository(root.path) ? ' (git)' : ''}`).join('  ')
    : 'None yet.';
  const authority = [
    `browse=${caps.browse ? 'on' : 'off'}`,
    `search=${caps.search ? 'on' : 'off'}`,
    `read=${caps.read ? 'on' : 'off'}`,
    `metadata=${caps.metadata ? 'on' : 'off'}`,
    `create=${caps.create ? 'on' : 'off'}`,
    `edit=${caps.edit ? 'on' : 'off'}`,
    `move=${caps.move ? 'on' : 'off'}`,
    `delete=${caps.deleteFile ? 'on' : 'off'}`,
    `command=${caps.command ? 'on' : 'off'}`
  ].join(' ');
  return {
    host,
    roots,
    authority,
    writable: !ctx.readOnly && (caps.create || caps.edit || caps.move || caps.deleteFile),
    executable: !ctx.readOnly && caps.command,
    windows,
    sessionTools: ctx.sessionTools ?? config.sessions.record,
    agentTools: ctx.agentTools ?? config.multiAgent.enabled
  };
}
