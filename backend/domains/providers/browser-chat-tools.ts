// Local tool access and result formatting for browser-backed provider chats.
import {
  WEB_CHAT_CORE_TOOLS,
  type WebChatGuideContext,
  type WebChatToolCall
} from '../../../contracts/chat-protocol.js';
import { getConfig, effectiveCapabilities } from '../../infrastructure/settings/config.js';
import { createRegistrar, type ToolContext, type ToolResult } from '../../infrastructure/tool-gateway/protocol/kernel.js';
import { registerCoreTools } from '../../infrastructure/tool-gateway/protocol/tools-core.js';
import { withManagedSkills } from '../skills/access/managed-roots.js';
import { getSessionProject } from '../workspace/projects.js';
import { observeRequestCorrelation } from '../sessions/history/correlation.js';
import { scopeProjectPlanTool } from './project-plan-tools.js';

const MAX_TOOL_RESULT_CHARS = 40_000;
const TOOL_RETRY_BACKOFF_MS = 200;
const ALLOWED_TOOLS = new Set<string>([...WEB_CHAT_CORE_TOOLS, 'agents']);
const TRANSIENT_TOOL_FAILURE = /\b(?:EBUSY|EAGAIN|ECONNRESET|ETIMEDOUT|EPIPE|EHOSTUNREACH|ERR_CONNECTION_RESET|ERR_TIMED_OUT)\b|temporarily unavailable|temporary (?:connection|channel|transport) (?:failure|error|reset)|connection reset|socket hang up|channel closed|transport closed|timed out|time out|timeout|server disconnected/i;

function liveContext(): ToolContext {
  const config = getConfig();
  const caps = effectiveCapabilities(config);
  return withManagedSkills({
    roots: config.roots,
    caps,
    exposedCaps: caps,
    readOnly: config.readOnly,
    privacyScreenshots: config.ui.privacyScreenshots,
    sessionTools: config.sessions.record,
    agentTools: config.multiAgent.enabled,
    exposedAgentTools: true,
    exposedFinishTool: false,
    exposedFind: !caps.command && caps.search
  });
}

export function createBrowserChatToolRegistrar() {
  const registrar = createRegistrar(null, liveContext(), 'core');
  registerCoreTools(registrar);
  return registrar;
}

export function advertisedBrowserChatTools(registrar: ReturnType<typeof createBrowserChatToolRegistrar>) {
  return registrar.declarations().filter(entry => ALLOWED_TOOLS.has(entry.name));
}

export async function getBrowserChatGuideContext(sessionId: string): Promise<WebChatGuideContext> {
  const roots = getConfig().roots.map(root => `/${root.name}`);
  if (!roots.includes('/skills')) roots.push('/skills');
  const language = getConfig().ui.language;
  try {
    const project = await getSessionProject(sessionId);
    return { roots, project: project?.virtual, language };
  } catch {
    return { roots, language };
  }
}

function toolResultText(result: ToolResult): string {
  const texts = result.content.flatMap(part =>
    part.type === 'text' ? [part.text] : [`[image omitted: ${part.mimeType}]`]
  );
  let text = texts.join('\n').trim();
  if (!text && result.structuredContent) {
    try { text = JSON.stringify(result.structuredContent); } catch { text = ''; }
  }
  if (!text) text = result.isError ? 'tool error' : 'ok';
  if (text.length > MAX_TOOL_RESULT_CHARS) return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n… truncated`;
  return text;
}

function parseArgs(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    if (!raw.trim()) return { ok: true, value: {} };
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

function agentRetryWasExplicitlySafe(args: unknown, errorText: string): boolean {
  if (!args || typeof args !== 'object') return false;
  const action = (args as { action?: unknown }).action;
  if (action === 'spawn') {
    return /worker run could not cross its durable acceptance barrier\. the spawn was rolled back; retry this same request\./i.test(errorText);
  }
  if (action === 'message') {
    return /(?:prime message|agent message) could not cross its durable acceptance barrier\. nothing was queued; retry the same message request\./i.test(errorText);
  }
  if (action === 'finish') {
    return /worker finish could not cross its durable acceptance barrier\. nothing was published; retry the same finish result\./i.test(errorText);
  }
  return false;
}

function shouldRetryTool(name: string, args: unknown, errorText: string): boolean {
  if (name === 'agents' && agentRetryWasExplicitlySafe(args, errorText)) return true;
  const readOnlyAction = name === 'read' || name === 'find' ||
    (name === 'agents' && Boolean(args && typeof args === 'object' && (args as { action?: unknown }).action === 'status'));
  return readOnlyAction && TRANSIENT_TOOL_FAILURE.test(errorText);
}

function errorMessage(error: unknown): string {
  return String(error && typeof error === 'object' && 'message' in error
    ? (error as { message?: unknown }).message
    : error || 'tool error');
}

async function retryDelay(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, TOOL_RETRY_BACKOFF_MS));
}

export async function invokeBrowserChatTool(
  registrar: ReturnType<typeof createBrowserChatToolRegistrar>,
  call: WebChatToolCall,
  requestId: string,
  conversationId: string,
  sessionId: string,
  projectPlanDirectory?: string
): Promise<string> {
  const name = call.function.name;
  if (!ALLOWED_TOOLS.has(name) || !registrar.registered().includes(name)) {
    return `UNKNOWN_TOOL: ${name} is not available in NEURAFLOK's browser executor.`;
  }
  const parsed = parseArgs(call.function.arguments);
  if (!parsed.ok) return `INVALID_ARGUMENTS: ${parsed.error}`;
  const scoped = projectPlanDirectory ? scopeProjectPlanTool(name, parsed.value, projectPlanDirectory) : null;
  if (scoped && !scoped.ok) return 'PLAN_READ_SCOPE: This plan may read files only inside the selected project. The requested tool was not run.';
  const toolArgs = scoped?.ok ? scoped.args : parsed.value;
  observeRequestCorrelation({
    requestId,
    conversationId,
    sessionId,
    messageId: call.id,
    tool: name,
    observedAt: Date.now()
  });
  let result: ToolResult;
  try {
    result = await registrar.invoke(name, toolArgs, requestId);
  } catch (error) {
    if (!shouldRetryTool(name, toolArgs, errorMessage(error))) throw error;
    await retryDelay();
    result = await registrar.invoke(name, toolArgs, requestId);
    return toolResultText(result);
  }
  if (result.isError !== true || !shouldRetryTool(name, toolArgs, toolResultText(result))) {
    return toolResultText(result);
  }
  await retryDelay();
  result = await registrar.invoke(name, toolArgs, requestId);
  return toolResultText(result);
}
