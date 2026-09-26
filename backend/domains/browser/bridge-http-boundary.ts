import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

type Runtime = {
  bridgeProtocol: number;
  disconnectedToken: string;
  getBridgeToken(): Promise<string | null | undefined>;
};

export function createBridgeHttpBoundary(runtime: Runtime) {
  const maxBodyBytes = 2 * 1024 * 1024;
  const rateLimit = 900;
  let requestWindow = { start: Date.now(), count: 0 };

  function json(res: http.ServerResponse, status: number, body: unknown, origin: string | null): void {
    const payload = JSON.stringify(body);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(payload)),
      'cache-control': 'no-store'
    };
    if (origin) {
      headers['access-control-allow-origin'] = origin;
      headers['access-control-allow-headers'] = 'authorization, content-type, x-extension-version, x-extension-protocol, x-extension-build, x-extension-browser, x-extension-host';
      headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
    }
    res.writeHead(status, headers);
    res.end(payload);
  }

  // Web origins are rejected; missing Origin follows each route's own authentication and pairing rules.
  function originOf(req: http.IncomingMessage): { ok: boolean; origin: string | null } {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin === '') return { ok: true, origin: null };
    if (origin.startsWith('chrome-extension://')) return { ok: true, origin };
    return { ok: false, origin: null };
  }

  // Equal token lengths are required before constant-time comparison.
  function safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  function extensionProtocol(req: http.IncomingMessage): number | null {
    const value = Number(req.headers['x-extension-protocol'] ?? NaN);
    return Number.isSafeInteger(value) ? value : null;
  }

  function protocolCompatible(req: http.IncomingMessage): boolean {
    return extensionProtocol(req) === runtime.bridgeProtocol;
  }

  async function authorised(req: http.IncomingMessage): Promise<boolean> {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const token = await runtime.getBridgeToken();
    if (!token || token === runtime.disconnectedToken) return false;
    return safeEqual(header.slice(7), token);
  }

  async function browserDisconnected(): Promise<boolean> {
    return (await runtime.getBridgeToken()) === runtime.disconnectedToken;
  }

  function readBody(req: http.IncomingMessage, limit = maxBodyBytes): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let size = 0;
      let overflowed = false;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        // Discard overflow while draining the request so clients receive a normal HTTP error.
        if (overflowed) return;
        size += chunk.length;
        if (size > limit) {
          overflowed = true;
          chunks.length = 0;
          reject(new Error('body_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (chunks.length === 0) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('invalid_json'));
        }
      });
      req.on('error', reject);
    });
  }

  function tooLarge(res: http.ServerResponse, origin: string | null): void {
    json(res, 413, { error: 'body_too_large' }, origin);
  }

  function rateLimited(): boolean {
    const now = Date.now();
    if (now - requestWindow.start > 60_000) requestWindow = { start: now, count: 0 };
    requestWindow.count += 1;
    return requestWindow.count > rateLimit;
  }

  function reset(): void {
    requestWindow = { start: Date.now(), count: 0 };
  }

  return { authorised, browserDisconnected, extensionProtocol, json, originOf, protocolCompatible, rateLimited, readBody, reset, safeEqual, tooLarge };
}
