// Installs Chrome API adapters in the worker world without module references.
export function installChromeShim(trace: boolean): void {
  const bridge = (globalThis as unknown as {
    __integratedBrowserWorker: { call(name: string, args: unknown[]): Promise<unknown>; subscribe(fn: (name: string, args: unknown[]) => void): void };
  }).__integratedBrowserWorker;
  const chrome = (globalThis as unknown as { chrome: Record<string, Record<string, unknown>> }).chrome;
  if (!chrome?.runtime || !chrome.tabs) return;
  const tabs = chrome.tabs;

  const events = new Map<string, Set<(...args: unknown[]) => void>>();
  const event = (name: string) => {
    const listeners = new Set<(...args: unknown[]) => void>();
    events.set(name, listeners);
    return {
      addListener: (listener: (...args: unknown[]) => void) => { listeners.add(listener); },
      removeListener: (listener: (...args: unknown[]) => void) => { listeners.delete(listener); },
      hasListener: (listener: (...args: unknown[]) => void) => listeners.has(listener),
      hasListeners: () => listeners.size > 0
    };
  };
  bridge.subscribe((name, args) => {
    for (const listener of [...(events.get(name) ?? [])]) {
      try { listener(...args); } catch (error) { console.error(error); }
    }
  });

  // Support promise calls and Chrome's callback style.
  const method = (name: string) => (...args: unknown[]) => {
    const callback = typeof args.at(-1) === 'function' ? args.pop() as (value?: unknown) => void : null;
    const result = bridge.call(name, args);
    if (!callback) return result;
    result.then(value => callback(value), (error: Error) => {
      const runtime = chrome.runtime as Record<string, unknown>;
      runtime.lastError = { message: error.message };
      try { callback(); } finally { delete runtime.lastError; }
    });
    return undefined;
  };

  // Keep native messaging and replace only APIs backed by the embedded browser.
  Object.assign(tabs, {
    TAB_ID_NONE: -1,
    query: method('tabs.query'),
    get: method('tabs.get'),
    getCurrent: () => Promise.resolve(undefined),
    create: method('tabs.create'),
    update: method('tabs.update'),
    reload: method('tabs.reload'),
    move: method('tabs.move'),
    remove: method('tabs.remove'),
    onCreated: event('tabs.onCreated'),
    onUpdated: event('tabs.onUpdated'),
    onActivated: event('tabs.onActivated'),
    onMoved: event('tabs.onMoved'),
    onDetached: event('tabs.onDetached'),
    onAttached: event('tabs.onAttached'),
    onRemoved: event('tabs.onRemoved'),
    onHighlighted: event('tabs.onHighlighted'),
    onReplaced: event('tabs.onReplaced'),
    onZoomChange: event('tabs.onZoomChange')
  });
  chrome.windows = {
    WINDOW_ID_NONE: -1,
    WINDOW_ID_CURRENT: -2,
    get: method('windows.get'),
    getAll: method('windows.getAll'),
    getCurrent: method('windows.getLastFocused'),
    getLastFocused: method('windows.getLastFocused'),
    create: method('windows.create'),
    update: method('windows.update'),
    remove: method('windows.remove'),
    onCreated: event('windows.onCreated'),
    onRemoved: event('windows.onRemoved'),
    onFocusChanged: event('windows.onFocusChanged'),
    onBoundsChanged: event('windows.onBoundsChanged')
  };
  chrome.alarms = {
    create: method('alarms.create'),
    get: method('alarms.get'),
    getAll: method('alarms.getAll'),
    clear: method('alarms.clear'),
    clearAll: method('alarms.clearAll'),
    onAlarm: event('alarms.onAlarm')
  };
  // Trace slow Electron-backed calls when explicitly enabled.
  if (trace) {
    let next = 0;
    const timed = (owner: Record<string, unknown>, name: string, label: string) => {
      const original = owner[name] as ((...args: unknown[]) => unknown) | undefined;
      if (typeof original !== 'function') return;
      owner[name] = function (this: unknown, ...args: unknown[]) {
        const id = ++next;
        const started = Date.now();
        const target = args[0] && typeof args[0] === 'object' ? JSON.stringify(args[0]).slice(0, 120) : String(args[0]);
        const result = original.apply(this, args);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          const late = setTimeout(() => console.warn(`NEURAFLOK trace: ${label} #${id} ${target} still pending after 10 s`), 10_000);
          (result as Promise<unknown>).then(
            () => { clearTimeout(late); console.info(`NEURAFLOK trace: ${label} #${id} ${target} done in ${Date.now() - started} ms`); },
            (error: Error) => { clearTimeout(late); console.info(`NEURAFLOK trace: ${label} #${id} ${target} failed in ${Date.now() - started} ms: ${error?.message}`); });
        }
        return result;
      };
    };
    timed(tabs, 'sendMessage', 'tabs.sendMessage');
    timed(chrome.scripting as Record<string, unknown>, 'executeScript', 'scripting.executeScript');
    timed(chrome.scripting as Record<string, unknown>, 'insertCSS', 'scripting.insertCSS');
  }
  // Forward the startup event emitted by the app.
  Object.defineProperty(chrome.runtime, 'onStartup', { value: event('runtime.onStartup'), configurable: true, writable: true });
  // A small, correlated command channel lets the app ask this exact browser
  // profile to restore a conversation from its persistent extension storage.
  Object.defineProperty(chrome.runtime, 'onNeuraflokReveal', {
    value: event('neuraflok.reveal-provider-conversation'), configurable: true, writable: true
  });
  Object.defineProperty(chrome.runtime, 'neuraflokRevealResult', {
    value: (requestId: string, shown: boolean) => bridge.call('neuraflok.reveal-result', [requestId, shown]),
    configurable: true, writable: true
  });
  chrome.debugger = {
    attach: method('debugger.attach'),
    detach: method('debugger.detach'),
    sendCommand: method('debugger.sendCommand'),
    getTargets: method('debugger.getTargets'),
    onEvent: event('debugger.onEvent'),
    onDetach: event('debugger.onDetach')
  };
  // Report only permissions declared by the installed extension manifest.
  const manifest = (chrome.runtime.getManifest as () => { permissions?: string[]; host_permissions?: string[] })();
  chrome.permissions ??= {};
  Object.assign(chrome.permissions, {
    contains: (request: { permissions?: string[]; origins?: string[] } = {}, callback?: (granted: boolean) => void) => {
      const granted = (request.permissions ?? []).every(permission => manifest.permissions?.includes(permission)) &&
        (request.origins ?? []).every(origin => manifest.host_permissions?.includes(origin));
      if (callback) { callback(granted); return undefined; }
      return Promise.resolve(granted);
    }
  });
}
