import { currentCall, type CallContext } from './call-context.js';
import { getConfig } from '../../settings/config.js';
import { guard, failIdentity, type SurfaceRegistrar, type ToolResult } from './kernel.js';
import { CODE_MODE_LIMITS, type CodeModeTool, type CodeModeOptions } from './code-mode-contract.js';
import { runCodeMode } from './code-mode-runtime.js';
import { codeModeDeclaration } from './code-mode/declaration.js';

export { codeModeDeclaration } from './code-mode/declaration.js';
export { CODE_MODE_INSTRUCTIONS } from './code-mode/instructions.js';

// Adds exec only when the provider has not defined its own operation.
export function canAddCodeMode(tools: ReadonlyArray<{ name: string }>): boolean {
  return tools.length > 0 && !tools.some(tool => tool.name === 'exec');
}

export function codeModeHandler(
  getTools: () => CodeModeTool[], invoke: (name: string, args: unknown, parent: CallContext) => Promise<ToolResult>,
  options: CodeModeOptions = {}
): (args: { code: string }) => Promise<ToolResult> {
  return ({ code }) => guard('exec', async () => {
    const parent = currentCall();
    const allowUnattributed = parent?.allowUnattributed ?? getConfig().multiAgent.allowUnattributedCalls;
    const caller = parent?.caller;
    const hasIdentity = Boolean(caller?.requestId && caller.conversationId && caller.sessionId);
    if (!parent || (!hasIdentity && !allowUnattributed)) {
      return failIdentity('CALLER_IDENTITY_REQUIRED: code mode needs exact companion chat/session proof or Allow unattributed calls enabled in app settings. No JavaScript or nested tool ran.');
    }
    const availableTools = getTools().filter(tool => tool.name !== 'exec');
    return runCodeMode(
      code,
      availableTools,
      (name, args) => invoke(name, args, parent),
      CODE_MODE_LIMITS,
      options
    );
  });
}

export function registerCodeMode(
  reg: SurfaceRegistrar, invoke: (name: string, args: unknown, parent: CallContext) => Promise<ToolResult>,
  options: CodeModeOptions = {}
): void {
  if (!canAddCodeMode(reg.descriptions())) return;
  reg.register('exec', codeModeDeclaration(options), codeModeHandler(() => reg.descriptions(), invoke, options));
}
