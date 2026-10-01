import { createActiveTabPersistence } from './persistence.js';
import { isActiveProviderTab, MAX_ACTIVE_PROVIDER_TABS } from './policy.js';

export function createActiveTabs(chrome) {
  const persistence = createActiveTabPersistence(chrome);
  const scopes = new Map();
  const states = new Map();
  const retiring = new Set();
  const cancelled = new Map();
  let syncing = null;
  let again = false;

  const loaded = persistence.restore().then(restored => {
    for (const tab of restored) {
      if (tab.attached) retiring.add({ id: tab.id, url: tab.url, attached: true });
      if (tab.failed) cancelled.set(tab.id, tab.url);
    }
  });
  const save = () => persistence.save([...states.values(), ...retiring]);

  async function detach(state) {
    if (!state.attached) return;
    try {
      await chrome.debugger.detach({ tabId: state.id });
    } catch {
      const targets = await chrome.debugger.getTargets();
      if (targets.some(target => target.tabId === state.id && target.attached)) throw new Error('Active tab release remains pending');
    }
    state.attached = false;
  }

  function current(state) {
    return states.get(state.id) === state && !state.cancelled;
  }

  async function attach(state) {
    if (cancelled.get(state.id) === state.url) state.failed = true;
    if (state.attached || state.failed || !current(state)) return;
    const tab = await chrome.tabs.get(state.id).catch(() => null);
    if (!current(state) || !isActiveProviderTab(tab) || tab.url !== state.url) return;
    state.attaching = true;
    try {
      await chrome.debugger.attach({ tabId: state.id }, '1.3');
    } catch {
      state.failed = true;
      return;
    } finally {
      state.attaching = false;
    }
    state.attached = true;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: state.id },
        injectImmediately: true,
        func: () => location.href
      });
      const proof = results?.find(result => result.frameId === 0 &&
        typeof result.documentId === 'string' && result.result === state.url);
      if (!current(state) || !proof) throw new Error('Provider document is unavailable');
      state.documentId = proof.documentId;
      await save();
      const latest = await chrome.tabs.get(state.id);
      if (!current(state) || !isActiveProviderTab(latest) || latest.url !== state.url) throw new Error('Tab changed');
      await chrome.debugger.sendCommand({ tabId: state.id }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
      if (!current(state)) throw new Error('Activity ended');
    } catch {
      state.failed = true;
      await detach(state);
    }
  }

  function sync() {
    if (syncing) {
      again = true;
      return syncing;
    }
    syncing = (async () => {
      await loaded;
      do {
        again = false;
        for (const state of retiring) {
          await detach(state);
          retiring.delete(state);
        }
        for (const [id, url] of cancelled) if (states.get(id)?.url !== url) cancelled.delete(id);
        for (const state of states.values()) await attach(state);
        await save();
      } while (again);
    })().finally(() => { syncing = null; });
    return syncing;
  }

  function project() {
    const wanted = new Map();
    for (const scope of scopes.values()) {
      for (const tab of scope.tabs) {
        if (isActiveProviderTab(tab) && wanted.size < MAX_ACTIVE_PROVIDER_TABS) wanted.set(tab.id, tab);
      }
    }
    for (const [id, state] of states) {
      if (wanted.get(id)?.url === state.url) continue;
      state.cancelled = true;
      states.delete(id);
      if (state.attached || state.attaching) retiring.add(state);
    }
    for (const [id, tab] of wanted) if (!states.has(id)) states.set(id, { id, url: tab.url, attached: false, failed: false });
    return sync();
  }

  return {
    set(scope, tabs, eligible = null) {
      if (tabs.length) scopes.set(scope, { tabs: tabs.filter(isActiveProviderTab).slice(0, MAX_ACTIVE_PROVIDER_TABS), eligible });
      else scopes.delete(scope);
      return project();
    },
    owns(id) {
      return states.has(id) || [...retiring].some(state => state.id === id);
    },
    documentId(id) {
      return states.get(id)?.documentId ?? null;
    },
    revoke() {
      scopes.clear();
      return project();
    },
    navigation(id, tab = null) {
      if (!states.has(id) && ![...retiring].some(state => state.id === id)) return Promise.resolve();
      let retained = false;
      for (const scope of scopes.values()) {
        const keep = scope.tabs.some(previous => previous.id === id) && tab?.id === id &&
          isActiveProviderTab(tab) && scope.eligible?.(tab) === true;
        scope.tabs = scope.tabs.flatMap(previous => previous.id !== id ? [previous] : keep ? [tab] : []);
        retained ||= keep;
      }
      const state = states.get(id);
      if (retained && state) {
        if (cancelled.get(id) === state.url) cancelled.set(id, tab.url);
        state.url = tab.url;
      }
      return project();
    },
    detached({ tabId }) {
      const old = [...retiring].find(state => state.id === tabId && state.attached);
      if (old) {
        old.attached = false;
        return sync();
      }
      const state = states.get(tabId);
      if (!state) return Promise.resolve();
      state.attached = false;
      state.failed = true;
      cancelled.set(tabId, state.url);
      return sync();
    }
  };
}
