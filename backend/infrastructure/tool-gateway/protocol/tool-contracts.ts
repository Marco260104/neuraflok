import type { Capabilities, Root } from '../../../../contracts/types.js';
import type { CallContext } from './call-context.js';
import type { z } from 'zod';

export interface ToolContext {
  exposedFinishTool?: boolean;
  roots: Root[];
  /** Capabilities allowed by the current settings. */
  caps: Capabilities;
  /** Capabilities already published for this endpoint; handlers still enforce `caps`. */
  exposedCaps?: Capabilities;
  readOnly: boolean;
  /** Restricts an unspecified screenshot to the foreground window. */
  privacyScreenshots?: boolean;
  /** Whether session-recording tools are currently enabled. */
  sessionTools?: boolean;
  /** Whether multi-agent tools are currently enabled. */
  agentTools?: boolean;
  /** Keeps published session-tool declarations stable while the endpoint is live. */
  exposedSessionTools?: boolean;
  /** Keeps published agent-tool declarations stable while the endpoint is live. */
  exposedAgentTools?: boolean;
  /** Keeps the selected search or exec surface stable while the endpoint is live. */
  exposedFind?: boolean;
}

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export type ToolResult = { content: ToolContent[]; structuredContent?: Record<string, unknown>; isError?: boolean };

export const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
export const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface SurfaceRegistrar {
  ctx: ToolContext;
  caps: Capabilities;
  exposedCaps: Capabilities;
  sessionToolsLive: boolean;
  sessionToolsExposed: boolean;
  agentToolsLive: boolean;
  agentToolsExposed: boolean;
  findExposed: boolean;
  register<Schema extends z.ZodType>(
    name: string,
    config: {
      title?: string;
      description: string;
      inputSchema: Schema;
      outputSchema?: z.ZodType;
      annotations?: ToolAnnotations;
      _meta?: Record<string, unknown>;
    },
    handler: (args: z.output<Schema>) => Promise<ToolResult>
  ): void;
  guarded(cap: keyof Capabilities, name: string, fn: () => Promise<ToolResult>): Promise<ToolResult>;
  featureDisabled(feature: string, setting: string): ToolResult;
  registered(): string[];
  invokeNested(name: string, args: unknown, parent: CallContext): Promise<ToolResult>;
  invoke(name: string, args: unknown, requestId: string | null): Promise<ToolResult>;
  descriptions(): Array<{ name: string; description: string }>;
  declarations(): Array<{ name: string; description: string; inputSchema: object }>;
}
