import { ComputerError } from '../../../device-control/native/index.js';
import { createWindowsComputerApi, type WindowsComputerApi } from '../../../device-control/native/windows-api.js';
import { currentCall } from '../call-context.js';
import { getConfig } from '../../../settings/config.js';
import { requestCorrelation } from '../../../../domains/sessions/history/correlation.js';
import { WINDOWS_COMPUTER_STATE_INPUT_METHODS } from '../../../../../contracts/windows-computer/operation-policy.js';

const STATE_INPUT_METHODS = new Set<string>(WINDOWS_COMPUTER_STATE_INPUT_METHODS);
const MAX_CONTEXTS = 32;
const contexts = new Map<string, WindowsComputerApi>();

export function apiForCaller(method: string): WindowsComputerApi {
  const call = currentCall();
  const caller = call?.caller;
  const allowUnattributed = call?.allowUnattributed ?? getConfig().multiAgent.allowUnattributedCalls;
  const principals: string[] = [];
  if (caller?.sessionId) principals.push(`session:${caller.sessionId}`);
  else if (caller?.conversationId) principals.push(`chat:${caller.conversationId}`);
  if (allowUnattributed && caller?.requestId) principals.push(`request:${caller.requestId}`);
  if (allowUnattributed && principals.length === 0) principals.push('unattributed');
  if (!principals.length) {
    contexts.delete('unattributed');
    if (STATE_INPUT_METHODS.has(method)) {
      throw new ComputerError('CALLER_IDENTITY_REQUIRED: indexed and coordinate input requires exact companion identity or Allow unattributed calls enabled in app settings; no input ran.');
    }
    // Unattributed reads stay isolated so anonymous calls cannot share observation authority.
    return createWindowsComputerApi();
  }
  let api: WindowsComputerApi | undefined;
  for (const principal of principals) {
    api = contexts.get(principal);
    if (api) break;
  }
  if (!api && caller?.sessionId) {
    for (const [principal, candidate] of [...contexts.entries()].reverse()) {
      if (!principal.startsWith('request:')) continue;
      if (requestCorrelation(principal.slice('request:'.length))?.sessionId !== caller.sessionId) continue;
      api = candidate;
      break;
    }
  }
  if (!api) api = createWindowsComputerApi();
  for (const principal of principals) {
    contexts.delete(principal);
    contexts.set(principal, api);
  }
  while (contexts.size > MAX_CONTEXTS) contexts.delete(contexts.keys().next().value!);
  return api;
}
