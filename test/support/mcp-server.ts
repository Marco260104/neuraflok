/** Test-only MCP endpoint for exercising tool routing, request limits, and graceful shutdown over HTTP. */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createToolRequestTiming, runInToolRequestScope } from '../../backend/infrastructure/tool-gateway/request-context.js';
import { formatToolRequestTiming, requestIdFromHeader } from './mcp-http-helpers.js';
import http from 'node:http';
import type { Socket } from 'node:net';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { getConfig } from '../../backend/infrastructure/settings/config.js';
import { logError, logInfo, logWarn } from '../../backend/infrastructure/settings/logger.js';
import { buildServer, resetToolClock, type ToolContext } from './mcp-tools.js';
import { SURFACE_IDS, type SurfaceId } from '../../backend/infrastructure/tool-gateway/protocol/surfaces.js';

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface McpEndpoint {
  port: number;
  /** One tokenized URL per independently scoped tool surface. */
  urls: Record<SurfaceId, string>;
  /** Stops accepting requests and drains accepted responses. */
  stop: (options?: { forceAfterMs?: number }) => Promise<void>;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Returns consistent JSON errors for paths that do not identify a tool surface. */
function jsonError(res: http.ServerResponse, status: number, error: string): void {
  const body = JSON.stringify({ error });
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

/** Buffers an HTTP body before adapter admission, irrespective of Content-Length. The MCP Node adapter otherwise concatenates a chunked/missing-length request to an unbounded JS string before parsing it. Stop retaining bytes at the same 8 MiB limit the header guard advertises, answer immediately, and drain the remaining socket bytes without keeping them in memory. */
function readBoundedJsonBody(
  req: http.IncomingMessage
): Promise<{ body?: unknown; error?: 'payload_too_large' | 'invalid_json' }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;

    const finish = (value: { body?: unknown; error?: 'payload_too_large' | 'invalid_json' }): void => {
      if (done) return;
      done = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_BODY_BYTES) {
        finish({ error: 'payload_too_large' });
        // Do not leave the unread request applying backpressure to this connection. Its remaining bytes are discarded by Node rather than accumulated by us.
        req.resume();
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      try {
        const text = Buffer.concat(chunks, total).toString('utf8');
        finish({ body: text.length === 0 ? null : JSON.parse(text) });
      } catch {
        finish({ error: 'invalid_json' });
      }
    };
    const onError = (): void => finish({ error: 'invalid_json' });

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}


/** Starts the local MCP server. `getContext` is called on every request so that roots and capabilities are read fresh; nothing about the permission state is captured at startup. */
interface SurfaceExposure {
  finishTool: boolean;
  caps: ToolContext['caps'] | null;
  sessionTools: boolean;
  agentTools: boolean;
  find: boolean | null;
}

/** Tool names already exposed to one client on one surface. */
const surfaceExposure = new Map<SurfaceId, SurfaceExposure>();

function exposureFor(surface: SurfaceId): SurfaceExposure {
  let state = surfaceExposure.get(surface);
  if (!state) {
    state = { finishTool: false, caps: null, sessionTools: false, agentTools: false, find: null };
    surfaceExposure.set(surface, state);
  }
  return state;
}

/** Clears cached exposure before a new test endpoint snapshots current settings. */
export function forgetExposedSurface(): void {
  surfaceExposure.clear();
}

export async function startMcpServer(getContext: () => ToolContext): Promise<McpEndpoint> {
  resetToolClock();
  // Each surface receives an independent unguessable path token.
  const surfacePaths = SURFACE_IDS.map((id) => ({
    id,
    basePath: `/mcp/${id}/${randomBytes(32).toString('base64url')}`
  }));

  // Keep previously advertised tools registered so clients with cached lists receive a permission error instead of an unknown-tool failure.
  forgetExposedSurface();
  const stableContext = (surface: SurfaceId): ToolContext => {
    const live = getContext();
    const exposed = exposureFor(surface);
    if (exposed.find === null) exposed.find = !live.caps.command && live.caps.search;
    if (exposed.caps === null) {
      exposed.caps = { ...live.caps };
    } else {
      for (const key of Object.keys(live.caps) as Array<keyof ToolContext['caps']>) {
        if (live.caps[key]) exposed.caps[key] = true;
      }
    }
    const config = getConfig();
    const sessionTools = live.sessionTools ?? config.sessions.record;
    const agentTools = live.agentTools ?? config.multiAgent.enabled;
    exposed.finishTool = exposed.finishTool || config.ui.finishTool === true;
    exposed.sessionTools = exposed.sessionTools || sessionTools;
    exposed.agentTools = exposed.agentTools || agentTools;
    return {
      ...live,
      sessionTools,
      agentTools,
      exposedCaps: { ...exposed.caps },
      exposedSessionTools: exposed.sessionTools,
      exposedFinishTool: exposed.finishTool,
      exposedAgentTools: exposed.agentTools,
      exposedFind: exposed.find
    };
  };

  // One handler per surface, and the routing below is the only thing that decides which one sees a request. This is what makes the discovery boundary real rather than advertised: the Core handler has no `computer` registered at all, so a call for it fails as an unknown tool inside the protocol layer, with nothing here to "helpfully" forward it to the other surface.
  const routes = surfacePaths.map((surface) => ({
    ...surface,
    handler: toNodeHandler(
      createMcpHandler(() => buildServer(stableContext(surface.id), surface.id, undefined, () => stableContext(surface.id))),
      { onerror: (error) => logError(`MCP handler error (${surface.id}): ${error.message}`) }
    )
  }));
  const checkHost = localhostHostValidation();
  const checkOrigin = localhostOriginValidation();

  // A TCP connection or incomplete body is not an accepted MCP operation. Only requests handed to the adapter own a response that must survive Disconnect.
  const sockets = new Map<Socket, Set<http.ServerResponse>>();
  let stopping: Promise<void> | null = null;
  let forceTimer: ReturnType<typeof setTimeout> | null = null;
  let forceDeadline = Infinity;
  let stopped = false;
  const server = http.createServer((req, res) => {
    if (stopping) {
      res.setHeader('connection', 'close');
      jsonError(res, 503, 'server_stopping');
      return;
    }
    const timing = createToolRequestTiming();
    const url = req.url ?? '';
    const pathOnly = url.split('?')[0] ?? '';

    // Log the surface shape without exposing its path token or request body.
    const route = routes.find((candidate) => safeEqual(pathOnly, candidate.basePath)) ?? null;

    const startedAt = Date.now();
    const publication = { completedAt: null as number | null, failed: false };
    res.once('close', () => { if (publication.completedAt === null) publication.failed = true; });
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300 && !publication.failed) publication.completedAt = Date.now();
      else publication.failed = true;
      const shape = route
        ? `mcp/${route.id}`
        : pathOnly.slice(0, 40);
      const method = req.method ?? '?';
      const line = `${method} ${shape} → ${res.statusCode} in ${Date.now() - startedAt}ms${formatToolRequestTiming(timing)}`;
      // GET and DELETE are optional for clients that use request-response transport only.
      const optional =
        res.statusCode === 405 && route !== null && (method === 'GET' || method === 'DELETE');
      if (optional) logInfo(`request ${line} (stream/session not offered — normal)`);
      else if (res.statusCode >= 400) logWarn(`request ${line}`);
      else logInfo(`request ${line}`);
    });

    if (!route) {
      jsonError(res, 404, 'not_found');
      return;
    }
    if (!checkHost(req, res)) return;
    if (!checkOrigin(req, res)) return;

    const declaredHeader = req.headers['content-length'];
    const declared = Number(declaredHeader ?? 0);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      jsonError(res, 413, 'payload_too_large');
      return;
    }

    // The tool dispatch reads this id from request context because the MCP call context does not expose it.
    const requestId = requestIdFromHeader(req.headers['x-request-id']);
    const dispatch = (body?: unknown): void => {
      if (stopping || res.destroyed) {
        if (!res.destroyed) {
          res.setHeader('connection', 'close');
          jsonError(res, 503, 'server_stopping');
        }
        return;
      }
      const socket = req.socket;
      const responses = sockets.get(socket)!;
      responses.add(res);
      const release = (): void => {
        responses.delete(res);
        // Flush the completed response without waiting for the peer to close its half of the connection. Immediate destroy() could lose buffered bytes.
        if (stopping && responses.size === 0) socket.destroySoon();
      };
      res.once('finish', release);
      res.once('close', release);
      runInToolRequestScope({ requestId, timing, publication }, () => void route.handler(req, res, body));
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      void readBoundedJsonBody(req).then((parsed) => {
        if (res.destroyed) return;
        if (parsed.error === 'payload_too_large') {
          jsonError(res, 413, 'payload_too_large');
          return;
        }
        if (parsed.error === 'invalid_json') {
          jsonError(res, 400, 'invalid_json');
          return;
        }
        dispatch(parsed.body);
      });
      return;
    }
    dispatch();
  });
  server.on('connection', (socket) => {
    sockets.set(socket, new Set());
    socket.once('close', () => sockets.delete(socket));
    if (stopping) socket.destroy();
  });

  // Reject slow or oversized bodies rather than holding sockets open indefinitely.
  server.headersTimeout = 30_000;
  server.requestTimeout = 300_000;
  server.maxRequestsPerSocket = 0;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Could not determine the local server port');
  }

  server.on('error', (err) => logError(`Local server error: ${err.message}`));
  logInfo(`server started on 127.0.0.1:${address.port}`);

  const urls = Object.fromEntries(routes.map((surface) => [
    surface.id,
    `http://127.0.0.1:${address.port}${surface.basePath}`
  ])) as Record<SurfaceId, string>;

  return {
    port: address.port,
    urls,
    stop: (options = {}) => {
      if (!stopping) {
        // Publish the admission fence before closing any sockets or receiving late bodies.
        let resolveStop!: () => void;
        stopping = new Promise<void>((resolve) => { resolveStop = resolve; });
        const accepted = [...sockets.values()].reduce((count, responses) => count + responses.size, 0);
        logInfo(`server stopping: draining ${accepted} accepted response(s)`);
        server.close(() => {
          stopped = true;
          if (forceTimer) clearTimeout(forceTimer);
          logInfo('server stopped');
          resolveStop();
        });
        for (const [socket, responses] of sockets) {
          if (responses.size === 0) socket.destroy();
        }
      }
      // Final shutdown can escalate an ordinary drain already in progress. Repeated calls share custody and may shorten, but never extend, its force deadline.
      const forceAfterMs = options.forceAfterMs;
      if (!stopped && forceAfterMs !== undefined && Date.now() + forceAfterMs < forceDeadline) {
        if (forceTimer) clearTimeout(forceTimer);
        forceDeadline = Date.now() + Math.max(0, forceAfterMs);
        forceTimer = setTimeout(() => {
          server.closeAllConnections();
          logWarn(`server drain timed out after ${forceAfterMs}ms during final shutdown; forcing remaining connections closed`);
        }, Math.max(0, forceAfterMs));
        forceTimer.unref?.();
      }
      return stopping;
    }
  };
}
