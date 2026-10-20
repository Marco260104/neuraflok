export function isDeepseekAck(text) {
  return /^(NEURAFLOK_READY|NEURAL_JAM_READY)$/.test(String(text || '').trim());
}

export function hasDeepseekToolCall(text) {
  return /```(?:neuraflok-tool|json)\b/i.test(text) || /<(?:exec_command|read|apply_patch)\b/i.test(text) || /<[|｜]{2}DSML[|｜]{2}\s*invoke\s+name=/i.test(text);
}

export function looksLikeDeepseekThink(text) {
  return /^(Let me|Let's|We need|I will|I'll |The user |Need to |Must not |Pensado|Pensó|Detenido|Voy a |Vamos a |Déjame |Dejame |Necesito |Debo |Hay que )\b/i.test(String(text || '').replace(/\s+/g, ' ').trim());
}

function quietNeed(text) {
  if (isDeepseekAck(text)) return 1;
  if (String(text || '').trim().length < 80) return 6;
  return 3;
}

export function createDeepseekReplyWatcher({ stoppedProviderOffers, call, tabReply, postDeepseekPage, timings = {} }) {
  const DEEPSEEK_READ_MS = timings.readMs ?? 8_000;
  const DEEPSEEK_WATCH_MS = timings.watchMs ?? 540_000;
  const DEEPSEEK_MAX_WATCH_MS = timings.maxWatchMs ?? 1_800_000;
  const DEEPSEEK_READ_STALE_MS = timings.readStaleMs ?? 30_000;
  const DEEPSEEK_POLL_MS = timings.pollMs ?? 2_000;
  const DEEPSEEK_MAX_AUTOMATIC_CONTINUES = timings.maxAutomaticContinues ?? 6;
  const DEEPSEEK_EMPTY_IDLE_POLLS = timings.emptyIdlePolls ?? 180;

  return async function watchDeepseekReply(tabId, offer, before, beforeThink, initial) {
    let lastText = typeof initial === 'string' ? initial : '';
    let reportedText = '';
    let emptyIdle = 0;
    let stableText = '';
    let stableIdle = 0;
    let quietText = '';
    let quietIdle = 0;
    let lastProgressAt = 0;
    let consecutiveReadFailures = 0;
    let automaticContinues = 0;
    let lastGenerationActive = false;
    let lastSuccessfulReadAt = Date.now();
    let reportedThink = '';
    let completeText = isDeepseekAck(lastText) && !isDeepseekAck(before) ? lastText : '';
    let deadline = Date.now() + DEEPSEEK_WATCH_MS;
    const hardDeadline = Date.now() + DEEPSEEK_MAX_WATCH_MS;

    while (Date.now() < deadline && Date.now() < hardDeadline) {
      if (stoppedProviderOffers.has(offer.id)) {
        stoppedProviderOffers.delete(offer.id);
        await postDeepseekPage(offer, { stopped: true });
        return;
      }
      let snap = null;
      try {
        snap = await tabReply(tabId, {
          type: 'neuraflok-deepseek-read',
          before,
          beforeThink
        }, undefined, DEEPSEEK_READ_MS);
        consecutiveReadFailures = 0;
      } catch {
        consecutiveReadFailures++;
        // Provider tabs can briefly stop answering extension messages while they rerender.
        // Re-read a complete snapshot after several failures instead of abandoning sent work.
        if (consecutiveReadFailures % 3 === 0) {
          const fallback = await tabReply(tabId, { type: 'neuraflok-deepseek-snapshot' }, undefined, 4_000).catch(() => null);
          if (fallback) {
            const answer = typeof fallback.before === 'string' ? fallback.before : '';
            const freshAnswer = answer !== before && !(isDeepseekAck(answer) && isDeepseekAck(before)) ? answer : '';
            snap = {
              ...fallback,
              answer: freshAnswer,
              think: typeof fallback.beforeThink === 'string' ? fallback.beforeThink : '',
              text: freshAnswer
            };
          }
        }
        if (!snap) {
          await new Promise(resolve => setTimeout(resolve, DEEPSEEK_POLL_MS));
          continue;
        }
        consecutiveReadFailures = 0;
      }

      lastSuccessfulReadAt = Date.now();
      const think = snap && typeof snap.think === 'string' ? snap.think : '';
      const hasReasoningActivity = Boolean(think.trim());
      const thinkChanged = hasReasoningActivity && think !== reportedThink;
      if (thinkChanged) reportedThink = think;
      lastGenerationActive = snap?.generating === true;
      let publicAnswer = snap && typeof snap.answer === 'string' ? snap.answer : '';
      if (isDeepseekAck(publicAnswer) && String(before || '').trim()) publicAnswer = '';
      if (looksLikeDeepseekThink(publicAnswer) && !hasDeepseekToolCall(publicAnswer)) publicAnswer = '';
      if (think && publicAnswer && publicAnswer.replace(/\s+/g, ' ').trim() === think.replace(/\s+/g, ' ').trim()) publicAnswer = '';
      if (think && publicAnswer && publicAnswer.includes(think.trim()) && publicAnswer.length <= think.trim().length + 40) publicAnswer = '';
      const text = publicAnswer || (snap && typeof snap.text === 'string' ? snap.text : '');
      if (text) lastText = text;
      completeText = publicAnswer || (isDeepseekAck(lastText) && !isDeepseekAck(before) ? lastText : '');

      if (completeText && snap && snap.generating !== true) {
        if (completeText === quietText) {
          quietIdle += 1;
          if (quietIdle >= quietNeed(completeText)) {
            if (snap.continueAvailable === true && automaticContinues < DEEPSEEK_MAX_AUTOMATIC_CONTINUES) {
              void call('/provider/page/progress', {
                method: 'POST',
                body: JSON.stringify({ id: offer.id, provider: 'deepseek', conversationId: offer.conversationId, text: completeText, generating: true })
              }).catch(() => undefined);
              const continued = await tabReply(tabId, {
                type: 'neuraflok-deepseek-continue',
                id: offer.id,
                conversationId: offer.conversationId
              }, undefined, DEEPSEEK_READ_MS).catch(() => null);
              if (continued?.continued === true) {
                automaticContinues++;
                deadline = Date.now() + DEEPSEEK_WATCH_MS;
                quietText = '';
                quietIdle = 0;
                stableText = '';
                stableIdle = 0;
                await new Promise(resolve => setTimeout(resolve, DEEPSEEK_POLL_MS));
                continue;
              }
            }
            if (await postDeepseekPage(offer, { text: completeText }, tabId)) return;
          }
        } else {
          quietText = completeText;
          quietIdle = 0;
        }
      } else {
        quietText = completeText;
        quietIdle = 0;
      }

      if (snap && (snap.generating === true || hasReasoningActivity)) {
        deadline = Date.now() + DEEPSEEK_WATCH_MS;
        if (hasReasoningActivity) emptyIdle = 0;
        if (lastText !== reportedText || thinkChanged || Date.now() - lastProgressAt > 15_000) {
          reportedText = lastText;
          lastProgressAt = Date.now();
          void call('/provider/page/progress', {
            method: 'POST',
            body: JSON.stringify({ id: offer.id, provider: 'deepseek', conversationId: offer.conversationId, text: lastText, generating: true })
          }).catch(() => undefined);
        }
        stableText = completeText;
        stableIdle = 0;
      } else if (!completeText && lastText && isDeepseekAck(lastText) && !isDeepseekAck(before)) {
        if (lastText === stableText) {
          stableIdle++;
          if (stableIdle >= 15 && await postDeepseekPage(offer, { text: lastText }, tabId)) return;
        } else {
          stableText = lastText;
          stableIdle = 0;
        }
      } else {
        stableText = lastText;
        stableIdle = 0;
      }

      if (snap && snap.generating !== true && !lastText && !hasReasoningActivity) {
        emptyIdle++;
        if (emptyIdle >= 4) {
          const fallback = await tabReply(tabId, { type: 'neuraflok-deepseek-snapshot' }, undefined, 4_000).catch(() => null);
          const answer = fallback && typeof fallback.before === 'string' ? fallback.before : '';
          if (answer && answer !== before && !(isDeepseekAck(answer) && isDeepseekAck(before))) {
            lastText = answer;
            if (await postDeepseekPage(offer, { text: lastText }, tabId)) return;
          }
        }
        if (emptyIdle >= DEEPSEEK_EMPTY_IDLE_POLLS) {
          await postDeepseekPage(offer, { error: 'DeepSeek did not finish this reply in time. Check the same provider session before retrying; if your message is there, do not send it again.' });
          return;
        }
      } else emptyIdle = 0;
      await new Promise(resolve => setTimeout(resolve, DEEPSEEK_POLL_MS));
    }

    const timeout = 'DeepSeek did not finish this reply in time. Check the same provider session before retrying; if your message is there, do not send it again.';
    if (completeText && !lastGenerationActive && Date.now() - lastSuccessfulReadAt <= DEEPSEEK_READ_STALE_MS)
      await postDeepseekPage(offer, { text: completeText }, tabId);
    else await postDeepseekPage(offer, { error: timeout });
  };
}
