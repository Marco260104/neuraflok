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
    // The immediate reply can contain DeepSeek's private reasoning. Re-read the
    // page and only ever publish the explicitly public answer field below.
    void initial;
    let lastText = '';
    let reportedText = '';
    let emptyIdle = 0;
    let stableText = '';
    let stableIdle = 0;
    let quietText = '';
    let quietIdle = 0;
    let lastProgressAt = 0;
    let consecutiveReadFailures = 0;
    let lastGenerationActive = false;
    let lastSuccessfulReadAt = Date.now();
    let reportedThink = typeof beforeThink === 'string' ? beforeThink : '';
    let continuationText = '';
    let continuationIdle = 0;
    let continuationAttempts = 0;
    let turnActivitySeen = false;
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
      const answerChanged = Boolean(publicAnswer.trim()) && publicAnswer.replace(/\s+/g, ' ').trim() !== String(before || '').replace(/\s+/g, ' ').trim();
      const reasoningChanged = hasReasoningActivity && think.replace(/\s+/g, ' ').trim() !== String(beforeThink || '').replace(/\s+/g, ' ').trim();
      if (snap?.generating === true || answerChanged || reasoningChanged) turnActivitySeen = true;
      if (publicAnswer) lastText = publicAnswer;
      completeText = publicAnswer || (isDeepseekAck(lastText) && !isDeepseekAck(before) ? lastText : '');

      const continueIsStable = snap && snap.generating !== true && snap.continueAvailable === true &&
        turnActivitySeen && continuationAttempts < DEEPSEEK_MAX_AUTOMATIC_CONTINUES;
      if (continueIsStable) {
        const activity = `${publicAnswer}\n${think}`;
        if (activity === continuationText) continuationIdle++;
        else {
          continuationText = activity;
          continuationIdle = 1;
        }
        if (continuationIdle >= quietNeed(publicAnswer || think)) {
          continuationAttempts++;
          const continued = await tabReply(tabId, {
            type: 'neuraflok-deepseek-continue',
            id: offer.id,
            conversationId: offer.conversationId
          }, undefined, DEEPSEEK_READ_MS).catch(() => null);
          if (continued?.continued === true) {
            deadline = Date.now() + DEEPSEEK_WATCH_MS;
            quietText = '';
            quietIdle = 0;
            stableText = '';
            stableIdle = 0;
            continuationText = '';
            continuationIdle = 0;
            reportedThink = think;
            await new Promise(resolve => setTimeout(resolve, DEEPSEEK_POLL_MS));
            continue;
          }
          continuationIdle = 0;
        }
      } else {
        continuationText = '';
        continuationIdle = 0;
      }

      if (completeText && snap && snap.generating !== true) {
        if (completeText === quietText) {
          quietIdle += 1;
          if (quietIdle >= quietNeed(completeText)) {
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
          await postDeepseekPage(offer, {
            error: 'DeepSeek did not finish this reply in time. Check the same provider session before retrying; if your message is there, do not send it again.',
            providerIdle: true
          });
          return;
        }
      } else emptyIdle = 0;
      await new Promise(resolve => setTimeout(resolve, DEEPSEEK_POLL_MS));
    }

    const timeout = 'DeepSeek did not finish this reply in time. Check the same provider session before retrying; if your message is there, do not send it again.';
    if (completeText && !lastGenerationActive && Date.now() - lastSuccessfulReadAt <= DEEPSEEK_READ_STALE_MS)
      await postDeepseekPage(offer, { text: completeText }, tabId);
    else await postDeepseekPage(offer, {
      error: timeout,
      ...(Date.now() - lastSuccessfulReadAt <= DEEPSEEK_READ_STALE_MS && !lastGenerationActive ? { providerIdle: true } : {})
    });
  };
}
