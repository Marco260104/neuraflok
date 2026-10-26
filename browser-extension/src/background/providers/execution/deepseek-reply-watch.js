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

function normalizedAnswer(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function identityProvesNewAnswer(beforeIdentity, answerIdentity) {
  if (!beforeIdentity || !answerIdentity || beforeIdentity === answerIdentity) return false;
  const beforePage = /^node:([^:]+):/.exec(beforeIdentity)?.[1] || '';
  const answerPage = /^node:([^:]+):/.exec(answerIdentity)?.[1] || '';
  if (beforePage || answerPage) return Boolean(beforePage && answerPage && beforePage === answerPage);
  return true;
}

function isFreshAnswer(answer, before, beforeIdentity, answerIdentity, sent = '') {
  const candidate = normalizedAnswer(answer);
  if (!candidate) return false;
  if (isDeepseekAck(candidate) && normalizedAnswer(before)) return false;
  const changedMessage = identityProvesNewAnswer(beforeIdentity, answerIdentity);
  const matchesPriorText = candidate === normalizedAnswer(before);
  const matchesSentText = candidate === normalizedAnswer(sent);
  return (!matchesPriorText && !matchesSentText) || changedMessage;
}

function freshPublicAnswer(answer, before, beforeIdentity, answerIdentity, sent = '') {
  if (!isFreshAnswer(answer, before, beforeIdentity, answerIdentity, sent)) return '';
  if (looksLikeDeepseekThink(answer) && !hasDeepseekToolCall(answer)) return '';
  return answer;
}

export function createDeepseekReplyWatcher({ stoppedProviderOffers, call, tabReply, postDeepseekPage, timings = {} }) {
  const DEEPSEEK_READ_MS = timings.readMs ?? 8_000;
  const DEEPSEEK_WATCH_MS = timings.watchMs ?? 540_000;
  const DEEPSEEK_READ_STALE_MS = timings.readStaleMs ?? 30_000;
  const DEEPSEEK_POLL_MS = timings.pollMs ?? 2_000;
  const DEEPSEEK_MAX_AUTOMATIC_CONTINUES = timings.maxAutomaticContinues ?? 6;
  const DEEPSEEK_EMPTY_IDLE_MS = timings.emptyIdleMs ?? 90_000;
  const DEEPSEEK_STALLED_GENERATION_MS = timings.stalledGenerationMs ?? 4 * 60_000;
  const DEEPSEEK_STOP_CONFIRM_MS = timings.stopConfirmMs ?? 12_000;

  return async function watchDeepseekReply(tabId, offer, before, beforeThink, initial, beforeIdentity = '') {
    // The immediate reply can contain DeepSeek's private reasoning. Re-read the
    // page and only ever publish the explicitly public answer field below.
    void initial;
    let lastText = '';
    let reportedText = '';
    let emptySince = null;
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
    let lastObservableActivity = '';
    let lastObservableProgressAt = Date.now();
    let completeText = isDeepseekAck(lastText) && !isDeepseekAck(before) ? lastText : '';
    let deadline = Date.now() + DEEPSEEK_WATCH_MS;

    while (Date.now() < deadline) {
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
          beforeThink,
          beforeIdentity
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
            const answerIdentity = typeof fallback.beforeIdentity === 'string' ? fallback.beforeIdentity : '';
            const freshAnswer = freshPublicAnswer(answer, before, beforeIdentity, answerIdentity, offer.text);
            snap = {
              ...fallback,
              answer: freshAnswer,
              answerIdentity,
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
      let publicAnswer = freshPublicAnswer(
        snap && typeof snap.answer === 'string' ? snap.answer : '',
        before,
        beforeIdentity,
        snap?.answerIdentity,
        offer.text
      );
      if (looksLikeDeepseekThink(publicAnswer) && !hasDeepseekToolCall(publicAnswer)) publicAnswer = '';
      if (think && publicAnswer && normalizedAnswer(publicAnswer) === normalizedAnswer(think)) publicAnswer = '';
      if (think && publicAnswer && publicAnswer.includes(think.trim()) && publicAnswer.length <= think.trim().length + 40) publicAnswer = '';
      const answerChanged = Boolean(publicAnswer.trim());
      const reasoningChanged = hasReasoningActivity && normalizedAnswer(think) !== normalizedAnswer(beforeThink);
      if (snap?.generating === true || answerChanged || reasoningChanged) turnActivitySeen = true;
      if (publicAnswer) lastText = publicAnswer;
      completeText = publicAnswer || (isDeepseekAck(lastText) && !isDeepseekAck(before) ? lastText : '');

      // A spinner alone is not evidence of progress: DeepSeek can leave its
      // generating flag set after the answer and private reasoning stop moving.
      // Keep long replies alive while observable text changes, but recover a
      // genuinely stalled generation instead of extending the page lease forever.
      // Private reasoning can move for a long time without any visible answer or
      // project work. It is not progress the user can verify and must not keep a
      // provider request alive indefinitely.
      const observableActivity = publicAnswer;
      if (publicAnswer && observableActivity !== lastObservableActivity) {
        lastObservableActivity = observableActivity;
        lastObservableProgressAt = Date.now();
      }
      if (snap?.generating === true && Date.now() - lastObservableProgressAt >= DEEPSEEK_STALLED_GENERATION_MS) {
        let stopConfirmed = false;
        const stopReply = await tabReply(tabId, {
          type: 'neuraflok-deepseek-complete',
          id: offer.id,
          conversationId: offer.conversationId,
          stop: true,
          text: ''
        }, undefined, DEEPSEEK_READ_MS).catch(() => null);
        if (stopReply?.ok === true) {
          const stopDeadline = Date.now() + DEEPSEEK_STOP_CONFIRM_MS;
          while (Date.now() < stopDeadline) {
            const afterStop = await tabReply(tabId, {
              type: 'neuraflok-deepseek-read',
              before,
              beforeThink,
              beforeIdentity
            }, undefined, DEEPSEEK_READ_MS).catch(() => null);
            if (afterStop?.generating === false) {
              stopConfirmed = true;
              break;
            }
            await new Promise(resolve => setTimeout(resolve, DEEPSEEK_POLL_MS));
          }
        }
        await postDeepseekPage(offer, {
          error: stopConfirmed
            ? 'DeepSeek stopped making observable progress. The existing chat was kept; NeuraFlok will resume the unfinished request automatically.'
            : 'DeepSeek did not confirm that generation stopped. The existing chat was kept; automatic resume was withheld to avoid sending a duplicate request. Check the same provider session before retrying.',
          ...(stopConfirmed ? { providerIdle: true } : {})
        }, tabId);
        return;
      }

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

      if (snap?.generating === true) {
        deadline = Date.now() + DEEPSEEK_WATCH_MS;
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

      if (snap && snap.generating !== true && !completeText) {
        if (emptySince === null) emptySince = Date.now();
        if (Date.now() - emptySince >= DEEPSEEK_EMPTY_IDLE_MS) {
          const fallback = await tabReply(tabId, { type: 'neuraflok-deepseek-snapshot' }, undefined, 4_000).catch(() => null);
          const answer = fallback && typeof fallback.before === 'string' ? fallback.before : '';
          const answerIdentity = typeof fallback?.beforeIdentity === 'string' ? fallback.beforeIdentity : '';
          const freshAnswer = freshPublicAnswer(answer, before, beforeIdentity, answerIdentity, offer.text);
          if (freshAnswer) {
            lastText = freshAnswer;
            if (await postDeepseekPage(offer, { text: lastText }, tabId)) return;
          }
          // Confirm the provider is still idle immediately before marking the
          // request safe for same-chat continuation. A fresh answer wins over
          // timeout recovery, and an uncertain read never permits a resend.
          const confirm = await tabReply(tabId, {
            type: 'neuraflok-deepseek-read', before, beforeThink, beforeIdentity
          }, undefined, DEEPSEEK_READ_MS).catch(() => null);
          const confirmedAnswer = freshPublicAnswer(
            typeof confirm?.answer === 'string' ? confirm.answer : '',
            before,
            beforeIdentity,
            confirm?.answerIdentity,
            offer.text
          );
          if (confirm?.generating === false && confirmedAnswer) {
            if (await postDeepseekPage(offer, { text: confirmedAnswer }, tabId)) return;
          }
          if (confirm?.generating === false && !confirmedAnswer) {
            await postDeepseekPage(offer, {
              error: 'DeepSeek stopped without returning a reply. The existing chat was kept; NeuraFlok will continue the unfinished request.',
              providerIdle: true
            });
            return;
          }
        }
      } else emptySince = null;
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
