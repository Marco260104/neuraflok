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

    function lastAnswerIdentity() {
      return String(valueFrom(() => api.lastAnswerIdentity?.()) || '');
    }

    function snapshot() {
      return { before: lastAnswer(), beforeThink: lastThink(), beforeIdentity: lastAnswerIdentity() };
    }

    function isAck(text) {
      return /^(NEURAFLOK_READY|NEURAL_JAM_READY)$/.test(String(text || '').trim());
    }

    function identityProvesNewAnswer(beforeIdentity, answerIdentity) {
      if (!beforeIdentity || !answerIdentity || beforeIdentity === answerIdentity) return false;
      const beforePage = /^node:([^:]+):/.exec(beforeIdentity)?.[1] || '';
      const answerPage = /^node:([^:]+):/.exec(answerIdentity)?.[1] || '';
      if (beforePage || answerPage) return Boolean(beforePage && answerPage && beforePage === answerPage);
      return true;
    }

    function hasToolCall(text) {
      return /```(?:neuraflok-tool|json)\b/i.test(text) || /<(?:exec_command|read|apply_patch)\b/i.test(text) || /<[|｜]{2}DSML[|｜]{2}\s*invoke\s+name=/i.test(text);
    }

    function looksLikeThink(text) {
      return /^(Let me|Let's|We need|I will|I'll |The user |Need to |Must not |Pensado|Pensó|Detenido|Voy a |Vamos a |Déjame |Dejame |Necesito |Debo |Hay que )\b/i.test(normalized(text));
    }

    function publicAnswer(sent, before, beforeIdentity, currentIdentity) {
      const answer = lastAnswer();
      if (!answer) return '';
      const think = lastThink();
      const answerNorm = normalized(answer);
      const thinkNorm = normalized(think);
      // After bootstrap, the chat title and first ACK bubble stay NEURAFLOK_READY.
      // That is not a new answer, and posting it ends the turn before tools finish.
      if (isAck(answer) && normalized(before)) return '';
      if (looksLikeThink(answer) && !hasToolCall(answer)) return '';
      if (thinkNorm && (answerNorm === thinkNorm || (answerNorm.includes(thinkNorm) && answerNorm.length <= thinkNorm.length + 40))) return '';
      const sameAsPrevious = normalized(answer) === normalized(before);
      const newAssistantMessage = identityProvesNewAnswer(beforeIdentity, currentIdentity);
      if (sameAsPrevious && !newAssistantMessage) return '';
      if (normalized(answer) === normalized(sent) && !newAssistantMessage) return '';
      return answer;
    }

    function thinkText(sent, before, beforeThink) {
      if (!options.includeThink) return '';
      const think = lastThink();
      if (think && normalized(think) !== normalized(beforeThink) && normalized(think) !== normalized(sent) && think !== before) return think;
      return '';
    }

    function responseText(sent, before, beforeThink, beforeIdentity, currentIdentity) {
      return publicAnswer(sent, before, beforeIdentity, currentIdentity) || thinkText(sent, before, beforeThink);
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
        hasConversation: hasConversation(),
        ...(typeof api.continueButton === 'function' && valueFrom(() => api.continueButton(), null) ? { continueAvailable: true } : {}),
        conversationId: stored(keys.session)
      };
    }

    function read(message = {}) {
      const sent = typeof message.sent === 'string' ? message.sent : active?.sent || '';
      const before = typeof message.before === 'string' ? message.before : active?.before || '';
      const beforeThink = typeof message.beforeThink === 'string' ? message.beforeThink : active?.beforeThink || '';
      const beforeIdentity = typeof message.beforeIdentity === 'string' ? message.beforeIdentity : active?.beforeIdentity || '';
      const answerIdentity = lastAnswerIdentity();
      const answer = publicAnswer(sent, before, beforeIdentity, answerIdentity);
      const think = thinkText(sent, before, beforeThink);
      return { ...pageStatus(), text: answer || think, answer, think, answerIdentity };
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
      const beforeIdentity = typeof message.beforeIdentity === 'string' ? message.beforeIdentity : previous.beforeIdentity;
      active = { sent, before, beforeThink, beforeIdentity };
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
      const publicNow = () => publicAnswer(sent, before, beforeIdentity, lastAnswerIdentity());
      const ackRepeat = (text) => isAck(text) && isAck(before);
      const staleAck = (text) => isAck(text) && Boolean(normalized(before));
      await until(() => generating() || publicNow() || thinkText(sent, before, beforeThink), options.startMs);
      const finished = await until(() => !generating() && publicNow() && !ackRepeat(publicNow()) && !staleAck(publicNow()), options.finishMs);
      await wait(400);
      const text = publicNow();
      const answerIdentity = lastAnswerIdentity();
      if (finished && text && !ackRepeat(text) && !staleAck(text)) return { text, before, beforeThink, beforeIdentity, answerIdentity };
      return { pending: true, text: text || thinkText(sent, before, beforeThink), before, beforeThink, beforeIdentity, answerIdentity, generating: generating() };
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
        if (message.type === `${namespace}-continue`) {
          if (stored(keys.session) !== message.conversationId || stored(keys.claim) !== message.id) {
            sendResponse({ continued: false });
            return;
          }
          const button = valueFrom(() => api.continueButton?.(), null);
          if (!button) {
            sendResponse({ continued: false });
            return;
          }
          try {
            button.click();
            sendResponse({ continued: true });
          } catch {
            sendResponse({ continued: false });
          }
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
