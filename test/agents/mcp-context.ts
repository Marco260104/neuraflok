import {
  DEFAULT_CAPABILITIES,
  http,
  recordChatObservations,
  runningToolCalls,
  startMcpServer,
} from './context.js';
import type { ToolContext } from './context.js';
import { expect } from 'vitest';

export const mcpState: { endpoint: Awaited<ReturnType<typeof startMcpServer>>; toolContext: ToolContext; nextId: number; evidenceSeq: number } = { endpoint: undefined as unknown as Awaited<ReturnType<typeof startMcpServer>>, toolContext: undefined as unknown as ToolContext, nextId: 1, evidenceSeq: 0 };





export const post = (body: unknown, extraHeaders: Record<string, string> = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const url = new URL(mcpState.endpoint.urls.core);
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'content-length': Buffer.byteLength(payload),
            ...extraHeaders
          }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8').trim();
            const frame = text.startsWith('{') ? text : ([...text.matchAll(/^data:\s*(.*)$/gm)].at(-1)?.[1] ?? '{}');
            try {
              resolve(JSON.parse(frame));
            } catch {
              resolve({ raw: text });
            }
          });
        }
      );
      req.on('error', reject);
      req.end(payload);
    });


export const waitForRunningToolCall = async (timeoutMs = 5_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (runningToolCalls() === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runningToolCalls()).toBeGreaterThan(0);
  };

export const callTool = async (name: string, args: unknown): Promise<string> => {
    const reply = await post({ jsonrpc: '2.0', id: mcpState.nextId++, method: 'tools/call', params: { name, arguments: args } });
    return ((reply.result?.content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n');
  };

export const agents = (action: string, args: Record<string, unknown> = {}): Promise<string> =>
    callTool('agents', { action, ...args });

export const agentsWithRequestId = async (
    requestId: string,
    action: string,
    args: Record<string, unknown> = {}
  ): Promise<string> => {
    const reply = await replyWithRequestId(requestId, action, args);
    return ((reply.result?.content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n');
  };

export const replyWithRequestId = (requestId: string, action: string, args: Record<string, unknown>): Promise<any> =>
    post(
      { jsonrpc: '2.0', id: mcpState.nextId++, method: 'tools/call', params: { name: 'agents', arguments: { action, ...args } } },
      { 'x-request-id': `${requestId}/relay` }
    );

export const ordinaryWithRequestId = (requestId: string, name: string, args: Record<string, unknown>): Promise<any> =>
    post(
      { jsonrpc: '2.0', id: mcpState.nextId++, method: 'tools/call', params: { name, arguments: args } },
      { 'x-request-id': `${requestId}/relay` }
    );

export const textOfReply = (reply: any): string =>
    ((reply.result?.content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n');

/** The evidence dance of asChat, kept, but reading the machine half of the result. */
  export const structuredAsChat = async (
    conversationId: string,
    action: string,
    args: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> => {
    const seq = ++mcpState.evidenceSeq;
    const requestId = `wfr_agents_${seq}`;
    const pending = replyWithRequestId(requestId, action, args);
    await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: Date.now(), turnId: `t-${seq}` },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        turnId: `t-${seq}`,
        calls: [{ messageId: `m-${seq}`, tool: 'agents', order: 0, answered: false, requestId }]
      }
    ]);
    return (await pending).result?.structuredContent ?? {};
  };

/** Makes a call that ChatGPT's own message model names, from one conversation. This is the only identity anything has now, so it is the only way to make a control call as somebody. The evidence is fed *while the request is in flight*, which is one of the two ways it really arrives. The other is ahead of the call — ChatGPT paints the connector row while it is still composing the request — and that one is covered separately below, because assuming it could not happen is exactly what made every live spawn impossible. */
  export const asChat = async (conversationId: string, action: string, args: Record<string, unknown> = {}): Promise<string> => {
    const seq = ++mcpState.evidenceSeq;
    const requestId = `wfr_agents_${seq}`;
    const pending = agentsWithRequestId(requestId, action, args);
    await recordChatObservations(conversationId, [
      { kind: 'turn_start', time: Date.now(), turnId: `t-${seq}` },
      {
        kind: 'tool_evidence',
        time: Date.now(),
        turnId: `t-${seq}`,
        calls: [{ messageId: `m-${seq}`, tool: 'agents', order: 0, answered: false, requestId }]
      }
    ]);
    return pending;

  };

export async function startMcpEndpoint() {
    mcpState.toolContext = {
      roots: [],
      caps: { ...DEFAULT_CAPABILITIES },
      readOnly: true,
      sessionTools: false,
      agentTools: true
    };
    mcpState.endpoint = await startMcpServer(() => mcpState.toolContext);
  }

export async function stopMcpEndpoint() {
    await mcpState.endpoint.stop();
  }

