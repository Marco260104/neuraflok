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

    function composerText(node) {
      if (!node) return '';
      if (typeof node.value === 'string') return node.value;
      if (typeof node.innerText === 'string') return node.innerText;
      return typeof node.textContent === 'string' ? node.textContent : '';
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
      if (isAck(answer) && normalized(before) && !identityProvesNewAnswer(beforeIdentity, currentIdentity)) return '';
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

    function pageIdentity() {
      return String(valueFrom(() => api.pageIdentity?.(), '') || '');
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
      const status = pageStatus();
      return {
        ...status,
        text: answer || think, answer, think, answerIdentity,
        ...(active?.attachmentsUploaded === true ? { attachmentsUploaded: true } : {})
      };
    }

    function sessionError(conversationId) {
      return `${provider.toUpperCase()} page is not bound to session ${conversationId}. Start a new NEURAFLOK chat to reconnect safely.`;
    }

    async function beginFreshConversation(message, bound) {
      // The background worker may reuse a tab only after it verified and
      // persisted the old chat's exact URL. In that case the old conversation
      // remains recoverable by navigating back to that URL later.
      if (options.rejectBoundFresh && bound && bound !== message.conversationId && message.rebindSavedConversation !== true) {
        return 'This provider page already belongs to another NEURAFLOK session.';
      }
      const hadConversation = hasConversation();
      const previousPageIdentity = pageIdentity();
      // A blank provider page already is fresh. If the background shortcut
      // could not verify a clean route, use only the provider adapter's exact
      // New chat control and wait for navigation before sending setup text.
      const needsNewPage = hadConversation && message.freshPagePrepared !== true;
      const control = needsNewPage ? valueFrom(() => api.newChat(), null) : null;
      if (needsNewPage && !control && hadConversation) {
        return `Could not find the ${provider.toUpperCase()} new-chat control. Open a blank chat, then retry.`;
      }
      if (needsNewPage && !control && bound && bound !== message.conversationId) {
        return `Could not find the ${provider.toUpperCase()} new-chat control. Open a blank chat, then retry.`;
      }
      if (needsNewPage && control) {
        try {
          control.click();
        } catch {
          return `Could not open a new ${provider.toUpperCase()} conversation. The current page was left unchanged.`;
        }
        const openedNewPage = () => {
          const current = pageIdentity();
          return Boolean(previousPageIdentity && current && current !== previousPageIdentity);
        };
        if (hadConversation && !await until(() => !hasConversation() || openedNewPage(), 8000)) {
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

      let bound = stored(keys.session);
      let freshPagePrepared = message.freshPagePrepared === true;
      if (message.fresh === true) {
        const error = await beginFreshConversation(message, bound);
        if (error) return { error };
        freshPagePrepared = true;
        // Attachment receipts belong to a provider page, not the durable
        // NEURAFLOK conversation id. A freshly opened DeepSeek chat cannot
        // reuse the previous page's receipt or it may skip the actual upload.
        try { api.clearAttachmentReceipt?.(message.conversationId); } catch {}
        if (keys.preparedAttachmentPage) {
          try { sessionStorage.removeItem(keys.preparedAttachmentPage); } catch {}
        }
      } else if (bound !== message.conversationId) {
        if (!options.bindUnclaimed && bound !== null) return { error: sessionError(message.conversationId) };
        if (!options.bindUnclaimed) return { error: sessionError(message.conversationId) };
        if (!save(keys.session, message.conversationId)) return { error: 'Could not bind the provider page to this session. No message was sent.' };
        bound = message.conversationId;
      }

      const preparedAttachmentPage = message.preparedAttachmentPage === true &&
        options.allowPreparedAttachmentPage === true &&
        stored(keys.preparedAttachmentPage) === message.conversationId &&
        bound === message.conversationId;
      if (message.preparedAttachmentPage === true && !preparedAttachmentPage) {
        try { api.clearAttachmentReceipt?.(message.conversationId); } catch {}
        if (keys.preparedAttachmentPage) {
          try { sessionStorage.removeItem(keys.preparedAttachmentPage); } catch {}
        }
        return { error: 'DEEPSEEK_ATTACHMENT_STAGE_UNAVAILABLE: The uploaded attachment is no longer staged in this DeepSeek chat. No message was sent.' };
      }

      if (stored(keys.claim) === message.id) return { pending: true, ...snapshot(), generating: generating() };
      const composer = await until(() => api.composer(), options.composerMs);
      if (!composer) {
        return { error: signedIn()
          ? `${provider.toUpperCase()} is connected, but its chat composer could not be found. No message was sent.`
          : options.signInMessage };
      }
      if (options.verifySignIn && !signedIn()) return { error: options.signInMessage };
      if (message.removeOnly !== true && generating() && !await until(() => !generating(), options.idleMs)) {
        return { error: `${provider.toUpperCase()} is still generating. Wait for it to finish and retry.` };
      }

      const attachments = Array.isArray(message.attachments) ? message.attachments : [];
      if (message.removeOnly === true) {
        if (!attachments.length || typeof api.removeAttachmentFiles !== 'function' ||
            typeof api.providerAttachmentsPresent !== 'function' || typeof api.attachmentsRemoved !== 'function') {
          return { error: `${provider.toUpperCase()} could not prepare the attachment removal.` };
        }
        if (!api.removeAttachmentFiles(attachments, message.conversationId)) {
          return { error: `${provider.toUpperCase()} could not find the selected file card or its remove control.` };
        }
        const removed = await until(() => api.attachmentsRemoved(attachments, message.conversationId) === true,
          options.attachmentMs ?? 120_000, 200);
        return removed ? { removed: true } : { error: `${provider.toUpperCase()} did not confirm that the selected files were removed.` };
      }
      if (message.uploadOnly === true && api.attachmentsConfirmed?.(attachments, message.conversationId) === true) {
        if (freshPagePrepared && options.allowPreparedAttachmentPage === true && keys.preparedAttachmentPage &&
            !save(keys.preparedAttachmentPage, message.conversationId)) {
          return { error: 'DeepSeek uploaded the file, but NeuraFlok could not keep the prepared chat binding.' };
        }
        return { uploaded: true, ...(freshPagePrepared ? { freshPagePrepared: true } : {}) };
      }
      const attachmentDeadline = attachments.length
        ? Date.now() + (options.attachmentMs ?? 120_000)
        : null;
      if (attachments.length) {
        if (message.preStagedAttachments !== true &&
            (typeof api.attachFiles !== 'function' || !api.attachFiles(attachments, message.conversationId))) {
          return { error: `${provider.toUpperCase()} could not attach the selected files.` };
        }
        const attached = await until(() => api.attachmentsPresent?.(attachments, message.conversationId) === true,
          Math.max(0, attachmentDeadline - Date.now()), 250);
        if (!attached) return { error: `${provider.toUpperCase()} did not confirm the selected files.` };
      }

      // Pre-upload a composer attachment without sending chat text. A native
      // file input proves selection only; wait for the provider's settled
      // attachment chip before returning an upload receipt.
      if (message.uploadOnly === true) {
        if (!attachments.length) return { error: `${provider.toUpperCase()} received an empty file upload request.` };
        const uploadReady = await until(() => {
          // Uploading a file is independent of the user's draft text. The
          // composer remains editable while the provider processes the file;
          // waiting for it to be empty leaves the attachment spinner stuck as
          // soon as the user starts typing during the upload.
          if (!api.composer()) return null;
          const confirmed = typeof api.attachmentUploadReady === 'function'
            ? api.attachmentUploadReady(attachments, message.conversationId) === true
            : api.attachmentsPresent?.(attachments, message.conversationId) === true && Boolean(api.sendButton());
          return confirmed ? true : null;
        }, Math.max(0, attachmentDeadline - Date.now()), 250);
        if (!uploadReady) return { error: `${provider.toUpperCase()} did not confirm that the selected files finished uploading.` };
        if (freshPagePrepared && options.allowPreparedAttachmentPage === true && keys.preparedAttachmentPage) {
          if (!save(keys.preparedAttachmentPage, message.conversationId)) {
            return { error: 'DeepSeek uploaded the file, but NeuraFlok could not keep the prepared chat binding.' };
          }
        }
        try { api.confirmAttachmentsUploaded?.(attachments, message.conversationId); } catch {}
        return { uploaded: true, ...(freshPagePrepared ? { freshPagePrepared: true } : {}) };
      }

      const sent = typeof message.text === 'string' ? message.text : '';
      const previous = snapshot();
      // A fresh request may navigate away from the page used for the original
      // snapshot. Its reply baseline must come from the newly opened chat, or
      // stale text from the prior conversation can mask the real answer.
      const before = message.fresh === true
        ? previous.before
        : typeof message.before === 'string' ? message.before : previous.before;
      const beforeThink = message.fresh === true
        ? previous.beforeThink
        : typeof message.beforeThink === 'string' ? message.beforeThink : previous.beforeThink;
      const beforeIdentity = message.fresh === true
        ? previous.beforeIdentity
        : typeof message.beforeIdentity === 'string' ? message.beforeIdentity : previous.beforeIdentity;
      active = { sent, before, beforeThink, beforeIdentity, attachmentsUploaded: false };
      api.setValue(composer, sent);
      let lastInsertionTarget = composer;
      let lastInsertionAt = Date.now();
      const accepted = await until(() => {
        const current = api.composer();
        const text = composerText(current);
        // Contenteditable providers can render the same pasted message with
        // different paragraph boundaries (for example, collapsing two blank
        // lines into one). Compare visible text after whitespace normalization
        // so valid multiline prompts are not rejected before Send is clicked.
        if (current && normalized(text) === normalized(sent)) return current;

        // Provider SPAs can replace a controlled textarea immediately after
        // the input event. Keep targeting the live composer until its DOM
        // value reflects the message instead of waiting on a detached node.
        if (current && (current !== lastInsertionTarget || Date.now() - lastInsertionAt >= 400)) {
          lastInsertionTarget = current;
          lastInsertionAt = Date.now();
          try { api.setValue(current, sent); } catch {}
        }
        return null;
      }, options.insertMs);
      if (!accepted) return { error: `${provider.toUpperCase()} did not accept the message in its composer.` };
      const sendWait = attachmentDeadline === null ? options.sendMs : Math.max(0, attachmentDeadline - Date.now());
      const send = await until(() => api.sendButton(), sendWait);
      if (!send) return { error: attachments.length
        ? `${provider.toUpperCase()} did not confirm that the selected files finished uploading.`
        : `${provider.toUpperCase()} send control was not found. Reload the provider page and retry.` };
      if (attachments.length) {
        active.attachmentsUploaded = true;
        if (typeof options.reportAttachmentsUploaded === 'function') {
          try { await options.reportAttachmentsUploaded({ id: message.id, conversationId: message.conversationId }); } catch {}
        }
      }
      if (!save(keys.claim, message.id)) return { error: 'Could not record the send claim. No message was sent.' };
      try {
        send.focus?.();
        send.click();
      } catch {
        return { error: `${provider.toUpperCase()} send could not be dispatched. Check this conversation before retrying.` };
      }
      if (preparedAttachmentPage && keys.preparedAttachmentPage) {
        try { sessionStorage.removeItem(keys.preparedAttachmentPage); } catch {}
      }
      const publicNow = () => publicAnswer(sent, before, beforeIdentity, lastAnswerIdentity());
      const ackRepeat = (text) => isAck(text) && isAck(before) && !identityProvesNewAnswer(beforeIdentity, lastAnswerIdentity());
      const staleAck = (text) => isAck(text) && Boolean(normalized(before)) && !identityProvesNewAnswer(beforeIdentity, lastAnswerIdentity());
      const continueAvailable = () => typeof api.continueButton === 'function' && Boolean(valueFrom(() => api.continueButton(), null));
      await until(() => generating() || publicNow() || thinkText(sent, before, beforeThink) || continueAvailable(), options.startMs);
      const finished = await until(() => {
        if (generating()) return null;
        const text = publicNow();
        if (continueAvailable()) return 'continue';
        if (text && !ackRepeat(text) && !staleAck(text)) return 'finished';
        return null;
      }, options.finishMs);
      await wait(400);
      const text = publicNow();
      const answerIdentity = lastAnswerIdentity();
      if (finished === 'finished' && text && !ackRepeat(text) && !staleAck(text)) {
        return { text, before, beforeThink, beforeIdentity, answerIdentity, ...(freshPagePrepared ? { freshPagePrepared: true } : {}) };
      }
      return {
        pending: true,
        text: text || thinkText(sent, before, beforeThink),
        before, beforeThink, beforeIdentity, answerIdentity,
        ...(freshPagePrepared ? { freshPagePrepared: true } : {}),
        generating: generating(),
        ...(continueAvailable() ? { continueAvailable: true } : {})
      };
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

    let lastPresence = null;
    let presenceTimer = null;

    function notifyWorker(force = false) {
      const present = signedIn();
      if (!force && lastPresence === present) return;
      lastPresence = present;
      try {
        chrome.runtime.sendMessage({
          type: `${namespace}-present`,
          ...(options.includeProvider ? { provider } : {}),
          signedIn: present
        }, () => void chrome.runtime.lastError);
      } catch {}
    }

    function watchPresence() {
      const schedule = () => {
        if (presenceTimer) clearTimeout(presenceTimer);
        presenceTimer = setTimeout(() => {
          presenceTimer = null;
          notifyWorker();
        }, 150);
      };
      if (typeof MutationObserver === 'function' && document.documentElement) {
        const observer = new MutationObserver(schedule);
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['aria-hidden', 'aria-label', 'class', 'contenteditable', 'disabled', 'hidden', 'name', 'placeholder', 'style'],
          childList: true,
          subtree: true
        });
      }
      document.addEventListener?.('DOMContentLoaded', () => notifyWorker(true), { once: true });
      globalThis.addEventListener?.('load', () => notifyWorker(true), { once: true });
    }

    function respond(sendResponse, action) {
      Promise.resolve().then(action).then(sendResponse, error => {
        sendResponse({ error: String(error?.message || error).slice(0, 500) });
      });
    }

    showMark();
    watchPresence();
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
        if (message.type === `${namespace}-attachment-state`) {
          const attachments = Array.isArray(message.attachments) ? message.attachments.slice(0, 50) : [];
          const presentIds = attachments.filter(file => typeof file?.id === 'string' && (
            api.attachmentsConfirmed?.([file], message.conversationId) === true ||
            api.attachmentsPresent?.([file], message.conversationId) === true
          )).map(file => file.id);
          const present = new Set(presentIds);
          const missingImages = attachments.filter(file => typeof file?.id === 'string' &&
            !present.has(file.id) && String(file?.mimeType || '').startsWith('image/'));
          try { api.prepareImageAttachmentUpload?.(missingImages, message.conversationId); } catch {}
          sendResponse({ presentIds });
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
