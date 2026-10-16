import http from 'node:http';
import { handleBridgeActivityRoutes } from './bridge-activity-routes.js';
import { handleBridgeCommandRoutes } from './command-broker/routes.js';
import { handleBridgeContinuationRoutes } from './bridge-continuation-routes.js';
import { handleBridgeGoalDraftRoute, handleBridgeSettingsRoutes } from './bridge-automation-routes.js';
import { handleBridgeStatusRoute } from './bridge-status-route.js';
import { handleBridgeSessionRoutes } from './bridge-session-routes.js';
import { handleBridgePairingRoutes } from './bridge-pairing-routes.js';
import { handleBridgeCompanionRoutes } from './bridge-companion-routes.js';
import { handleProviderPageRoute } from '../providers/bridge-routes.js';
import {
  handleGoalAcknowledgementRoute,
  handleGoalObjectiveRoute,
  handleGoalOpeningRoute
} from '../automation/bridge-routes.js';

type HttpBoundary = {
  originOf(req: http.IncomingMessage): { ok: boolean; origin: string | null };
  json(res: http.ServerResponse, status: number, body: unknown, origin: string | null): void;
  browserDisconnected(): Promise<boolean>;
  authorised(req: http.IncomingMessage): Promise<boolean>;
  protocolCompatible(req: http.IncomingMessage): boolean;
  rateLimited(): boolean;
};

type RouteRuntime = {
  pairing: Parameters<typeof handleBridgePairingRoutes>[4];
  companion: Parameters<typeof handleBridgeCompanionRoutes>[4];
  status: Parameters<typeof handleBridgeStatusRoute>[5];
  providerPage: Parameters<typeof handleProviderPageRoute>[5];
  sessions: Parameters<typeof handleBridgeSessionRoutes>[4];
  activity: Parameters<typeof handleBridgeActivityRoutes>[6];
  continuation: Parameters<typeof handleBridgeContinuationRoutes>[4];
  goalDraft: Parameters<typeof handleBridgeGoalDraftRoute>[4];
  goalAcknowledgement: Parameters<typeof handleGoalAcknowledgementRoute>[4];
  goalObjective: Parameters<typeof handleGoalObjectiveRoute>[4];
  goalOpening: Parameters<typeof handleGoalOpeningRoute>[4];
  settings: Parameters<typeof handleBridgeSettingsRoutes>[4];
  commands: Parameters<typeof handleBridgeCommandRoutes>[4];
};

export interface BridgeHttpRouterRuntime {
  boundary: HttpBoundary;
  appVersion: string;
  bridgeProtocol: number;
  noteExtensionVersion(req: http.IncomingMessage): void;
  noteBrowserSeen(req: http.IncomingMessage): boolean;
  changed(): void;
  extensionHost(req: http.IncomingMessage): 'integrated' | 'browser' | null;
  routes: RouteRuntime;
}

export function createBridgeHttpRequestHandler(getRuntime: () => BridgeHttpRouterRuntime) {
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const runtime = getRuntime();
    const boundary = runtime.boundary;
    const receivedAt = Date.now();
    const { ok: originAllowed, origin } = boundary.originOf(req);
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = url.pathname;

    if (req.method === 'OPTIONS') {
      if (!origin) return boundary.json(res, 403, { error: 'forbidden_origin' }, null);
      res.writeHead(204, {
        'access-control-allow-origin': origin,
        'access-control-allow-headers': 'authorization, content-type, x-extension-version, x-extension-protocol, x-extension-build, x-extension-browser, x-extension-host',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-private-network': 'true',
        'access-control-max-age': '600'
      });
      res.end();
      return;
    }

    if (!originAllowed) return boundary.json(res, 403, { error: 'forbidden_origin' }, null);
    runtime.noteExtensionVersion(req);

    if (await handleBridgePairingRoutes(route, req, res, origin, runtime.routes.pairing)) return;
    if (await boundary.browserDisconnected()) return boundary.json(res, 401, { error: 'browser_disconnected' }, origin);
    if (!(await boundary.authorised(req))) return boundary.json(res, 401, { error: 'unauthorised' }, origin);
    if (!boundary.protocolCompatible(req)) {
      return boundary.json(res, 426, { error: 'incompatible_extension', bridge: runtime.bridgeProtocol, version: runtime.appVersion }, origin);
    }
    if (boundary.rateLimited()) return boundary.json(res, 429, { error: 'rate_limited' }, origin);
    if (runtime.noteBrowserSeen(req)) runtime.changed();

    if (await handleBridgeCompanionRoutes(route, req, res, origin, runtime.routes.companion)) return;
    if (await handleBridgeStatusRoute(route, req, res, origin, url, runtime.routes.status)) return;
    if (await handleProviderPageRoute(route, req, res, origin, runtime.extensionHost(req) === 'integrated', runtime.routes.providerPage)) return;
    if (await handleBridgeSessionRoutes(route, req, res, origin, runtime.routes.sessions)) return;
    if (await handleBridgeActivityRoutes(route, req, res, origin, url, receivedAt, runtime.routes.activity)) return;
    if (await handleBridgeContinuationRoutes(route, req, res, origin, runtime.routes.continuation)) return;
    if (await handleBridgeGoalDraftRoute(route, req, res, origin, runtime.routes.goalDraft)) return;
    if (await handleGoalAcknowledgementRoute(route, req, res, origin, runtime.routes.goalAcknowledgement)) return;
    if (await handleGoalObjectiveRoute(route, req, res, origin, runtime.routes.goalObjective)) return;
    if (await handleGoalOpeningRoute(route, req, res, origin, runtime.routes.goalOpening)) return;
    if (await handleBridgeSettingsRoutes(route, req, res, origin, runtime.routes.settings)) return;
    if (await handleBridgeCommandRoutes(route, req, res, origin, runtime.routes.commands)) return;

    boundary.json(res, 404, { error: 'not_found' }, origin);
  };
}
