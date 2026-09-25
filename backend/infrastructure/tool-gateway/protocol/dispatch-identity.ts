import { WINDOWS_COMPUTER_STATE_INPUT_METHODS } from '../../../../contracts/windows-computer/operation-policy.js';
import { hasDormantWorkerLeases, hasRetiredWorkerLeases, swarmRunning } from '../../../domains/automation/agents.js';
import { anyChatBlocked } from '../../../domains/sessions/continuity/blocked-chats.js';
import { anyContinuationOpen } from '../../../domains/sessions/continuity/continuation.js';
import { freshCallOrigin, awaitFreshCallOrigin, REQUEST_ID_GRACE_MS } from '../../../domains/sessions/history/recorder.js';
import { requestCorrelation } from '../../../domains/sessions/history/correlation.js';
import { sessionFinishDeadline } from '../../../domains/sessions/input/finish.js';
import { isAbsoluteVirtualPath, isNativeWindowsPath } from '../../settings/sandbox.js';
import { strictChatAllowlistEnabled } from '../../../domains/sessions/continuity/conversation-access.js';
import type { SurfaceId } from './surfaces.js';
import type { CallContext } from './call-context.js';
import { IDENTITY_EVIDENCE_MS, SPAWN_EVIDENCE_MS, UNATTRIBUTED_DESKTOP_EVIDENCE_MS } from './identity-windows.js';

export function callerConversation(tool: string, startedAt: number, requestId: string | null): string | null {
  return freshCallOrigin(tool, startedAt, requestId);
}

export function setCallerConversation(context: CallContext, conversationId: string | null): void {
  context.caller.conversationId = conversationId;
  const exact = conversationId ? requestCorrelation(context.caller.requestId) : null;
  context.caller.sessionId = exact?.conversationId === conversationId ? exact.sessionId : null;
}

export function needsWorkspaceIdentity(name: string, args: unknown): boolean {
  const input = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const relative = (value: unknown): boolean =>
    typeof value === 'string' && !isAbsoluteVirtualPath(value) && !isNativeWindowsPath(value);
  if (name === 'read') {
    const paths = Array.isArray(input['paths']) ? input['paths'] : [];
    return paths.some(relative);
  }
  if (name === 'find') return relative(input['path']);
  if (name === 'apply_patch') return true;
  if (name === 'exec_command') {
    const workdir = input['workdir'];
    return swarmRunning() || workdir === undefined || relative(workdir);
  }
  return false;
}

export async function resolveDispatchIdentity(input: {
  context: CallContext;
  name: string;
  args: unknown;
  startedAt: number;
  requestId: string | null;
  surface: SurfaceId;
  allowUnattributed: boolean;
}): Promise<{ identitySensitive: boolean }> {
  const { context, name, args, startedAt, requestId, surface, allowUnattributed } = input;
  const identitySensitive = needsWorkspaceIdentity(name, args);
  const desktopContext = surface === 'desktop' && (name === 'get_window_state' ||
    (WINDOWS_COMPUTER_STATE_INPUT_METHODS as readonly string[]).includes(name));
  const finishDeadline = name === 'session_finish' ? sessionFinishDeadline(startedAt) : null;
  const identityWindow = (requested: number): number => finishDeadline === null
    ? requested : Math.min(requested, Math.max(0, finishDeadline - Date.now()));
  const needsExactIdentity = name === 'session_finish' || desktopContext || (!allowUnattributed && (
    name === 'exec' || name === 'update_plan' || (identitySensitive && swarmRunning())
  ));
  if (!context.caller.conversationId && needsExactIdentity && requestId) {
    const wait = name === 'session_finish'
      ? SPAWN_EVIDENCE_MS
      : desktopContext && allowUnattributed
      ? UNATTRIBUTED_DESKTOP_EVIDENCE_MS
      : IDENTITY_EVIDENCE_MS;
    setCallerConversation(context, await awaitFreshCallOrigin(name, startedAt, identityWindow(wait), { requestId }));
  }
  if (!context.caller.conversationId && hasRetiredWorkerLeases() && requestId) {
    setCallerConversation(context, await awaitFreshCallOrigin(name, startedAt, identityWindow(IDENTITY_EVIDENCE_MS), { requestId }));
  }
  if (!context.caller.conversationId && hasDormantWorkerLeases() && requestId) {
    setCallerConversation(context, await awaitFreshCallOrigin(name, startedAt, identityWindow(IDENTITY_EVIDENCE_MS), { requestId }));
  }
  if (
    !context.caller.conversationId &&
    (strictChatAllowlistEnabled() || anyChatBlocked() || anyContinuationOpen()) &&
    requestId
  ) {
    setCallerConversation(context, await awaitFreshCallOrigin(name, startedAt, identityWindow(REQUEST_ID_GRACE_MS), { requestId }));
  }
  return { identitySensitive };
}
