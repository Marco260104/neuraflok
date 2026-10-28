export async function openFreshDeepseekChat({
  chrome,
  tabReply,
  conversationPageUrl,
  tabId,
  previousSnapshot,
  readTimeoutMs = 8_000,
  readyTimeoutMs = 8_000,
  pollMs = 250
}) {
  if (!chrome?.debugger?.attach || !chrome?.debugger?.sendCommand || !chrome?.debugger?.detach || !Number.isInteger(tabId)) {
    throw new Error('DeepSeek has an existing chat open, but NeuraFlok could not use its New chat shortcut. No message was sent.');
  }

  let attachedHere = false;
  let modifier = null;
  const sendKey = (type, key) => chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type, ...key });
  try {
    const targets = typeof chrome.debugger.getTargets === 'function'
      ? await chrome.debugger.getTargets().catch(() => null)
      : null;
    const alreadyAttached = targets?.some(target => target.tabId === tabId && target.attached === true) === true;
    if (!alreadyAttached) {
      await chrome.debugger.attach({ tabId }, '1.3');
      attachedHere = true;
    }
    let platform = null;
    try { platform = await chrome.runtime?.getPlatformInfo?.(); } catch {}
    const mac = platform?.os === 'mac';
    modifier = mac
      ? { key: 'Meta', code: 'MetaLeft', modifiers: 4, windowsVirtualKeyCode: 91, nativeVirtualKeyCode: 91 }
      : { key: 'Control', code: 'ControlLeft', modifiers: 2, windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 };
    await sendKey('keyDown', modifier);
    await sendKey('keyDown', {
      key: 'j', code: 'KeyJ', modifiers: modifier.modifiers,
      windowsVirtualKeyCode: 74, nativeVirtualKeyCode: 74
    });
    await sendKey('keyUp', {
      key: 'j', code: 'KeyJ', modifiers: modifier.modifiers,
      windowsVirtualKeyCode: 74, nativeVirtualKeyCode: 74
    });
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : '';
    throw new Error(`NeuraFlok could not open a new DeepSeek chat.${detail} No message was sent.`);
  } finally {
    if (attachedHere) {
      if (modifier) await sendKey('keyUp', { ...modifier, modifiers: 0 }).catch(() => undefined);
      await chrome.debugger.detach({ tabId }).catch(() => undefined);
    } else if (modifier) {
      await sendKey('keyUp', { ...modifier, modifiers: 0 }).catch(() => undefined);
    }
  }

  const normalizePageUrl = value => {
    try {
      const url = new URL(String(value || ''));
      return `${url.origin}${url.pathname}${url.hash}`;
    } catch {
      return '';
    }
  };
  const previousPageUrl = normalizePageUrl(previousSnapshot?.url);
  const previousConversationUrl = conversationPageUrl(previousSnapshot?.url);
  const canConfirmStableBlank = previousSnapshot?.hasConversation !== true && !previousConversationUrl;
  let consecutiveBlankSnapshots = 0;
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    const snapshot = await tabReply(tabId, { type: 'neuraflok-deepseek-snapshot' }, undefined,
      Math.min(readTimeoutMs, 2_000)).catch(() => null);
    const currentTab = await chrome.tabs.get(tabId).catch(() => null);
    const currentPageUrl = normalizePageUrl(currentTab?.url || currentTab?.pendingUrl);
    const currentConversationUrl = conversationPageUrl(currentTab?.url || currentTab?.pendingUrl);
    const routeChanged = Boolean(previousPageUrl && currentPageUrl && previousPageUrl !== currentPageUrl);
    const conversationChanged = Boolean(previousConversationUrl && previousConversationUrl !== currentConversationUrl);
    if (snapshot?.signedIn === true && snapshot.hasConversation !== true) {
      consecutiveBlankSnapshots++;
      // A just-cleared DOM is not proof of a new chat: DeepSeek can restore the
      // previous conversation after the first snapshot. Require a changed route
      // for known conversations, or a short stable blank state for an already
      // blank provider page.
      if ((routeChanged || conversationChanged) && consecutiveBlankSnapshots >= 2) return snapshot;
      if (canConfirmStableBlank && consecutiveBlankSnapshots >= 3) return snapshot;
    } else {
      consecutiveBlankSnapshots = 0;
    }
  }
  throw new Error('NeuraFlok could not detect the new DeepSeek chat after using its New chat shortcut. No message was sent.');
}
