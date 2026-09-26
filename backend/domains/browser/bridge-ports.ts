import { BROWSER_BRIDGE_PORTS, type BrowserBridgePort } from '../../../contracts/browser/bridge.js';

/** Keep the environment override, including OS-assigned port 0. */
export function bridgePortSelection(choice: BrowserBridgePort = 'auto', raw = process.env.NEURAFLOK_BRIDGE_PORTS): {
  candidates: readonly number[]; overridden: boolean;
} {
  const parsed = (raw ?? '').split(',').map(part => Number.parseInt(part.trim(), 10))
    .filter(value => Number.isInteger(value) && value >= 0 && value <= 65535);
  if (parsed.length) return { candidates: parsed, overridden: true };
  return { candidates: choice === 'auto' ? BROWSER_BRIDGE_PORTS : [choice], overridden: false };
}
