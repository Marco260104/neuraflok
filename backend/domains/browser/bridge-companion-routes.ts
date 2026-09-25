import http from 'node:http';
import { browserControl } from './control/index.js';
import type { BrowserResult } from '../../../contracts/browser/control-policy.js';
import { effectiveCapabilities, getConfig } from '../../infrastructure/settings/config.js';
import { logInfo, logWarn } from '../../infrastructure/settings/logger.js';
import { acknowledgeBrowserPreferences } from './preferences/handshake.js';
import { recordCompanionDiagnostics } from './companion-diagnostics.js';
import { prepareExtensionUpdate } from './extension-path.js';
import { requestCorrelation } from '../sessions/history/correlation.js';

type Runtime = {
  readBody(req: http.IncomingMessage): Promise<unknown>;
  json(res: http.ServerResponse, status: number, body: unknown, origin: string | null): void;
  extensionBuildOf(req: http.IncomingMessage): string | null;
};

export async function handleBridgeCompanionRoutes(
  route: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  origin: string | null,
  runtime: Runtime
): Promise<boolean> {
  if (route === '/browser-control' && req.method === 'POST') {
    const body = await runtime.readBody(req) as Record<string, unknown>;
    if (!body || typeof body.browserId !== 'string' || !/^[a-f\d-]{36}$/i.test(body.browserId))
      return send(runtime, res, 400, { error: 'invalid_browser_request' }, origin);
    if (body.action === 'poll' && typeof body.enabled === 'boolean' && typeof body.name === 'string') {
      const caps = effectiveCapabilities(getConfig());
      return send(runtime, res, 200, {
        ...browserControl.poll(body.browserId, body.name, body.enabled),
        policy: { read: caps.screen, write: caps.control }
      }, origin);
    }
    if (typeof body.id !== 'string' || typeof body.epoch !== 'string' || body.id.length > 100 || body.epoch.length > 100)
      return send(runtime, res, 400, { error: 'invalid_browser_request' }, origin);
    if (body.action === 'claim') {
      if (body.owners !== undefined && (!Array.isArray(body.owners) || body.owners.length > 32 ||
          !body.owners.every(owner => typeof owner === 'string' && owner.startsWith('request:') && owner.length <= 1024)))
        return send(runtime, res, 400, { error: 'invalid_browser_owners' }, origin);
      const proofs = ((body.owners || []) as string[]).flatMap(owner => {
        const sessionId = requestCorrelation(owner.slice('request:'.length))?.sessionId;
        return sessionId ? [{ owner, sessionId }] : [];
      });
      const command = await browserControl.claim(body.browserId, body.id, body.epoch, proofs);
      return send(runtime, res, command ? 200 : 409, { command }, origin);
    }
    if (body.action === 'check') {
      return send(runtime, res, 200, {
        allowed: await browserControl.check(body.browserId, body.id, body.epoch)
      }, origin);
    }
    if (body.action === 'result' && body.result && typeof body.result === 'object' && !Array.isArray(body.result)) {
      const result = body.result as BrowserResult;
      if ((result.error !== undefined && typeof result.error !== 'string') || (result.image &&
          (typeof result.image.data !== 'string' || !['image/png', 'image/jpeg'].includes(result.image.mimeType))))
        return send(runtime, res, 400, { error: 'invalid_browser_result' }, origin);
      const accepted = browserControl.result(body.browserId, body.id, body.epoch, result);
      return send(runtime, res, accepted ? 200 : 409, { ok: accepted }, origin);
    }
    return send(runtime, res, 400, { error: 'invalid_browser_request' }, origin);
  }

  if (route === '/browser/preferences' && req.method === 'POST') {
    const accepted = acknowledgeBrowserPreferences(await runtime.readBody(req));
    return send(runtime, res, accepted ? 200 : 409, { ok: accepted }, origin);
  }

  if (route === '/diagnostics' && req.method === 'POST') {
    recordCompanionDiagnostics(await runtime.readBody(req));
    return send(runtime, res, 200, { ok: true }, origin);
  }

  if (route === '/extension/update' && req.method === 'POST') {
    const prepared = prepareExtensionUpdate(runtime.extensionBuildOf(req));
    if (prepared?.ready) logInfo(`bridge: extension folder updated to build ${prepared.build}; the extension reloads itself now`);
    else if (prepared) logWarn(`bridge: could not update the extension folder to build ${prepared.build}`);
    return send(runtime, res, 200, prepared ?? { ready: false }, origin);
  }

  return false;
}

function send(runtime: Runtime, res: http.ServerResponse, status: number, body: unknown, origin: string | null): true {
  runtime.json(res, status, body, origin);
  return true;
}

