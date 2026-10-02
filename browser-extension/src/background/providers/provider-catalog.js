const PROVIDERS = Object.freeze({
  deepseek: { url: 'https://chat.deepseek.com/', hosts: ['chat.deepseek.com'], prefix: 'ds' },
  kimi: { url: 'https://www.kimi.com/en/', hosts: ['www.kimi.com', 'kimi.com'], prefix: 'km' },
  qwen: { url: 'https://chat.qwen.ai/', hosts: ['chat.qwen.ai'], prefix: 'qw' },
  glm: { url: 'https://z.ai/chat', hosts: ['z.ai', 'chat.z.ai', 'chatglm.cn', 'www.chatglm.cn'], prefix: 'gm' }
});

const PROVIDER_IDS = Object.keys(PROVIDERS);

export function providerForUrl(value) {
  try {
    const address = new URL(String(value || ''));
    if (address.protocol !== 'https:' || address.username || address.password || address.port) return null;
    return PROVIDER_IDS.find(id => PROVIDERS[id].hosts.includes(address.hostname)) || null;
  } catch {
    return null;
  }
}

function failure(code, detail) {
  const message = String(detail?.message || detail || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  return { ok: false, error: code, ...(message ? { detail: message } : {}) };
}

export function createProviderTabs(chrome) {
  function matches(tab, provider) {
    return [tab?.url, tab?.pendingUrl].some(value => providerForUrl(value) === provider);
  }

  function conversationId(value, provider) {
    const prefix = PROVIDERS[provider]?.prefix;
    const id = typeof value === 'string' ? value.trim() : '';
    return prefix && new RegExp(`^${prefix}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, 'i').test(id)
      ? id
      : null;
  }

  async function list(provider) {
    if (!PROVIDERS[provider]) return [];
    const found = new Map();
    const collect = async read => {
      try {
        const tabs = await read();
        for (const tab of Array.isArray(tabs) ? tabs : []) {
          if (Number.isInteger(tab?.id) && matches(tab, provider)) found.set(tab.id, tab);
        }
      } catch {}
    };
    await Promise.all([
      collect(() => chrome.tabs.query({})),
      collect(async () => {
        if (typeof chrome.windows?.getAll !== 'function') return [];
        const windows = await chrome.windows.getAll({ populate: true });
        return windows.flatMap(window => Array.isArray(window?.tabs) ? window.tabs : []);
      })
    ]);
    return [...found.values()];
  }

  async function open(provider) {
    const definition = PROVIDERS[provider];
    if (!definition) return { ok: false, error: 'unsupported_provider' };
    const existing = (await list(provider)).find(tab => !tab.incognito && !tab.discarded && !tab.frozen);
    if (existing) {
      try {
        await chrome.tabs.update(existing.id, { active: true });
        if (Number.isInteger(existing.windowId) && chrome.windows?.update) {
          await chrome.windows.update(existing.windowId, { focused: true });
        }
        return { ok: true, reused: true };
      } catch (error) {
        return failure('activate_failed', error);
      }
    }
    try {
      const tab = await chrome.tabs.create({ url: definition.url, active: true });
      if (!Number.isInteger(tab?.id)) return { ok: false, error: 'tab_id_unavailable' };
      if (globalThis.__integratedBrowserWorker && Number.isInteger(tab.windowId)) {
        try {
          await chrome.windows.update(tab.windowId, { focused: true });
        } catch (error) {
          return failure('focus_failed', error);
        }
      }
      return { ok: true, reused: false };
    } catch (error) {
      return failure('open_failed', error);
    }
  }

  async function restore(provider, tabId) {
    if (!Number.isInteger(tabId) || !PROVIDERS[provider]) return false;
    const target = { tabId };
    const scripts = provider === 'deepseek'
      ? ['src/provider-pages/deepseek/dom-adapter.js', 'src/provider-pages/shared/delivery-agent.js', 'src/provider-pages/deepseek/controller.js']
      : ['src/provider-pages/web/dom-adapter.js', 'src/provider-pages/shared/delivery-agent.js', 'src/provider-pages/web/controller.js'];
    try {
      for (const file of scripts) await chrome.scripting.executeScript({ target, files: [file] });
      if (provider === 'deepseek') {
        try {
          await chrome.scripting.insertCSS({ target, files: ['src/provider-pages/deepseek/companion.css'] });
        } catch {}
      }
      return true;
    } catch {
      return false;
    }
  }

  async function waitUntilReady(tabId) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        if ((await chrome.tabs.get(tabId))?.status === 'complete') return true;
      } catch {
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
  }

  return {
    catalog: PROVIDERS,
    conversationPrefixes: Object.fromEntries(PROVIDER_IDS.map(id => [id, PROVIDERS[id].prefix])),
    providerForUrl,
    matches,
    conversationId,
    pageType: (provider, action) => provider === 'deepseek'
      ? `neuraflok-deepseek-${action}`
      : `neuraflok-provider-${action}`,
    list,
    open,
    restore,
    waitUntilReady,
    usable: tab => Number.isInteger(tab?.id) && tab.status !== 'loading' && tab.discarded !== true && tab.frozen !== true
  };
}
