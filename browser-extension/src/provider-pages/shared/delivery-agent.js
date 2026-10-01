(() => {
  if (globalThis.__neuraflokDeliveryAgent) return;
  globalThis.__neuraflokDeliveryAgent = true;

  const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function install(options) {
    if (!options || !options.guard || globalThis[options.guard]) return false;
    const { api, provider, prefix, namespace } = options;
    if (!api || typeof provider !== 'string' || !prefix || !namespace) return false;
    globalThis[options.guard] = true;

    const keys = options.keys(provider);
    const legacyKeys = options.legacyKeys?.(provider) || {};
    let active = null;
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

    function valueFrom(read, fallback = '') {
      try {
        const value = read();
        return value == null ? fallback : value;
      } catch {
        return fallback;
      }
    }

    function stored(key) {
      try {
        const current = sessionStorage.getItem(key);
        if (current !== null) return current;
        const legacy = legacyKeys[key];
        if (!legacy) return null;
        const previous = sessionStorage.getItem(legacy);
        if (previous === null) return null;
        sessionStorage.setItem(key, previous);
        try { sessionStorage.removeItem(legacy); } catch {}
        return previous;
      } catch {
        return null;
      }
    }

    function save(key, value) {
      try {
        sessionStorage.setItem(key, value);
        return true;
      } catch {
        return false;
      }
    }

    function normalized(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function lastAnswer() {
      return String(valueFrom(() => api.lastAnswer()) || '');
    }

    function lastThink() {
      return String(valueFrom(() => api.lastThink()) || '');
    }

    function snapshot() {
      return { before: lastAnswer(), beforeThink: lastThink() };
    }

    function responseText(sent, before, beforeThink) {
      const answer = lastAnswer();
      if (answer && normalized(answer) !== normalized(before) && normalized(answer) !== normalized(sent)) return answer;
      if (options.includeThink) {
        const think = lastThink();
        if (think && normalized(think) !== normalized(beforeThink) && normalized(think) !== normalized(sent) && think !== before) return think;
      }
      return '';
    }

    function generating() {
      return valueFrom(() => api.generating(), false) === true;
    }

    function signedIn() {
      return valueFrom(() => api.signedIn(), false) === true;
    }

    function hasConversation() {
      return valueFrom(() => api.hasConversation(), false) === true;
    }

    async function until(test, timeoutMs, stepMs = 200) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const result = test();
          if (result) return result;
        } catch {}
        await wait(stepMs);
      }
      return null;
    }

    function pageStatus() {
      return {
        ...(options.includeProvider ? { provider } : {}),
        signedIn: signedIn(),
        generating: generating(),
        conversationId: stored(keys.session)
      };
    }

    function read(message = {}) {
      const sent = typeof message.sent === 'string' ? message.sent : active?.sent || '';
      const before = typeof message.before === 'string' ? message.before : active?.before || '';
      const beforeThink = typeof message.beforeThink === 'string' ? message.beforeThink : active?.beforeThink || '';
      return { ...pageStatus(), text: responseText(sent, before, beforeThink) };
    }

    function sessionError(conversationId) {
      return `${provider.toUpperCase()} page is not bound to session ${conversationId}. Start a new NEURAFLOK chat to reconnect safely.`;
    }

    async function beginFreshConversation(message, bound) {
      if (options.rejectBoundFresh && bound && bound !== message.conversationId) {
        return 'This provider page already belongs to another NEURAFLOK session.';
      }
      const hadConversation = hasConversation();
      const needsNewPage = options.openNewPageOnFresh || hadConversation || Boolean(bound && bound !== message.conversationId);
      const control = valueFrom(() => api.newChat(), null);
      if (needsNewPage && !control && hadConversation) {
        return `Could not find the ${provider.toUpperCase()} new-chat control. Open a blank chat, then retry.`;
      }
      if (needsNewPage && !control && bound && bound !== message.conversationId) {
        return `Could not find the ${provider.toUpperCase()} new-chat control. Open a blank chat, then retry.`;
      }
      if (control && (options.openNewPageOnFresh || needsNewPage)) {
        try {
          control.click();
        } catch {
          return `Could not open a new ${provider.toUpperCase()} conversation. The current page was left unchanged.`;
        }
        if (hadConversation && !await until(() => !hasConversation(), 8000)) {
          return `Could not open a new ${provider.toUpperCase()} conversation. The current page was left unchanged.`;
        }
      }
      if (!save(keys.session, message.conversationId)) return 'Could not bind the provider page to this session. No message was sent.';
      return null;
    }

    async function complete(message) {
      if (options.includeProvider && message.provider !== provider) {
        return { error: 'The selected provider does not match this page.' };
      }
      if (message.stop === true) {
        if (stored(keys.session) !== message.conversationId) return { error: 'This page is not bound to the requested session.' };
        valueFrom(() => api.stopButton()?.click(), undefined);
        return { ok: true };
      }
      const conversationPattern = new RegExp(`^${prefix}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, 'i');
      if (typeof message.conversationId !== 'string' || !conversationPattern.test(message.conversationId)) {
        return { error: 'The provider session id is invalid. Start a new chat from NEURAFLOK.' };
      }
      if (typeof message.id !== 'string' || !REQUEST_ID.test(message.id)) {
        return { error: 'The provider send request id is invalid. Retry from NEURAFLOK.' };
      }

      const bound = stored(keys.session);
      if (message.fresh === true) {
        const error = await beginFreshConversation(message, bound);
        if (error) return { error };
      } else if (bound !== message.conversationId) {
        if (!options.bindUnclaimed && bound !== null) return { error: sessionError(message.conversationId) };
        if (!options.bindUnclaimed) return { error: sessionError(message.conversationId) };
        if (!save(keys.session, message.conversationId)) return { error: 'Could not bind the provider page to this session. No message was sent.' };
      }

      if (stored(keys.claim) === message.id) return { pending: true, ...snapshot(), generating: generating() };
      const composer = await until(() => api.composer(), options.composerMs);
      if (!composer || options.verifySignIn && !signedIn()) return { error: options.signInMessage };
      if (generating() && !await until(() => !generating(), options.idleMs)) {
        return { error: `${provider.toUpperCase()} is still generating. Wait for it to finish and retry.` };
      }

      const sent = typeof message.text === 'string' ? message.text : '';
      const previous = snapshot();
      const before = typeof message.before === 'string' ? message.before : previous.before;
      const beforeThink = typeof message.beforeThink === 'string' ? message.beforeThink : previous.beforeThink;
      active = { sent, before, beforeThink };
      api.setValue(composer, sent);
      const accepted = await until(() => {
        const current = api.composer();
        const text = String(current?.value || current?.innerText || current?.textContent || '').trim();
        return current && text === sent.trim() ? current : null;
      }, options.insertMs);
      if (!accepted) return { error: `${provider.toUpperCase()} did not accept the message in its composer.` };
      const send = await until(() => api.sendButton(), options.sendMs);
      if (!send) return { error: `${provider.toUpperCase()} send control was not found. Reload the provider page and retry.` };
      if (!save(keys.claim, message.id)) return { error: 'Could not record the send claim. No message was sent.' };
      try {
        send.focus?.();
        send.click();
      } catch {
        return { error: `${provider.toUpperCase()} send could not be dispatched. Check this conversation before retrying.` };
      }
      const freshAnswer = () => responseText(sent, before, beforeThink);
      await until(() => generating() || freshAnswer(), options.startMs);
      const finished = await until(() => !generating() && freshAnswer(), options.finishMs);
      await wait(400);
      const text = freshAnswer();
      if (finished && text) return { text, before, beforeThink };
      return { pending: true, text, before, beforeThink, generating: generating() };
    }

    function showMark() {
      if (!options.mark) return;
      const previous = (options.legacyMarkIds || []).map(id => document.getElementById(id)).find(Boolean);
      if (previous) {
        previous.id = options.mark.id;
        previous.textContent = options.mark.text(provider);
        return;
      }
      if (document.getElementById(options.mark.id)) return;
      const badge = document.createElement('div');
      badge.id = options.mark.id;
      badge.textContent = options.mark.text(provider);
      (document.documentElement || document.body)?.appendChild(badge);
    }

    function notifyWorker() {
      try {
        chrome.runtime.sendMessage({
          type: `${namespace}-present`,
          ...(options.includeProvider ? { provider } : {}),
          signedIn: signedIn()
        }, () => void chrome.runtime.lastError);
      } catch {}
    }

    function respond(sendResponse, action) {
      Promise.resolve().then(action).then(sendResponse, error => {
        sendResponse({ error: String(error?.message || error).slice(0, 500) });
      });
    }

    showMark();
    notifyWorker();
    if (globalThis.chrome?.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!message) return;
        if (message.type === `${namespace}-status`) {
          sendResponse(pageStatus());
          return;
        }
        if (message.type === `${namespace}-snapshot`) {
          sendResponse({ ...pageStatus(), ...snapshot() });
          return;
        }
        if (message.type === `${namespace}-read`) {
          sendResponse(read(message));
          return;
        }
        if (message.type !== `${namespace}-complete`) return;
        respond(sendResponse, () => complete(message));
        return true;
      });
    }
    return true;
  }

  globalThis.NEURAFLOK_PAGE_AGENT = Object.freeze({ install });
})();
