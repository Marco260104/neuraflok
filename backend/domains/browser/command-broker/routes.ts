import http from 'node:http';
import type { CommandRouteRuntime } from './routes-runtime.js';
import { handlePendingRevivalsRoute } from './pending-revivals-route.js';
import { handleCommandRedeemRoute } from './redeem-route.js';
import { handleCommandStepRoute } from './command-step-route.js';
import { handleCommandAckRoute } from './command-ack-route.js';

// Handles authenticated command delivery routes from the companion extension.
export async function handleBridgeCommandRoutes(route: string, req: http.IncomingMessage, res: http.ServerResponse, origin: string | null, runtime: CommandRouteRuntime): Promise<boolean> {
  if (await handlePendingRevivalsRoute(route, req, res, origin, runtime)) return true;
  if (await handleCommandRedeemRoute(route, req, res, origin, runtime)) return true;
  if (await handleCommandStepRoute(route, req, res, origin, runtime)) return true;
  if (await handleCommandAckRoute(route, req, res, origin, runtime)) return true;
  return false;
}