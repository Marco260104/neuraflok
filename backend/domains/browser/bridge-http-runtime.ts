import type http from 'node:http';
import { goalErrorKey, goalErrorMessage } from '../../../contracts/goal-errors.js';
import { recoveryBusyMs } from '../../../contracts/recovery.js';
import type { BridgeHttpRouterRuntime } from './bridge-http-router.js';
import { createBridgeHttpRequestHandler } from './bridge-http-router.js';
import type { createBridgeHttpBoundary } from './bridge-http-boundary.js';
import { createBridgeRouteRuntimes } from './bridge-route-runtimes.js';
import { conversationId } from './companion-payload.js';

type RouteRuntimes = ReturnType<typeof createBridgeRouteRuntimes>;
type RouteRuntimeDependencies = Omit<Parameters<typeof createBridgeRouteRuntimes>[0], 'goalJson'>;

export let bridgeCommandRouteRuntime: RouteRuntimes['bridgeCommandRouteRuntime'];
export let bridgeRecoveryObservationRuntime: RouteRuntimes['bridgeRecoveryObservationRuntime'];
export let bridgeStatusRouteRuntime: RouteRuntimes['bridgeStatusRouteRuntime'];
export let bridgeSessionRouteRuntime: RouteRuntimes['bridgeSessionRouteRuntime'];
export let bridgePairingRouteRuntime: RouteRuntimes['bridgePairingRouteRuntime'];
export let bridgeActivityRouteRuntime: RouteRuntimes['bridgeActivityRouteRuntime'];
export let bridgeContinuationRouteRuntime: RouteRuntimes['bridgeContinuationRouteRuntime'];
export let bridgeAutomationRouteRuntime: RouteRuntimes['bridgeAutomationRouteRuntime'];

interface BridgeHttpRuntimeOptions {
  appVersion: string;
  boundary: ReturnType<typeof createBridgeHttpBoundary>;
  bridgeProtocol: number;
  changed(): void;
  extensionHost: BridgeHttpRouterRuntime['extensionHost'];
  getExtendedSilenceWindowFor(): BridgeHttpRouterRuntime['routes']['goalAcknowledgement']['extendedSilenceWindowFor'];
  goalMode: BridgeHttpRouterRuntime['routes']['goalOpening']['goalMode'];
  noteBrowserSeen(req: http.IncomingMessage): boolean;
  noteExtensionVersion(req: http.IncomingMessage): void;
  saveConversationObjective: BridgeHttpRouterRuntime['routes']['goalObjective']['saveObjective'];
}

export function createBridgeHttpRuntime(options: BridgeHttpRuntimeOptions) {
  let routeRuntimes: RouteRuntimes;

  const goalJson = (res: http.ServerResponse, status: number, body: unknown, origin: string | null): void => {
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' && !('message' in body)) {
      body = { ...body, message: goalErrorMessage(body.error), messageKey: goalErrorKey(body.error) };
    }
    options.boundary.json(res, status, body, origin);
  };

  const handleRequest = createBridgeHttpRequestHandler(() => {
    const { readBody, json, tooLarge } = options.boundary;
    return {
      boundary: options.boundary,
      appVersion: options.appVersion,
      bridgeProtocol: options.bridgeProtocol,
      noteExtensionVersion: options.noteExtensionVersion,
      noteBrowserSeen: options.noteBrowserSeen,
      changed: options.changed,
      extensionHost: options.extensionHost,
      routes: {
        pairing: routeRuntimes.bridgePairingRouteRuntime,
        companion: routeRuntimes.bridgeCompanionRouteRuntime,
        status: routeRuntimes.bridgeStatusRouteRuntime,
        providerPage: { readBody, json, tooLarge },
        sessions: routeRuntimes.bridgeSessionRouteRuntime,
        activity: routeRuntimes.bridgeActivityRouteRuntime,
        continuation: routeRuntimes.bridgeContinuationRouteRuntime,
        goalDraft: routeRuntimes.bridgeAutomationRouteRuntime,
        goalAcknowledgement: {
          readBody,
          json: goalJson,
          tooLarge,
          conversationId,
          extendedSilenceWindowFor: options.getExtendedSilenceWindowFor(),
          recoveryBusyMs
        },
        goalObjective: { readBody, json: goalJson, tooLarge, conversationId, saveObjective: options.saveConversationObjective },
        goalOpening: { readBody, json: goalJson, tooLarge, goalMode: options.goalMode },
        settings: routeRuntimes.bridgeAutomationRouteRuntime,
        commands: routeRuntimes.bridgeCommandRouteRuntime
      }
    };
  });

  function initializeRouteRuntimes(dependencies: RouteRuntimeDependencies): RouteRuntimes {
    routeRuntimes = createBridgeRouteRuntimes({ ...dependencies, goalJson });
    ({
      bridgeCommandRouteRuntime,
      bridgeRecoveryObservationRuntime,
      bridgeStatusRouteRuntime,
      bridgeSessionRouteRuntime,
      bridgePairingRouteRuntime,
      bridgeActivityRouteRuntime,
      bridgeContinuationRouteRuntime,
      bridgeAutomationRouteRuntime
    } = routeRuntimes);
    return routeRuntimes;
  }

  return { goalJson, handleRequest, initializeRouteRuntimes };
}
