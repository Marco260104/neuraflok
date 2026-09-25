import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { CAPABILITY_LABELS, WRITE_CAPABILITIES } from '../../../../contracts/types.js';
import { getConfig } from '../../settings/config.js';
import { createToolRequestTiming, currentToolRequestId, runInToolRequestScope } from '../request-context.js';
import { fail } from './tool-contracts.js';
import type { CallContext } from './call-context.js';
import type { SurfaceId } from './surfaces.js';
import type { SurfaceRegistrar, ToolAnnotations, ToolContext, ToolResult } from './tool-contracts.js';
import { toolSchema, toolSchemaJson } from './schema-adapter.js';

interface RegistrarRuntime {
  dispatch(
    name: string,
    args: unknown,
    transportKey: string | null,
    requestId: string | null,
    surface: SurfaceId,
    run: () => Promise<ToolResult>,
    parent?: CallContext
  ): Promise<ToolResult>;
  guard(name: string, fn: () => Promise<ToolResult>): Promise<ToolResult>;
}

export type RegistrarObserver = (
  name: string,
  config: { description: string; inputSchema: z.ZodType; annotations?: ToolAnnotations }
) => void;

type McpCallContext = Pick<ServerContext, 'sessionId'>;

function requestIdOf(_context: McpCallContext | undefined): string | null {
  return currentToolRequestId();
}

export function createSurfaceRegistrar(
  server: McpServer | null,
  ctx: ToolContext,
  surface: SurfaceId,
  observe: RegistrarObserver | undefined,
  runtime: RegistrarRuntime
): SurfaceRegistrar {
  const caps = ctx.caps;
  const exposedCaps = ctx.exposedCaps ?? caps;
  const sessionToolsLive = ctx.sessionTools ?? getConfig().sessions.record;
  const agentToolsLive = ctx.agentTools ?? getConfig().multiAgent.enabled;
  const sessionToolsExposed = ctx.exposedSessionTools ?? sessionToolsLive;
  const agentToolsExposed = ctx.exposedAgentTools ?? agentToolsLive;
  const findExposed = ctx.exposedFind ?? (!exposedCaps.command && exposedCaps.search);
  const names: string[] = [];
  const handlers = new Map<string, {
    description: string;
    inputSchema: z.ZodType;
    run: (args: unknown) => Promise<ToolResult>;
  }>();

  return {
    ctx,
    caps,
    exposedCaps,
    sessionToolsLive,
    sessionToolsExposed,
    agentToolsLive,
    agentToolsExposed,
    findExposed,
    registered: () => [...names],
    descriptions: () => [...handlers].map(([name, entry]) => ({ name, description: entry.description })),
    declarations: () => [...handlers].map(([name, entry]) => ({
      name,
      description: entry.description,
      inputSchema: toolSchemaJson(entry.inputSchema)
    })),
    invoke(name, args, requestId) {
      const timing = createToolRequestTiming();
      return runInToolRequestScope({ requestId, timing }, () => runtime.dispatch(
        name,
        args,
        null,
        requestId,
        surface,
        async () => {
          const entry = handlers.get(name);
          return entry ? entry.run(args) : fail('UNKNOWN_TOOL: this tool is not available on this connector.');
        }
      ));
    },
    invokeNested(name, args, parent) {
      return runtime.dispatch(
        name,
        args,
        parent.caller.transportKey,
        parent.caller.requestId,
        surface,
        async () => {
          const entry = handlers.get(name);
          return entry ? entry.run(args) : fail('UNKNOWN_TOOL: this tool is not available on this connector.');
        },
        parent
      );
    },
    register(name, config, handler) {
      names.push(name);
      handlers.set(name, {
        description: config.description,
        inputSchema: config.inputSchema,
        run: async args => {
          const parsed = await config.inputSchema.safeParseAsync(args);
          if (parsed.success) return handler(parsed.data);
          const details = parsed.error.issues.slice(0, 3).map(issue =>
            `${issue.path.map(String).join('.').slice(0, 80) || 'arguments'}: ${issue.message.slice(0, 300)}`
          ).join('; ');
          return fail(`INVALID_ARGUMENTS: ${details}`);
        }
      });
      observe?.(name, config);
      server?.registerTool(name, {
        ...config,
        inputSchema: toolSchema(config.inputSchema),
        ...(config.outputSchema ? { outputSchema: toolSchema(config.outputSchema) } : {})
      }, ((args: never, mcpContext?: McpCallContext) => runtime.dispatch(
        name,
        args,
        mcpContext?.sessionId ?? null,
        requestIdOf(mcpContext),
        surface,
        () => handler(args),
        undefined
      )) as never);
    },
    guarded(cap, name, fn) {
      return runtime.guard(name, async () => {
        if (!caps[cap]) {
          return fail(
            ctx.readOnly && WRITE_CAPABILITIES.includes(cap)
              ? `TOOL_DISABLED: ${name} is disabled because Read-only mode is on. Ask the user to turn Read-only off in the app, then retry.`
              : `TOOL_DISABLED: ${name} requires the "${CAPABILITY_LABELS[cap]}" permission. Ask the user to enable "${CAPABILITY_LABELS[cap]}" in the app, then retry.`
          );
        }
        return fn();
      });
    },
    featureDisabled(feature, setting) {
      return fail(
        `FEATURE_DISABLED: ${feature} is switched off in NEURAFLOK. ` +
        `Ask the user to enable "${setting}" in the app, then try again.`
      );
    }
  };
}
