import http from 'node:http';
import type { createBridgeHttpBoundary } from './bridge-http-boundary.js';
import type { createBridgeBrowserCredentials } from './bridge-browser-credentials.js';

// Handles extension identification and credential pairing.
type HttpBoundary = ReturnType<typeof createBridgeHttpBoundary>;
type BrowserCredentials = ReturnType<typeof createBridgeBrowserCredentials>;

export type BridgePairingRouteRuntime = Pick<
  HttpBoundary,
  'browserDisconnected' | 'extensionProtocol' | 'json' | 'protocolCompatible' | 'rateLimited' | 'readBody' | 'tooLarge'
> & Pick<BrowserCredentials, 'browserCredentialEpoch' | 'withBrowserCredentials'> & {
  APP_VERSION: string;
  BRIDGE_PROTOCOL: number;
  BROWSER_DISCONNECTED: string;
  changed(): void;
  getSecret: typeof import('../../infrastructure/settings/secrets.js').getSecret;
  logInfo: typeof import('../../infrastructure/settings/logger.js').logInfo;
  noteBrowserSeen(req: http.IncomingMessage): boolean;
  randomBytes: typeof import('node:crypto').randomBytes;
  secureStorageStatus: typeof import('../../infrastructure/settings/secrets.js').secureStorageStatus;
  setSecret: typeof import('../../infrastructure/settings/secrets.js').setSecret;
};

type Runtime = BridgePairingRouteRuntime;

export async function handleBridgePairingRoutes(route: string, req: http.IncomingMessage, res: http.ServerResponse, origin: string | null, runtime: Runtime): Promise<boolean> {
  const { APP_VERSION, BRIDGE_PROTOCOL, BROWSER_DISCONNECTED, browserDisconnected, changed, extensionProtocol, getSecret, logInfo, noteBrowserSeen, protocolCompatible, randomBytes, rateLimited, readBody, secureStorageStatus, setSecret, withBrowserCredentials } = runtime;
  const json = (...args: Parameters<Runtime['json']>): true => { runtime.json(...args); return true; };
  const tooLarge = (...args: Parameters<Runtime['tooLarge']>): true => { runtime.tooLarge(...args); return true; };

  // Identification only. Deliberately says nothing about roots, permissions or state.
  if (route === '/hello') {
    const stored = await getSecret('bridgeToken');
    return json(
      res,
      200,
      {
        app: 'neuraflok',
        version: APP_VERSION,
        bridge: BRIDGE_PROTOCOL,
        // Unknown, not incompatible, for a caller that states no protocol (curl in a bug report).
        compatible: extensionProtocol(req) === null ? null : protocolCompatible(req),
        paired: stored !== null && stored !== BROWSER_DISCONNECTED,
        disconnected: stored === BROWSER_DISCONNECTED
      },
      origin
    );
  }

  if (route === '/pair' && req.method === 'POST') {
    const credentialEpoch = runtime.browserCredentialEpoch;
    if (!protocolCompatible(req)) {
      return json(
        res,
        426,
        {
          error: 'incompatible_extension',
          bridge: BRIDGE_PROTOCOL,
          version: APP_VERSION
        },
        origin
      );
    }
    if (rateLimited()) return json(res, 429, { error: 'rate_limited' }, origin);
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const reconnect = Boolean(body && typeof body === 'object' && !Array.isArray(body) && (body as Record<string, unknown>)['reconnect'] === true);
    if ((await browserDisconnected()) && !reconnect) {
      return json(res, 409, { error: 'browser_disconnected' }, origin);
    }
    const storage = await secureStorageStatus();
    if (!storage.available) {
      return json(
        res,
        503,
        { error: 'secure_storage_unavailable', message: storage.detail ?? 'Secure credential storage is unavailable.' },
        origin
      );
    }
    // Loopback auto-pairing lets same-user processes request the bridge token; web origins remain blocked and every other route requires bearer authentication.
    const reuse = !reconnect && Boolean(body && typeof body === 'object' && !Array.isArray(body) &&
      (body as Record<string, unknown>)['reuse'] === true);
    const provisioned = await withBrowserCredentials(async () => {
      const stored = await getSecret('bridgeToken');
      if (credentialEpoch !== runtime.browserCredentialEpoch || (stored === BROWSER_DISCONNECTED && !reconnect)) return null;
      const reused = reuse && !!stored && stored !== BROWSER_DISCONNECTED;
      const token = reused ? stored : randomBytes(32).toString('base64url');
      if (!reused) await setSecret('bridgeToken', token);
      if (credentialEpoch !== runtime.browserCredentialEpoch) return null;
      return { token, reused };
    });
    if (!provisioned) return json(res, 409, { error: 'browser_disconnected' }, origin);
    const appeared = noteBrowserSeen(req);
    if (!provisioned.reused) {
      logInfo('bridge: browser extension connected and provisioned');
    }
    if (!provisioned.reused || appeared) changed();
    return json(res, 200, { token: provisioned.token }, origin);
  }
  return false;
}
