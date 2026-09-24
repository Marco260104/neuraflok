import { z } from 'zod';

export const BROWSER_BRIDGE_PORTS = [
  8765,
  8766,
  8767,
  8768,
  8769
] as const;

export const browserBridgePortSchema = z.union([z.literal('auto'), z.literal(BROWSER_BRIDGE_PORTS)]);

export type BrowserBridgePort = z.infer<typeof browserBridgePortSchema>;
