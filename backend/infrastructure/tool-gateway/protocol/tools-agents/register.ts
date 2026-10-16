import { currentCall } from '../call-context.js';
import { toolDeclaration } from '../declaration-cache.js';
import { guard, type SurfaceRegistrar } from '../kernel.js';
import { executeAgentsAction } from './actions/index.js';
import { agentsToolConfig } from './schema.js';

export function registerAgentsTool(reg: SurfaceRegistrar): void {
  reg.register('agents', toolDeclaration('agents', () => agentsToolConfig), async input => {
    const startedAt = currentCall()?.startedAt ?? Date.now();
    return guard('agents', async () => {
      if (!reg.agentToolsLive) return reg.featureDisabled('Multi-agent mode', 'Multi-agent mode (experimental)');
      return executeAgentsAction(input, startedAt);
    });
  });
}