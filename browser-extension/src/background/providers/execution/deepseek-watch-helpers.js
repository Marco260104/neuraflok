export function createDeepseekWatchHelpers(tabReply, timings = {}) {
  const DEEPSEEK_READ_MS = timings.readMs ?? 8_000;
  const DEEPSEEK_WATCH_MS = timings.watchMs ?? 240_000;
  const DEEPSEEK_POLL_MS = timings.pollMs ?? 2_000;
  const DEEPSEEK_GENERAL_POLL_MS = timings.generalPollMs ?? 5_000;
  const DEEPSEEK_TIMEOUT = 'DeepSeek did not finish this reply in time. Sign in at chat.deepseek.com in the same browser as this app, then send again.';
  const BLANK_SEND_ERROR = 'DeepSeek did not send this message. Open a new chat and try again.';
  const LEFTOVER_CONVERSATION = 'The provider page still showed a previous conversation. Open a new chat and send again.';
  const IDLE_NO_REPLY_ERROR = 'DeepSeek never started this reply: the message was not sent. Check the DeepSeek tab and send again.';
  const MAX_RESUMES = timings.maxResumes ?? 8;
  // A page that stays completely idle after a send never received the message
  // (DeepSeek restored the previous thread and dropped the composer). Do not
  // keep the UI on Thinking for the whole watch window in that case.
  const IDLE_NO_REPLY_MS = timings.idleNoReplyMs ?? 45_000;

  function isAck(text) {
    return /^(NEURAFLOK_READY|NEURAL_JAM_READY)$/.test(String(text || '').trim());
  }

  function hasToolCall(text) {
    return /```(?:neuraflok-tool|json)\b/i.test(text) || /<(?:exec_command|read|apply_patch)\b/i.test(text);
  }

  function looksLikeThink(text) {
    return /^(Let me|Let's|We need|I will|I'll |The user |Need to |Must not |Pensado|Pensó|Detenido|Voy a |Vamos a |Déjame |Dejame |Necesito |Debo |Hay que )\b/i.test(String(text || '').replace(/\s+/g, ' ').trim());
  }

  function looksLikeThinkChrome(text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value || value.length > 60) return false;
    return /^(detenido|pensado|pensó|pensando|stopped|thinking)\b/i.test(value);
  }

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
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (!value || hasToolCall(value) || value.length > 400) return false;
    return /server (is )?busy|temporarily unavailable|servidor no (está |esta )?disponible|please try again later|the server is busy|too many requests|el servidor (está|esta) ocupado/i.test(value);
  }

  function looksLikeProjectStatusRecap(text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (value.length < 80) return false;
    return /ya qued[oó] implementado|esto es lo que cambi[oó]|c[oó]mo probarlo|how to (try|test|open) it|npm run (dev|build)|no quedan tareas pendientes|the project is complete/i.test(value)
      && /\b[\w./-]+\.(js|ts|tsx|css|html|json)\b/.test(value);
  }

  function identityProvesNewAnswer(beforeIdentity, answerIdentity) {
    if (!beforeIdentity || !answerIdentity || beforeIdentity === answerIdentity) return false;
    const beforePage = /^node:([^:]+):/.exec(beforeIdentity)?.[1] || '';
    const answerPage = /^node:([^:]+):/.exec(answerIdentity)?.[1] || '';
    if (beforePage || answerPage) return Boolean(beforePage && answerPage && beforePage === answerPage);
    return true;
  }

  function quietNeed(text, conversationOnly) {
    if (isAck(text)) return 1;
    if (looksIncomplete(text)) return 12;
    if (conversationOnly && String(text || '').trim().length < 400) return 1;
    if (String(text || '').trim().length < 80) return 3;
    return 2;
  }

  function publicFromSnap(snap, before, beforeIdentity) {
    let publicAnswer = snap && typeof snap.answer === 'string' ? snap.answer : '';
    const folded = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const changedMessage = identityProvesNewAnswer(beforeIdentity, snap?.answerIdentity);
    if (!changedMessage && folded(publicAnswer) && folded(publicAnswer) === folded(before)) publicAnswer = '';
    if (isAck(publicAnswer) && String(before || '').trim()) publicAnswer = '';
    const think = snap && typeof snap.think === 'string' ? snap.think : '';
    if (think && publicAnswer && publicAnswer.replace(/\s+/g, ' ').trim() === think.replace(/\s+/g, ' ').trim()) publicAnswer = '';
    if (think && publicAnswer && publicAnswer.includes(think.trim()) && publicAnswer.length <= think.trim().length + 40) publicAnswer = '';
    if (looksLikeThink(publicAnswer) && !hasToolCall(publicAnswer) && snap?.generating === true) publicAnswer = '';
    if (looksLikeThinkChrome(publicAnswer) && !hasToolCall(publicAnswer)) publicAnswer = '';
    if (looksLikeServerError(publicAnswer)) publicAnswer = '';
    if (!changedMessage && looksLikeProjectStatusRecap(publicAnswer) && folded(publicAnswer) === folded(before)) publicAnswer = '';
    return publicAnswer;
  }

  function classifySnapshot({ snap, publicAnswer, lastText, before, beforeIdentity, initial, leftoverAbsorb, conversationOnly, isBootstrap }) {
    let completeText = publicAnswer || (isBootstrap && isAck(lastText) && !isAck(before) ? lastText : '');
    const generating = snap && snap.generating === true;
    const pageError = looksLikeServerError(snap && snap.answer) || looksLikeServerError(snap && snap.text);
    const canContinue = snap && (snap.canContinue === true || pageError);
    const changedMessage = identityProvesNewAnswer(beforeIdentity, snap?.answerIdentity);
    const folded = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const leftoverPublic = !changedMessage && Boolean(completeText && (
      (folded(before) && folded(completeText) === folded(before))
      || (folded(initial) && folded(completeText) === folded(initial))
    ));
    const stalledThink = /\bdetenido\b|\bstopped\b/i.test(String(snap && snap.think || ''));
    if (!completeText && lastText && (changedMessage || folded(lastText) !== folded(before)) && !isAck(lastText)
      && !(!changedMessage && leftoverAbsorb && looksLikeProjectStatusRecap(lastText))) {
      completeText = lastText;
    }
    const leftoverResumeHold = !changedMessage && leftoverAbsorb && !completeText;
    const leftoverGeneral = leftoverResumeHold && !generating;
    const needsResume = !leftoverResumeHold && (
      looksIncomplete(completeText) || pageError
      || (!completeText && canContinue)
      || (canContinue && leftoverPublic)
      || (canContinue && generating)
      || (canContinue && stalledThink)
    );
    const rawAnswer = snap && typeof snap.answer === 'string' ? snap.answer : '';
    const idleAnswer = rawAnswer && !looksIncomplete(rawAnswer) && !looksLikeServerError(rawAnswer)
      && (changedMessage || (folded(rawAnswer) !== folded(before) && folded(rawAnswer) !== folded(initial)))
      && !leftoverResumeHold
      && !(!changedMessage && conversationOnly && looksLikeProjectStatusRecap(rawAnswer))
      ? rawAnswer : '';
    return {
      completeText,
      generating,
      pageError,
      canContinue,
      leftoverPublic,
      stalledThink,
      leftoverResumeHold,
      leftoverGeneral,
      needsResume,
      settleText: completeText || idleAnswer
    };
  }

  async function resumePage(tabId) {
    const reply = await tabReply(tabId, { type: 'neuraflok-deepseek-resume' }, undefined, 20_000).catch(() => null);
    if (!reply || reply.ok !== true) return null;
    return reply;
  }

  return {
    DEEPSEEK_READ_MS,
    DEEPSEEK_WATCH_MS,
    DEEPSEEK_POLL_MS,
    DEEPSEEK_GENERAL_POLL_MS,
    DEEPSEEK_TIMEOUT,
    BLANK_SEND_ERROR,
    LEFTOVER_CONVERSATION,
    IDLE_NO_REPLY_ERROR,
    IDLE_NO_REPLY_MS,
    MAX_RESUMES,
    isAck,
    hasToolCall,
    looksLikeThink,
    looksIncomplete,
    looksLikeServerError,
    looksLikeProjectStatusRecap,
    identityProvesNewAnswer,
    quietNeed,
    publicFromSnap,
    classifySnapshot,
    resumePage
  };
}

// Fails the turn when DeepSeek never starts a reply after the send. Without
// this, a message lost while the page restored an old thread keeps NeuraFlok
// on Thinking for the whole watch window.
export function createIdleNoReplyGuard(idleNoReplyMs, error) {
  let since = 0;
  return (generating, completeText, needsResume) => {
    if (generating || completeText || needsResume) {
      since = 0;
      return '';
    }
    if (since === 0) since = Date.now();
    return Date.now() - since >= idleNoReplyMs ? error : '';
  };
}

// Settles a visible answer that the public parser could not expose (think
// wrappers/headers) once it has stayed identical for a few idle polls.
export function createStableSettleFallback(quietPolls = 8) {
  const folded = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  let text = '';
  let idle = 0;
  return (candidate, before, initial) => {
    if (!candidate || folded(candidate) === folded(before) || folded(candidate) === folded(initial)) {
      text = '';
      idle = 0;
      return '';
    }
    if (candidate === text) idle += 1;
    else {
      text = candidate;
      idle = 0;
    }
    return idle >= quietPolls ? candidate : '';
  };
}

// Counts consecutive identical observations and reports when a value is stable
// for the requested number of polls.
export function createStableCounter(needed = 15) {
  let text = '';
  let idle = 0;
  return (candidate) => {
    const value = String(candidate || '');
    if (!value) {
      text = '';
      idle = 0;
      return false;
    }
    if (value === text) idle += 1;
    else {
      text = value;
      idle = 0;
    }
    return idle >= needed;
  };
}

export function reportDeepseekProgress(call, offer, body) {
  void call('/provider/page/progress', {
    method: 'POST',
    body: JSON.stringify({
      id: offer.id,
      provider: 'deepseek',
      conversationId: offer.conversationId,
      ...body
    })
  }).catch(() => undefined);
}

// Re-reads a full snapshot after empty polls and publishes a public answer that
// the regular read could not expose, while keeping a late paint of the previous
// conversation as leftover instead of posting it as this turn's reply.
export async function recoverIdleSnapshot(options) {
  const { tabReply, postDeepseekPage, offer, tabId, before, initial, beforeIdentity,
    generating, pageError, identityProvesNewAnswer, isAck, looksLikeServerError, looksLikeProjectStatusRecap } = options;
  const folded = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const fallback = await tabReply(tabId, { type: 'neuraflok-deepseek-snapshot' }, undefined, 4_000).catch(() => null);
  const ans = fallback && typeof fallback.before === 'string' ? fallback.before : '';
  const ansIdentity = fallback && typeof fallback.beforeIdentity === 'string' ? fallback.beforeIdentity : '';
  const fallbackNewMsg = identityProvesNewAnswer(beforeIdentity, ansIdentity);
  if (!ans || !(fallbackNewMsg || (folded(ans) !== folded(before) && folded(ans) !== folded(initial)))
    || (isAck(ans) && isAck(before)) || looksLikeServerError(ans)) return { posted: false, before };
  if (!generating && !fallback.generating && !pageError && (fallbackNewMsg || !looksLikeProjectStatusRecap(ans))) {
    return { posted: await postDeepseekPage(offer, { text: ans }), before };
  }
  // Late paint of the previous conversation: keep it as leftover.
  return { posted: false, before: ans };
}

export async function settleDeepseekWatchDeadline(postDeepseekPage, offer, completeText, lastText, leftoverAbsorb, conversationOnly, timeout, helpers = {}) {
  // `looksLikeProjectStatusRecap` lives in createDeepseekWatchHelpers; passing it
  // explicitly keeps this deadline path from throwing a ReferenceError that used
  // to replace the real timeout with "looksLikeProjectStatusRecap is not defined".
  const isRecap = typeof helpers.looksLikeProjectStatusRecap === 'function'
    ? helpers.looksLikeProjectStatusRecap
    : () => false;
  const grown = completeText || lastText;
  if (grown && !(leftoverAbsorb && isRecap(grown)) && !(conversationOnly && isRecap(grown))) {
    await postDeepseekPage(offer, { text: grown });
  } else await postDeepseekPage(offer, { error: timeout });
}
