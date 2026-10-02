import { createBridgeStore } from './bridge-store.js';
import { createWakeChannel } from './wake-channel.js';

const PORTS = [8765, 8766, 8767, 8768, 8769];
const BRIDGE_PROTOCOL = 16;
const CONNECT_TIMEOUT_MS = 1200;
const REQUEST_TIMEOUT_MS = 10_000;
const PORT_CACHE_MS = 30_000;

export function createBridgeClient(chrome, onDisconnect = () => undefined) {
  const store = createBridgeStore(chrome);
  const state = {
    port: null,
    token: null,
    browserId: '',
    disconnected: false,
    compatible: null,
    appVersion: null,
    appProtocol: null,
    buildId: '',
    pairError: null
  };
  let loaded = false;
  let loadFlight = null;
  let discoveryFlight = null;
  let pairingFlight = null;
  let pairingKey = null;
  let connectionEpoch = 0;
  let lastPortCheckAt = 0;

  const wake = createWakeChannel(() => ({
    port: state.port,
    token: state.token,
    disconnected: state.disconnected,
    host: globalThis.__integratedBrowserWorker ? 'integrated' : 'browser'
  }));
  const buildStamp = readBuildStamp();

  async function readBuildStamp() {
    try {
      const response = await fetch(chrome.runtime.getURL('build-stamp.txt'));
      const value = (await response.text()).trim();
      return /^[0-9a-f]{12}$/.test(value) ? value : '';
    } catch {
      return '';
    }
  }

  async function load() {
    if (loaded) return;
    if (!loadFlight) {
      const flight = store.load().then(saved => {
        Object.assign(state, saved);
        loaded = true;
      }).catch(error => {
        if (loadFlight === flight) loadFlight = null;
        throw error;
      });
      loadFlight = flight;
    }
    await loadFlight;
  }

  async function persist() {
    await store.save(state);
  }

  async function requestHeaders() {
    await load();
    if (!state.buildId) state.buildId = await buildStamp;
    let version = '0';
    try {
      version = chrome.runtime.getManifest().version;
    } catch {}
    return {
      'x-extension-version': version,
      'x-extension-protocol': String(BRIDGE_PROTOCOL),
      'x-extension-browser': state.browserId,
      'x-extension-host': globalThis.__integratedBrowserWorker ? 'integrated' : 'browser',
      ...(state.buildId ? { 'x-extension-build': state.buildId } : {})
    };
  }

  async function fetchBounded(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const externalSignal = init.signal;
    let timedOut = false;
    const abort = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener?.('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('bridge_timeout'));
    }, timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (timedOut) throw new Error('bridge_timeout');
      throw error;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener?.('abort', abort);
    }
  }

  function connection() {
    return {
      port: state.port,
      paired: state.token !== null,
      compatible: state.compatible !== false,
      version: state.appVersion,
      bridge: state.appProtocol
    };
  }

  async function latchDisconnect() {
    const notify = !state.disconnected || state.token !== null;
    connectionEpoch += 1;
    state.token = null;
    state.disconnected = true;
    await persist();
    wake.close();
    if (notify) await onDisconnect();
  }

  async function inspectPort(candidate) {
    try {
      const response = await fetchBounded('http://127.0.0.1:' + candidate + '/hello', {
        cache: 'no-store',
        headers: await requestHeaders()
      }, CONNECT_TIMEOUT_MS);
      if (!response.ok) return null;
      const data = await response.json();
      if (data?.app !== 'neuraflok') return null;
      if (data.disconnected === true && !state.disconnected) await latchDisconnect();
      state.compatible = data.compatible !== false && data.bridge === BRIDGE_PROTOCOL;
      state.appVersion = typeof data.version === 'string' ? data.version : null;
      state.appProtocol = Number.isFinite(Number(data.bridge)) ? Number(data.bridge) : null;
      return { ...data, port: candidate };
    } catch {
      return null;
    }
  }

  async function discover(force = false) {
    await load();
    if (discoveryFlight) return discoveryFlight;
    if (state.port !== null && !force && Date.now() - lastPortCheckAt < PORT_CACHE_MS) return connection();
    const flight = (async () => {
      const candidates = !force && state.port !== null
        ? [state.port, ...PORTS.filter(candidate => candidate !== state.port)]
        : PORTS;
      for (const candidate of candidates) {
        const found = await inspectPort(candidate);
        if (!found) continue;
        state.port = candidate;
        lastPortCheckAt = Date.now();
        await persist();
        return connection();
      }
      state.port = null;
      lastPortCheckAt = 0;
      state.compatible = null;
      state.appVersion = null;
      state.appProtocol = null;
      await persist();
      return null;
    })();
    discoveryFlight = flight;
    try {
      return await flight;
    } finally {
      if (discoveryFlight === flight) discoveryFlight = null;
    }
  }

  async function pairOnce(intentEpoch, reconnect) {
    const found = await discover(true);
    if (!found) return { ok: false, error: 'app_not_found' };
    if (found.compatible === false) return { ok: false, error: 'incompatible_extension' };
    if (state.disconnected && !reconnect) return { ok: false, error: 'disconnected' };
    const acceptedEpoch = reconnect && state.disconnected ? connectionEpoch : intentEpoch;
    try {
      const response = await fetchBounded('http://127.0.0.1:' + found.port + '/pair', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', ...(await requestHeaders()) },
        body: JSON.stringify(reconnect ? { reconnect: true } : { reuse: true })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || typeof data.token !== 'string') {
        if (data?.error === 'browser_disconnected') await latchDisconnect();
        return { ok: false, error: data?.error || 'HTTP ' + response.status, message: data?.message || '' };
      }
      if (acceptedEpoch !== connectionEpoch) return { ok: false, error: 'disconnected' };
      state.token = data.token;
      state.disconnected = false;
      state.pairError = null;
      await persist();
      wake.connect();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }

  function pair(reconnect = false) {
    const intentEpoch = connectionEpoch;
    const key = String(intentEpoch) + ':' + String(reconnect);
    if (pairingFlight && pairingKey === key) return pairingFlight;
    const flight = pairOnce(intentEpoch, reconnect).then(result => {
      state.pairError = result.ok ? null : {
        error: String(result.error || 'pair_failed'),
        message: String(result.message || '')
      };
      return result;
    }).finally(() => {
      if (pairingFlight === flight) {
        pairingFlight = null;
        pairingKey = null;
      }
    });
    pairingFlight = flight;
    pairingKey = key;
    return flight;
  }

  async function request(route, init = {}, retried = false) {
    await load();
    const found = await discover();
    if (!found) return { ok: false, status: 0, error: 'app_not_found' };
    if (!found.compatible) return { ok: false, status: 426, error: 'incompatible_extension' };
    if (!state.token) {
      if (state.disconnected) return { ok: false, status: 401, error: 'disconnected' };
      const paired = await pair(false);
      if (!paired.ok) return { ok: false, status: 401, error: paired.error || 'not_paired' };
    }
    const { timeoutMs = REQUEST_TIMEOUT_MS, ...options } = init;
    try {
      const response = await fetchBounded('http://127.0.0.1:' + found.port + route, {
        ...options,
        cache: 'no-store',
        headers: {
          ...(init.headers || {}),
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(await requestHeaders()),
          authorization: 'Bearer ' + state.token
        }
      }, timeoutMs);
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) {
        if (data?.error === 'browser_disconnected') {
          await latchDisconnect();
          return { ok: false, status: 401, error: 'disconnected', data };
        }
        state.token = null;
        await persist();
        if (retried) return { ok: false, status: 401, error: 'not_paired' };
        return request(route, init, true);
      }
      if (response.ok) wake.connect();
      return { ok: response.ok, status: response.status, data };
    } catch (error) {
      const detail = String(error?.message || error);
      if (detail === 'bridge_timeout') return { ok: false, status: 0, error: 'bridge_timeout', retryable: true };
      lastPortCheckAt = 0;
      return { ok: false, status: 0, error: detail };
    }
  }

  async function status() {
    await load();
    const found = await discover();
    if (found && !state.token && !state.disconnected) await pair(false);
    let extensionVersion = '0';
    try {
      extensionVersion = chrome.runtime.getManifest().version;
    } catch {}
    return {
      connected: found !== null,
      port: found?.port ?? null,
      paired: state.token !== null,
      disconnected: state.disconnected,
      compatible: found ? found.compatible !== false : null,
      appVersion: found?.version ?? null,
      appProtocol: found?.bridge ?? null,
      extensionVersion,
      extensionProtocol: BRIDGE_PROTOCOL,
      ...(state.pairError ? { pairError: state.pairError } : {})
    };
  }

  async function ensurePaired() {
    await load();
    if (state.token || state.disconnected) return false;
    return (await pair(false)).ok;
  }

  return {
    load,
    discover,
    request,
    pair: () => pair(true),
    status,
    ensurePaired,
    connectWakeSocket: wake.connect,
    closeWakeSocket: wake.close,
    setWakeHandler: wake.setHandler,
    get state() { return { ...state }; }
  };
}
