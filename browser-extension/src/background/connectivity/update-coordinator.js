const UPDATE_ATTEMPT_KEY = 'neuraflokExtensionUpdateAttempt';
const LEGACY_UPDATE_ATTEMPT_KEY = 'neuralJamExtensionUpdateAttempt';

export function createExtensionUpdater({ bridge, chrome, isBusy }) {
  let hold = null;

  async function update(offer) {
    const build = typeof offer?.build === 'string' && /^[0-9a-f]{12}$/.test(offer.build) ? offer.build : null;
    const running = bridge.state.buildId;
    if (!build || !running || running === build) {
      hold = null;
      return;
    }
    if (offer.busy !== false) {
      hold = 'app-busy';
      return;
    }
    if (isBusy()) {
      hold = 'browser-work';
      return;
    }

    const attempt = `${running}>${build}`;
    const saved = await chrome.storage.local.get([UPDATE_ATTEMPT_KEY, LEGACY_UPDATE_ATTEMPT_KEY]);
    if (saved[UPDATE_ATTEMPT_KEY] === attempt || saved[LEGACY_UPDATE_ATTEMPT_KEY] === attempt) {
      if (saved[UPDATE_ATTEMPT_KEY] !== attempt) await chrome.storage.local.set({ [UPDATE_ATTEMPT_KEY]: attempt });
      await chrome.storage.local.remove(LEGACY_UPDATE_ATTEMPT_KEY);
      hold = 'already-tried';
      return;
    }
    await chrome.storage.local.remove(LEGACY_UPDATE_ATTEMPT_KEY);

    const prepared = await bridge.request('/extension/update', { method: 'POST', body: '{}' });
    if (!prepared.ok || prepared.data?.ready !== true || prepared.data.build !== build) {
      hold = 'folder-not-ready';
      return;
    }
    await chrome.storage.local.set({ [UPDATE_ATTEMPT_KEY]: attempt });
    await chrome.storage.local.remove(LEGACY_UPDATE_ATTEMPT_KEY);
    hold = null;
    setTimeout(() => {
      try { chrome.runtime.reload(); } catch {}
    }, 0);
  }

  return { update, get hold() { return hold; } };
}
