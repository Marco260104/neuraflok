import { createActiveTabs } from './browser/active-tabs/owner.js';
import { createBridgeClient } from './connectivity/bridge-client.js';
import { createBrowserControl } from './browser/control/controller.js';
import { createExtensionUpdater } from './connectivity/update-coordinator.js';
import { createAppLanguageSync } from './connectivity/language-sync.js';
import { createProviderRuntime } from './providers/session-runtime.js';
import { registerProviderTabLifecycle } from './providers/tab-events.js';

const RETRY_ALARM = 'neuraflok-maintenance';
const LEGACY_RETRY_ALARM = 'neural-jam-maintenance';
const MAINTENANCE_DELAY_MINUTES = 0.5;
const REQUEST_TIMEOUT_MS = 10_000;
const activeTabs = globalThis.chrome?.debugger ? createActiveTabs(chrome) : null;
const appLanguage = createAppLanguageSync(chrome);
let browserController = null;

const bridge = createBridgeClient(chrome, async () => {
  await Promise.all([
    activeTabs?.revoke(),
    browserController?.revoke()
  ].filter(Boolean).map(work => Promise.resolve(work).catch(() => undefined)));
});
const call = (path, init) => bridge.request(path, init);

function tabReply(tabId, message, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  const request = Promise.resolve().then(() => options?.documentId
    ? chrome.tabs.sendMessage(tabId, message, { documentId: options.documentId })
    : chrome.tabs.sendMessage(tabId, message));
  let timer;
  return Promise.race([
    request,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('provider_page_timeout')), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

if (globalThis.chrome?.debugger) {
  browserController = createBrowserControl(chrome, call, tabId => activeTabs?.owns(tabId) === true);
  chrome.debugger.onEvent.addListener((source, method, params) => {
    void browserController.event(source, method, params).catch(() => undefined);
  });
  chrome.debugger.onDetach.addListener(source => {
    void activeTabs?.detached(source).catch(() => undefined);
    void browserController.detached(source).catch(() => undefined);
  });
}

let maintenanceFlight = null;
let maintenanceAgain = false;
let providerRuntime;
let extensionUpdater;

try {
  void Promise.resolve(chrome.alarms?.clear(LEGACY_RETRY_ALARM)).catch(() => undefined);
} catch {}

async function maintainOnce() {
  // A suspended MV3 worker can lose its WebSocket while the desktop app is
  // still running. Restore the lightweight wake channel before probing provider
  // tabs; those probes can each wait several seconds on an unresponsive page.
  await bridge.connectWakeChannel().catch(() => undefined);
  const webProviders = await providerRuntime.inspect();
  const reply = await call('/status', {
    method: 'POST',
    body: JSON.stringify({
      openConversations: [],
      stalledConversations: [],
      canReveal: true,
      webProviders,
      ...(extensionUpdater.hold ? { updateHold: extensionUpdater.hold } : {})
    })
  });
  if (!reply.ok) return;

  const data = reply.data || {};
  await appLanguage.apply(data).catch(() => undefined);
  providerRuntime.inspectOffer(data.providerPage, data.background === true);
  await providerRuntime.revealConversations(data.reveals);
  await extensionUpdater.update(data.extensionUpdate);
  void browserController?.pump().catch(() => undefined);
}

function scheduleMaintenance() {
  try {
    chrome.alarms?.create(RETRY_ALARM, { delayInMinutes: MAINTENANCE_DELAY_MINUTES });
  } catch {}
}

function maintain(force = false) {
  if (maintenanceFlight) {
    if (force) maintenanceAgain = true;
    return maintenanceFlight;
  }
  const work = (async () => {
    do {
      maintenanceAgain = false;
      await maintainOnce();
    } while (maintenanceAgain);
  })().finally(() => {
    if (maintenanceFlight === work) maintenanceFlight = null;
    scheduleMaintenance();
  });
  maintenanceFlight = work;
  return work;
}

providerRuntime = createProviderRuntime({ chrome, activeTabs, call, tabReply, maintain });
extensionUpdater = createExtensionUpdater({
  bridge,
  chrome,
  isBusy: () => providerRuntime.isBusy() || browserController?.busy() === true
});
bridge.setWakeHandler(topic => {
  if (topic === 'browser-control') {
    void browserController?.pump().catch(() => undefined);
    return;
  }
  void browserController?.pump().catch(() => undefined);
  void maintain(true).catch(() => undefined);
});

function isPopup(sender) {
  return sender?.id === chrome.runtime.id && sender?.url === chrome.runtime.getURL('src/popup/index.html');
}

const handlers = {
  ...providerRuntime.handlers,
  async status() {
    const status = await bridge.status();
    return { ...status, pending: providerRuntime.isBusy() ? 1 : 0 };
  },
  async pair() {
    return bridge.pair();
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = typeof message?.type === 'string' ? message.type : '';
  const handler = handlers[type];
  if (!handler) {
    sendResponse({ ok: false, error: 'unknown_message' });
    return false;
  }
  if (['status', 'pair', 'tabStatus', 'open_provider'].includes(type) && !isPopup(sender)) {
    sendResponse({ ok: false, error: 'popup_required' });
    return false;
  }
  Promise.resolve(handler(message, sender)).then(sendResponse, error => {
    sendResponse({ ok: false, error: String(error?.message || error).slice(0, 500) });
  });
  return true;
});

// In the integrated browser this event is routed only to its own extension
// worker. Reply through the embedded API bridge so another browser companion
// cannot claim that it opened this conversation.
chrome.runtime.onNeuraflokReveal?.addListener((requestId, conversationId) => {
  void Promise.resolve(providerRuntime.revealConversation(conversationId))
    .catch(() => false)
    .then(shown => chrome.runtime.neuraflokRevealResult(requestId, shown))
    .catch(() => undefined);
});

registerProviderTabLifecycle(chrome, { activeTabs, providerRuntime, maintain });

function restoreProviderPages() {
  void providerRuntime.restoreOpenPages().catch(() => undefined);
  void maintain(true).catch(() => undefined);
}

chrome.runtime.onInstalled.addListener(restoreProviderPages);
chrome.runtime.onStartup?.addListener(restoreProviderPages);
chrome.alarms?.onAlarm.addListener(alarm => {
  if (alarm?.name === RETRY_ALARM) void maintain(true).catch(() => undefined);
});

scheduleMaintenance();
void maintain().catch(() => undefined);
