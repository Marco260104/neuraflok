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

const MAX_TOOL_RESULT_CHARS = 40_000;
const ALLOWED_TOOLS = new Set<string>([...WEB_CHAT_CORE_TOOLS, 'agents']);

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

export async function invokeBrowserChatTool(
  registrar: ReturnType<typeof createBrowserChatToolRegistrar>,
  call: WebChatToolCall,
  requestId: string,
  conversationId: string,
  sessionId: string
): Promise<string> {
  const name = call.function.name;
  if (!ALLOWED_TOOLS.has(name) || !registrar.registered().includes(name)) {
    return `UNKNOWN_TOOL: ${name} is not available in NEURAFLOK's browser executor.`;
  }
  const parsed = parseArgs(call.function.arguments);
  if (!parsed.ok) return `INVALID_ARGUMENTS: ${parsed.error}`;
  observeRequestCorrelation({
    requestId,
    conversationId,
    sessionId,
    messageId: call.id,
    tool: name,
    observedAt: Date.now()
  });
  const result = await registrar.invoke(name, parsed.value, requestId);
  return toolResultText(result);
}
