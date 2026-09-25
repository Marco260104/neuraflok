import type { Server } from 'node:http';
import type { attachBrowserWake } from './browser-wake.js';
import type { createBridgeServerLifecycle } from './bridge-server-lifecycle.js';

export const bridgeRuntimeState = {
  browserWake: null as ReturnType<typeof attachBrowserWake> | null,
  observationWritesInFlight: 0,
  server: null as Server | null,
  port: null as number | null,
  silenceTimer: null as NodeJS.Timeout | null,
  bridgeRecovering: false,
  bridgeError: null as string | null,
  bridgeServerLifecycle: null as ReturnType<typeof createBridgeServerLifecycle> | null,
  pickupWatchFloor: null as number | null,
  compactionWatchFloor: null as number | null,
  placementCollector: null as string | null
};
