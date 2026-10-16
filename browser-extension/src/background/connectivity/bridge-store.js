const BRIDGE_PORTS = new Set([8765, 8766, 8767, 8768, 8769]);
const BROWSER_ID = /^[a-f\d]{32}$/i;
const BROWSER_ID_KEY = 'neuraflokBrowserId';
const LEGACY_BROWSER_ID_KEYS = ['neuralJamBrowserId', 'browserId'];

function createBrowserId() {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createBridgeStore(chrome) {
  async function load() {
    const saved = await chrome.storage.local.get(['port', 'token', 'disconnected', BROWSER_ID_KEY, ...LEGACY_BROWSER_ID_KEYS]);
    const currentId = validBrowserId(saved[BROWSER_ID_KEY])
      ? saved[BROWSER_ID_KEY]
      : validBrowserId(saved.neuralJamBrowserId)
        ? saved.neuralJamBrowserId
        : validBrowserId(saved.browserId)
          ? saved.browserId
          : createBrowserId();
    const state = {
      port: BRIDGE_PORTS.has(Number(saved.port)) ? Number(saved.port) : null,
      token: typeof saved.token === 'string' && saved.token.length > 0 ? saved.token : null,
      disconnected: saved.disconnected === true,
      browserId: currentId
    };
    await save(state);
    await chrome.storage.local.remove(LEGACY_BROWSER_ID_KEYS);
    return state;
  }

  function validBrowserId(value) {
    return typeof value === 'string' && BROWSER_ID.test(value);
  }

  async function save(state) {
    await chrome.storage.local.set({
      port: BRIDGE_PORTS.has(Number(state.port)) ? Number(state.port) : null,
      token: typeof state.token === 'string' && state.token.length > 0 ? state.token : null,
      disconnected: state.disconnected === true,
      [BROWSER_ID_KEY]: BROWSER_ID.test(String(state.browserId || '')) ? state.browserId : createBrowserId()
    });
  }

  return { load, save };
}
