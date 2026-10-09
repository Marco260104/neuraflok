/** Builds a test MCP server with a separate tool registry for each local surface. */

import { McpServer } from '@modelcontextprotocol/server';
import { toolSchemaJson } from '../../backend/infrastructure/tool-gateway/protocol/schema-adapter.js';
import { createRegistrar, type ToolContext } from '../../backend/infrastructure/tool-gateway/protocol/kernel.js';
import { registerCoreTools } from '../../backend/infrastructure/tool-gateway/protocol/tools-core.js';
import { registerDesktopTools } from '../../backend/infrastructure/tool-gateway/protocol/tools-desktop.js';
import { registerCodeMode } from '../../backend/infrastructure/tool-gateway/protocol/code-mode-tool.js';
import { surfaceDefinition, type SurfaceId } from '../../backend/infrastructure/tool-gateway/protocol/surfaces.js';
import { serverInstructions } from '../../backend/infrastructure/tool-gateway/protocol/instructions.js';
import { APP_VERSION } from '../../backend/infrastructure/settings/version.js';
import { toVirtualPath } from '../../backend/infrastructure/settings/sandbox.js';
import { logWarn } from '../../backend/infrastructure/settings/logger.js';
import { withManagedSkills } from '../../backend/domains/skills/access/managed-roots.js';

export interface TestToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export function buildServer(ctx: ToolContext, surface: SurfaceId, observe?: (connectorName: string, version: string, instructions: string, tools: TestToolSchema[]) => void, liveContext: () => ToolContext = () => ctx): McpServer {
  if (surface === 'core') ctx = withManagedSkills(ctx);
  const definition = surfaceDefinition(surface);
  const instructions = serverInstructions(ctx, surface);
  const server = new McpServer(
    { name: definition.serverName, version: APP_VERSION },
    { capabilities: { tools: {} }, instructions }
  );

  const tools: TestToolSchema[] = [];
  const registrar = createRegistrar(server, ctx, surface, observe ? (name, config) => {
    // Match the SDK's Standard Schema conversion target and object-root normalization.
    const schema = toolSchemaJson(config.inputSchema);
    tools.push({ name, description: config.description, inputSchema: { type: 'object', ...schema }, ...(config.annotations ? { annotations: { ...config.annotations } } : {}) });
  } : undefined);
  if (surface === 'core') registerCoreTools(registrar);
  else registerDesktopTools(registrar);
  registerCodeMode(registrar, (name, args, parent) => {
    // Reuse the same registration/validation/handler authority, refreshed for every child so a permission or approved-root change during an awaited script takes effect.
    const live = liveContext();
    const nested = createRegistrar(null, surface === 'core' ? withManagedSkills(live) : live, surface);
    if (surface === 'core') registerCoreTools(nested);
    else registerDesktopTools(nested);
    return nested.invokeNested(name, args, parent);
  }, { windowsDesktop: surface === 'desktop' && process.platform === 'win32' });

  // Cheap self-check on a property the tests assert and the design depends on: a surface may register fewer tools than it declares — permissions decide that — but it may never register one it does not declare. Logged rather than thrown, because refusing to serve would turn a naming slip into a dead connector for the user.
  const declared = new Set(definition.tools);
  for (const name of registrar.registered()) {
    if (!declared.has(name)) {
      logWarn(`MCP surface ${surface} registered "${name}", which it does not declare — check surfaces.ts`);
    }
  }

  observe?.(definition.connectorName, APP_VERSION, instructions, tools);
  return server;
}

export { toVirtualPath };
export type { ToolContext };
export { lastToolCallAt, resetToolClock, transportIdentityStatus } from '../../backend/infrastructure/tool-gateway/protocol/kernel.js';
