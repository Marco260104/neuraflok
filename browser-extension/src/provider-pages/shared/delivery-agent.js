(() => {
  if (globalThis.__neuraflokDeliveryAgent) return;
  globalThis.__neuraflokDeliveryAgent = true;

  const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const isRealBrowser = typeof navigator !== 'undefined' && typeof document !== 'undefined' && typeof document.nodeType === 'number';
  // In a real browser DeepSeek can restore the previous thread several seconds
  // after New chat looks ready. Keep the fresh route stable long enough that a
  // late hydration cannot replace the composer while the send is in flight.
  const FRESH_CHAT_ROUTE_STABLE_MS = isRealBrowser ? 2_500 : 6_500;
  const FRESH_CHAT_ROUTE_TIMEOUT_MS = 12_000;
  // A stale companion background can reach this page without confirming a
  // stable fresh route. Keep the page blank long enough for a delayed thread
  // restoration before typing, and reopen New chat if the old thread returns.
  const FRESH_HOLD_MS = 30_000;
  const FRESH_HOLD_REOPEN_MS = 8_000;
  const FRESH_HOLD_POLL_MS = 250;
  const FRESH_HOLD_SAFE_MS = 20_000;
  const FRESH_HOLD_ERROR = 'DeepSeek brought back the previous conversation before sending. No message was sent; retry.';

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

    function cleanThinkHeader(text) {
      if (!text) return '';
      return String(text).replace(/^(?:(?:razonando|pensando|thinking|detenido|stopped|pensado|pens\u00f3|\u5df2\u601d\u8003|\u601d\u8003\u4e2d|thought for)\b[^\n]*\n*)+/i, '').trim();
    }

    function looksLikeThink(text) {
      return /^(Let me|Let's|We need|I will|I'll |The user |Need to |Must not |Pensado|Pensó|Detenido|Voy a |Vamos a |Déjame |Dejame |Necesito |Debo |Hay que )\b/i.test(normalized(text));
    }

    function looksLikeThinkChrome(text) {
      const norm = normalized(text);
      if (norm.length > 60) return false;
      return /^(detenido|pensado|pensó|pensando|stopped|thinking)\b/i.test(norm);
    }

    function thinkStopped() {
      return valueFrom(() => api.thinkStopped?.(), false) === true;
    }

    function continueControl() {
      return valueFrom(() => api.continueButton?.(), null);
    }

    function leftoverList() {
      return Array.isArray(active?.leftovers) ? active.leftovers : [];
    }

    function looksLikeProjectStatusRecap(text) {
      const value = normalized(text);
      if (value.length < 80) return false;
      return /ya qued[oó] implementado|esto es lo que cambi[oó]|c[oó]mo probarlo|how to (try|test|open) it|npm run (dev|build)|no quedan tareas pendientes|the project is complete/i.test(value)
        && /\b[\w./-]+\.(js|ts|tsx|css|html|json)\b/.test(value);
    }

    function publicAnswer(sent, before, beforeIdentity, currentIdentity) {
      const answer = cleanThinkHeader(lastAnswer());
      if (!answer) return '';
      const think = lastThink();
      const answerNorm = normalized(answer);
      const thinkNorm = normalized(think);
      // After bootstrap, the chat title and first ACK bubble stay NEURAFLOK_READY.
      // That is not a new answer, and posting it ends the turn before tools finish.
      if (isAck(answer) && normalized(before)) return '';
      if (thinkNorm && (answerNorm === thinkNorm || (answerNorm.includes(thinkNorm) && answerNorm.length <= thinkNorm.length + 40))) return '';
      const sameAsPrevious = normalized(answer) === normalized(before);
      const newAssistantMessage = identityProvesNewAnswer(beforeIdentity, currentIdentity);
      if (sameAsPrevious && !newAssistantMessage) return '';
      if (normalized(answer) === normalized(sent) && !newAssistantMessage) return '';
      if (looksLikeProjectStatusRecap(answer) && (
        (leftoverList().some((item) => looksLikeProjectStatusRecap(item) && item === answerNorm) && !newAssistantMessage)
        || (normalized(before) && answerNorm === normalized(before) && !newAssistantMessage)
      )) {
        return '';
      }
      if (looksLikeServerError(answer) && !hasToolCall(answer)) return '';
      // Hide planning-only prose while the page is still generating so a later tool fence can arrive.
      // After generation stops, keep that prose: it is the real reply and filtering it looks like a timeout.
      if (looksLikeThinkChrome(answer) && !hasToolCall(answer)) return '';
      if (looksLikeThink(answer) && !hasToolCall(answer) && generating()) return '';
      return answer;
    }

    function thinkText(sent, before, beforeThink) {
      if (!options.includeThink) return '';
      const think = lastThink();
      if (think && normalized(think) !== normalized(beforeThink) && normalized(think) !== normalized(sent) && think !== before) return think;
      return '';
    }

    const RESUME_PROMPT = 'Continue exactly from where you stopped. Do not restart. If a neuraflok-tool fence was cut off, emit one complete fence only.';

    function looksIncomplete(text) {
      const value = String(text || '');
      if (!value) return false;
      const fences = value.match(/```/g);
      if (fences && fences.length % 2 === 1) return true;
      if (/```(?:neuraflok-tool|json)\b/i.test(value) && !/```(?:neuraflok-tool|json)[\s\S]*```/.test(value)) return true;
      if (/<(?:exec_command|read|apply_patch)\b/i.test(value) && !/<\/(?:exec_command|read|apply_patch)>/i.test(value)) return true;
      return false;
    }

    function looksLikeServerError(text) {
      const value = normalized(text);
      if (!value || hasToolCall(value) || value.length > 400) return false;
      return /server (is )?busy|temporarily unavailable|servidor no (está |esta )?disponible|please try again later|the server is busy|too many requests|el servidor (está|esta) ocupado/i.test(value);
    }

    function pageError() {
      return valueFrom(() => api.pageError?.(), false) === true || looksLikeServerError(lastAnswer());
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

    async function freshFor(ms) {
      const deadline = Date.now() + ms;
      for (;;) {
        if (hasConversation() || normalized(lastAnswer())) return false;
        if (Date.now() >= deadline) return true;
        await wait(Math.min(FRESH_HOLD_POLL_MS, Math.max(1, deadline - Date.now())));
      }
    }

    async function reopenFreshConversation() {
      const control = valueFrom(() => api.newChat(), null);
      if (!control) return false;
      try {
        const activated = typeof api.activateNewChat === 'function'
          ? api.activateNewChat(control)
          : (control.click(), true);
        if (!activated) return false;
      } catch {
        return false;
      }
      return Boolean(await until(() => !hasConversation() && !normalized(lastAnswer()), FRESH_HOLD_REOPEN_MS));
    }

    async function holdFreshConversation() {
      if (!isRealBrowser || provider !== 'deepseek') return null;
      if (await freshFor(FRESH_HOLD_MS)) return null;
      if (!await reopenFreshConversation()) return FRESH_HOLD_ERROR;
      return await freshFor(FRESH_HOLD_MS) ? null : FRESH_HOLD_ERROR;
    }

    function pageStatus() {
      return {
        ...(options.includeProvider ? { provider } : {}),
        signedIn: signedIn(),
        generating: generating(),
        ...(typeof api.isFreshConversation === 'function'
          ? { freshConversation: valueFrom(() => api.isFreshConversation(), false) === true }
          : {}),
        ...(typeof api.hasConversation === 'function'
          ? { hasConversation: valueFrom(() => api.hasConversation(), false) === true }
          : {}),
        ...(typeof api.isNewChatRoute === 'function'
          ? { newChatRoute: valueFrom(() => api.isNewChatRoute(), false) === true }
          : {}),
        conversationId: stored(keys.session),
        canContinue: Boolean(continueControl()) || pageError() || thinkStopped()
      };
    }

    function read(message = {}) {
      valueFrom(() => api.scrollThread?.(), undefined);
      const sent = typeof message.sent === 'string' ? message.sent : active?.sent || '';
      const before = typeof message.before === 'string' ? message.before : active?.before || '';
      const beforeThink = typeof message.beforeThink === 'string' ? message.beforeThink : active?.beforeThink || '';
      const beforeIdentity = typeof message.beforeIdentity === 'string' ? message.beforeIdentity : active?.beforeIdentity || '';
      const answerIdentity = lastAnswerIdentity();
      const answer = publicAnswer(sent, before, beforeIdentity, answerIdentity);
      const think = thinkText(sent, before, beforeThink);
      const inspect = valueFrom(() => api.inspect?.(), null);
      const routeEvidence = active && Number.isFinite(active.freshRouteStableMs)
        ? {
            freshRouteStableMs: active.freshRouteStableMs,
            freshRouteWaitMs: Number.isFinite(active.freshRouteWaitMs) ? active.freshRouteWaitMs : 0,
            freshRouteRestored: active.freshRouteRestored === true
          }
        : null;
      const inspected = inspect && typeof inspect === 'object' && !Array.isArray(inspect) && routeEvidence
        ? { ...inspect, ...routeEvidence }
        : inspect;
      return { ...pageStatus(), text: answer, answer, think, answerIdentity, inspect: inspected };
    }

    function sessionError(conversationId) {
      return `${provider.toUpperCase()} page is not bound to session ${conversationId}. Start a new NEURAFLOK chat to reconnect safely.`;
    }

    async function beginFreshConversation(message, bound) {
      if (options.rejectBoundFresh && bound && bound !== message.conversationId) {
        return 'This provider page already belongs to another NEURAFLOK session.';
      }
      // The background already opened New chat and verified a stable fresh route.
      // Trust that confirmation instead of clicking New chat a second time, which
      // can navigate back to the restored thread and drop the message.
      if (message.openedNewChat === true) {
        if (!save(keys.session, message.conversationId)) return 'Could not bind the provider page to this session. No message was sent.';
        return null;
      }
      const hadConversation = hasConversation();
      const alreadyFresh = valueFrom(() => api.isNewChatRoute?.(), false) === true
        && valueFrom(() => api.isFreshConversation?.(), false) === true
        && !hadConversation
        && !normalized(lastAnswer());
      const needsNewPage = !alreadyFresh && (options.openNewPageOnFresh || hadConversation
        || Boolean(bound && bound !== message.conversationId));
      let control = valueFrom(() => api.newChat(), null);
      if (needsNewPage && !control) {
        control = await until(() => valueFrom(() => api.newChat(), null), 8_000);
      }
      if (needsNewPage && !control) {
        return `Could not find the ${provider.toUpperCase()} new-chat control. Open a blank chat, then retry.`;
      }
      if (control && needsNewPage) {
        try {
          const activated = typeof api.activateNewChat === 'function'
            ? api.activateNewChat(control)
            : (control.click(), true);
          if (!activated) throw new Error('New chat control could not be activated.');
        } catch {
          return `Could not open a new ${provider.toUpperCase()} conversation. The current page was left unchanged.`;
        }
        if (hadConversation && !await until(() => !hasConversation(), 8_000)) {
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

      const leftoverSeen = [];
      const rememberLeftover = (text) => {
        const n = normalized(text);
        if (n && !leftoverSeen.includes(n)) leftoverSeen.push(n);
      };
      rememberLeftover(lastAnswer());
      const bound = stored(keys.session);
      if (message.fresh === true) {
        rememberLeftover(lastAnswer());
        const started = await beginFreshConversation(message, bound);
        if (typeof started === 'string') return { error: started };
        if (started && started.openedNewChat) return { pending: true, openedNewChat: true };
        rememberLeftover(lastAnswer());
      } else if (bound !== message.conversationId) {
        if (!options.bindUnclaimed && bound !== null) return { error: sessionError(message.conversationId) };
        if (!options.bindUnclaimed) return { error: sessionError(message.conversationId) };
        if (!save(keys.session, message.conversationId)) return { error: 'Could not bind the provider page to this session. No message was sent.' };
      }

      if (stored(keys.claim) === message.id) return { pending: true, ...snapshot(), generating: generating() };
      // Trust the background only when it says it held the fresh route long
      // enough. Older companions send no timing, so the page guards the send.
      const backgroundFreshStable = Number.isFinite(message.freshRouteStableMs) ? message.freshRouteStableMs : 0;
      if (message.fresh === true && message.freshRouteRestored !== true
        && backgroundFreshStable < FRESH_HOLD_SAFE_MS) {
        const held = await holdFreshConversation();
        if (held) return { error: held };
      }
      const composer = await until(() => api.composer(), options.composerMs);
      if (!composer || options.verifySignIn && !signedIn()) return { error: options.signInMessage };
      const paintedNow = lastAnswer();
      const leftoverBusy = looksLikeProjectStatusRecap(paintedNow)
        || leftoverSeen.includes(normalized(paintedNow));
      // Leftover Stop on the previous thread must not block typing this send.
      // generating() Stop-wins is for the stream after Send, not for starting it.
      if (generating() && message.fresh !== true && !leftoverBusy
        && !await until(() => !generating(), options.idleMs)) {
        return { error: `${provider.toUpperCase()} is still generating. Wait for it to finish and retry.` };
      }

      const sent = typeof message.text === 'string' ? message.text : '';
      const previous = snapshot();
      const hadConversation = hasConversation();
      let before = typeof message.before === 'string' && message.before.trim()
        ? message.before
        : previous.before;
      const beforeThink = typeof message.beforeThink === 'string' && message.beforeThink
        ? message.beforeThink
        : previous.beforeThink;
      const beforeIdentity = typeof message.beforeIdentity === 'string' && message.beforeIdentity
        ? message.beforeIdentity
        : previous.beforeIdentity;
      rememberLeftover(before);
      rememberLeftover(previous.before);
      active = {
        sent, before, beforeThink, beforeIdentity, leftovers: leftoverSeen,
        freshRouteStableMs: message.fresh === true ? backgroundFreshStable : undefined,
        freshRouteWaitMs: message.fresh === true && Number.isFinite(message.freshRouteWaitMs) ? message.freshRouteWaitMs : 0,
        freshRouteRestored: message.fresh === true && message.freshRouteRestored === true
      };
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
      // Capture the paint before clicking so a synchronous re-render still counts
      // as evidence that the provider accepted the prompt.
      const paintedAtSend = lastAnswer();
      const thinkAtSend = lastThink();
      const sendAccepted = () => generating()
        || Boolean(valueFrom(() => api.sentVisible?.(sent), false))
        || lastAnswer() !== paintedAtSend
        || lastThink() !== thinkAtSend
        // A server-unavailable bubble or a Retry/Continue control only appears
        // after the provider processed this send.
        || pageError()
        || Boolean(continueControl());
      try {
        send.focus?.();
        const PointerEventCtor = valueFrom(() => globalThis.PointerEvent || window.PointerEvent, null);
        if (typeof PointerEventCtor === 'function') {
          try {
            send.dispatchEvent(new PointerEventCtor('pointerdown', { bubbles: true, cancelable: true, isPrimary: true, button: 0 }));
            send.dispatchEvent(new PointerEventCtor('pointerup', { bubbles: true, cancelable: true, isPrimary: true, button: 0 }));
          } catch {}
        }
        send.click();
      } catch {
        return { error: `${provider.toUpperCase()} send could not be dispatched. Check this conversation before retrying.` };
      }
      // DeepSeek can restore the previous thread right after the click and reset
      // the composer, silently dropping the send. NeuraFlok used to sit on
      // Thinking for minutes in that case. Confirm the send and retry once.
      let acceptedSend = Boolean(await until(sendAccepted, options.sendConfirmMs ?? 6_000));
      let restoredSend = false;
      // A fresh chat can still be replaced by the previous thread ~10 s after
      // Send even when the route looked stable. If the sent bubble disappears
      // while a conversation is painted, the send was dropped. Reopen New chat
      // and retry before handing the turn to the watcher.
      if (acceptedSend && isRealBrowser && message.fresh === true && provider === 'deepseek'
        && typeof api.sentVisible === 'function') {
        const pathAtSend = location.pathname;
        restoredSend = Boolean(await until(() => {
          if (!hasConversation() || valueFrom(() => api.sentVisible?.(sent), false)) return false;
          if (location.pathname === pathAtSend) return false;
          const info = valueFrom(() => api.inspect?.(), null);
          const messages = Number(info?.msgs);
          return !Number.isFinite(messages) || messages >= 3;
        }, options.restoreGuardMs ?? 15_000, 250));
        if (restoredSend) acceptedSend = false;
      }
      if (!acceptedSend) {
        if (restoredSend && !await reopenFreshConversation()) {
          return { error: FRESH_HOLD_ERROR };
        }
        const boxAgain = api.composer();
        if (boxAgain && generating() === false) {
          api.setValue(boxAgain, sent);
          const retyped = await until(() => {
            const current = api.composer();
            const text = String(current?.value || current?.innerText || current?.textContent || '').trim();
            return current && text === sent.trim() ? current : null;
          }, options.insertMs);
          if (retyped) {
            const again = await until(() => api.sendButton(), options.sendMs);
            if (again) {
              try {
                again.focus?.();
                again.click();
              } catch {}
              acceptedSend = Boolean(await until(sendAccepted, options.sendConfirmMs ?? 6_000));
            }
          }
        }
      }
      if (!acceptedSend) {
        return { error: `${provider.toUpperCase()} did not send this message. Open a new chat and try again.` };
      }
      valueFrom(() => api.scrollThread?.(), undefined);
      const publicNow = () => publicAnswer(sent, active.before, active.beforeIdentity, lastAnswerIdentity());
      const ackRepeat = (text) => isAck(text) && isAck(active.before);
      const staleAck = (text) => isAck(text) && Boolean(normalized(active.before));
      // After a reload the virtual list often paints the previous answer with an empty snapshot.
      // Capture that leftover as `before` even while generating so it cannot settle as this turn's reply.
      // A fresh session can look empty (no thread yet) and still paint the previous conversation
      // after send without generating; that paint is leftover, not the new reply.
      const absorbKnownLeftover = () => {
        const answer = lastAnswer();
        if (!answer || normalized(answer) === normalized(sent)) return false;
        const n = normalized(answer);
        if (!leftoverSeen.includes(n) && n !== normalized(before)) return false;
        before = answer;
        active.before = answer;
        active.leftovers = leftoverSeen;
        return true;
      };
      absorbKnownLeftover();
      if (!normalized(before)) {
        const painted = await until(() => {
          const answer = lastAnswer();
          return answer && normalized(answer) !== normalized(sent) ? answer : null;
        }, 800);
        // Only absorb a delayed leftover recap or a previously seen paint.
        // A fast public greeting on a fresh chat is the real reply, not leftover.
        if (painted && ((hadConversation && generating()) || leftoverSeen.includes(normalized(painted)) || (
          message.fresh === true
          && looksLikeProjectStatusRecap(painted)
          && !generating()
          && !looksIncomplete(painted)
          && !looksLikeServerError(painted)
        ))) {
          rememberLeftover(painted);
          before = painted;
          active.before = painted;
          active.leftovers = leftoverSeen;
        }
      }
      const conversationOnly = /This is a conversation only/i.test(sent);
      const leftoverRecap = () => {
        const painted = lastAnswer();
        if (!painted || !looksLikeProjectStatusRecap(painted)) return false;
        if (normalized(painted) === normalized(sent)) return false;
        if (!(conversationOnly || message.fresh === true)) return false;
        const n = normalized(painted);
        if (leftoverSeen.includes(n) || (normalized(before) && n === normalized(before))) return true;
        // Packed project prompts also look like recaps. The first recap paint on a
        // fresh tab is the previous DeepSeek thread, not this turn's reply.
        return message.fresh === true && !leftoverSeen.some((item) => looksLikeProjectStatusRecap(item) && item !== n);
      };
      const absorbLeftoverRecap = () => {
        if (!leftoverRecap()) return;
        const painted = lastAnswer();
        rememberLeftover(painted);
        before = painted;
        active.before = painted;
        active.leftovers = leftoverSeen;
      };
      await until(() => {
        absorbKnownLeftover();
        absorbLeftoverRecap();
        if (publicNow() || thinkText(sent, before, beforeThink) || pageError()) return true;
        if (leftoverRecap()) return false;
        return generating() || continueControl();
      }, options.startMs);
      absorbLeftoverRecap();

      async function clickContinue() {
        const button = continueControl();
        if (!button) return false;
        try {
          button.click();
          return true;
        } catch {
          return false;
        }
      }

      async function typeResume() {
        const box = api.composer();
        if (!box || generating()) return false;
        const grown = publicNow();
        if (grown) active.before = grown;
        api.setValue(box, RESUME_PROMPT);
        const accepted = await until(() => {
          const current = api.composer();
          const text = String(current?.value || current?.innerText || current?.textContent || '').trim();
          return current && text === RESUME_PROMPT.trim() ? current : null;
        }, options.insertMs);
        if (!accepted) return false;
        const resumeSend = await until(() => api.sendButton(), options.sendMs);
        if (!resumeSend) return false;
        try {
          resumeSend.focus?.();
          resumeSend.click();
          return true;
        } catch {
          return false;
        }
      }

      function resumeState() {
        if (leftoverRecap()) return false;
        return Boolean(continueControl()) || pageError() || thinkStopped();
      }

      let resumes = 0;
      while (resumes <= 1) {
        absorbKnownLeftover();
        absorbLeftoverRecap();
        const grownNow = publicNow();
        if (grownNow && !generating() && !ackRepeat(grownNow) && !staleAck(grownNow) && !pageError()
          && !looksIncomplete(grownNow) && !continueControl()) {
          return { text: grownNow, before, beforeThink };
        }
        if (generating() && !resumeState()) {
          return { pending: true, text: grownNow || '', before, beforeThink, generating: true, canContinue: resumeState() };
        }
        const finished = await until(() => {
          absorbKnownLeftover();
          absorbLeftoverRecap();
          if (resumeState()) return 'resume';
          if (!generating() && publicNow() && !ackRepeat(publicNow()) && !staleAck(publicNow())) return 'done';
          return null;
        }, options.finishMs);
        await wait(400);
        const grown = publicNow();
        if (grown && !generating() && !ackRepeat(grown) && !staleAck(grown) && !pageError()
          && !looksIncomplete(grown) && !continueControl()) {
          return { text: grown, before, beforeThink };
        }
        if (generating() && !resumeState()) {
          return { pending: true, text: grown || '', before, beforeThink, generating: true, canContinue: resumeState() };
        }
        if (continueControl() && !leftoverRecap()) {
          if (await clickContinue()) {
            resumes += 1;
            await until(() => generating() || publicNow() || resumeState(), options.startMs);
            continue;
          }
        }
        if ((pageError() || thinkStopped()) && resumes < 1 && !leftoverRecap()) {
          if (await clickContinue() || await typeResume()) {
            resumes += 1;
            await until(() => generating() || publicNow() || resumeState(), options.startMs);
            continue;
          }
        }
        if (!generating() && !continueControl() && looksIncomplete(grown) && resumes < 1) {
          if (await typeResume()) {
            resumes += 1;
            await until(() => generating() || publicNow() || resumeState(), options.startMs);
            continue;
          }
        }
        const text = publicNow();
        if (text && !ackRepeat(text) && !staleAck(text) && !pageError() && !looksIncomplete(text) && !continueControl()) {
          return { text, before, beforeThink };
        }
        if (finished === 'done' && text && !ackRepeat(text) && !staleAck(text) && !pageError()) {
          return { text, before, beforeThink };
        }
        return { pending: true, text: text || '', before, beforeThink, generating: generating(), canContinue: resumeState() };
      }
      const text = publicNow();
      return { pending: true, text: text || '', before, beforeThink, generating: generating(), canContinue: resumeState() };
    }

    async function resumeGeneration() {
      const button = continueControl();
      if (button) {
        try {
          button.click();
          return { ok: true, mode: 'click' };
        } catch {
          return { error: `${provider.toUpperCase()} continue control could not be clicked.` };
        }
      }
      if (generating() && !pageError() && !thinkStopped()) return { ok: true, mode: 'generating' };
      const box = await until(() => api.composer(), options.composerMs);
      if (!box) return { error: `${provider.toUpperCase()} composer was not found.` };
      const grown = lastAnswer();
      if (grown) active = { ...(active || { sent: '', before: '', beforeThink: '' }), before: grown };
      api.setValue(box, RESUME_PROMPT);
      const accepted = await until(() => {
        const current = api.composer();
        const text = String(current?.value || current?.innerText || current?.textContent || '').trim();
        return current && text === RESUME_PROMPT.trim() ? current : null;
      }, options.insertMs);
      if (!accepted) return { error: `${provider.toUpperCase()} did not accept the continue prompt.` };
      const send = await until(() => api.sendButton(), options.sendMs);
      if (!send) return { error: `${provider.toUpperCase()} send control was not found.` };
      try {
        send.focus?.();
        const PointerEventCtor = valueFrom(() => globalThis.PointerEvent || window.PointerEvent, null);
        if (typeof PointerEventCtor === 'function') {
          try {
            send.dispatchEvent(new PointerEventCtor('pointerdown', { bubbles: true, cancelable: true, isPrimary: true, button: 0 }));
            send.dispatchEvent(new PointerEventCtor('pointerup', { bubbles: true, cancelable: true, isPrimary: true, button: 0 }));
          } catch {}
        }
        send.click();
      } catch {
        return { error: `${provider.toUpperCase()} continue prompt could not be sent.` };
      }
      return { ok: true, mode: 'prompt' };
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
        if (message.type === `${namespace}-open-new-chat`) {
          const visibleAnswer = normalized(lastAnswer());
          if (valueFrom(() => api.isNewChatRoute?.(), false) === true
            && valueFrom(() => api.isFreshConversation?.(), false) === true
            && !hasConversation()
            && !visibleAnswer) {
            sendResponse({ started: true, alreadyOpen: true });
            return;
          }
          const control = valueFrom(() => api.newChat?.(), null);
          if (!control) {
            sendResponse({ error: `Could not find the ${provider.toUpperCase()} new-chat control.` });
            return;
          }
          // A provider may replace the whole document when New chat is activated.
          // Acknowledge the command first so the background can follow the navigation
          // and send the user's message only after the new route is confirmed.
          sendResponse({ started: true });
          setTimeout(() => {
            try {
              const current = valueFrom(() => api.newChat?.(), control) || control;
              if (typeof api.activateNewChat === 'function') api.activateNewChat(current);
              else current.click?.();
            } catch {}
          }, 0);
          return;
        }
        if (message.type === `${namespace}-read`) {
          sendResponse(read(message));
          return;
        }
        if (message.type === `${namespace}-resume`) {
          respond(sendResponse, () => resumeGeneration());
          return true;
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
