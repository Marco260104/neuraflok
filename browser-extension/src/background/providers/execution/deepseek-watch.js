import {
  createDeepseekWatchHelpers,
  createIdleNoReplyGuard,
  createStableCounter,
  createStableSettleFallback,
  recoverIdleSnapshot,
  reportDeepseekProgress,
  settleDeepseekWatchDeadline
} from './deepseek-watch-helpers.js';

export function createDeepseekReplyWatcher({ tabReply, call, postDeepseekPage, stoppedProviderOffers, timings = {} }) {
  const {
    DEEPSEEK_READ_MS, DEEPSEEK_WATCH_MS, DEEPSEEK_POLL_MS, DEEPSEEK_GENERAL_POLL_MS,
    DEEPSEEK_TIMEOUT, BLANK_SEND_ERROR, LEFTOVER_CONVERSATION, IDLE_NO_REPLY_ERROR, IDLE_NO_REPLY_MS, MAX_RESUMES,
    isAck, hasToolCall, looksLikeThink, looksIncomplete, looksLikeServerError,
    looksLikeProjectStatusRecap, identityProvesNewAnswer, quietNeed, publicFromSnap, classifySnapshot, resumePage
  } = createDeepseekWatchHelpers(tabReply, timings);

  async function watchDeepseekReply(tabId, offer, before, beforeThink, initial, beforeIdentity = '') {
    let lastText = typeof initial === 'string' && !looksLikeThink(initial) ? initial : '';
    if (isAck(lastText) && String(before || '').trim()) lastText = '';
    let reportedText = '';
    let emptyIdle = 0;
    const stableSettleText = createStableCounter(15);
    let quietText = '';
    let quietIdle = 0;
    let lastProgressAt = 0;
    let lastObservableAnswer = '';
    const idleNoReply = createIdleNoReplyGuard(IDLE_NO_REPLY_MS, IDLE_NO_REPLY_ERROR);
    const stableSettle = createStableSettleFallback(8);
    let resumes = 0;
    const isBootstrap = /Initialize this NEURAFLOK conversation|NEURAFLOK_READY/i.test(String(offer.text || ''));
    let completeText = isAck(lastText) && !isAck(before) ? (isBootstrap ? lastText : '') : '';
    let deadline = Date.now() + DEEPSEEK_WATCH_MS;
    const conversationOnly = /This is a conversation only/i.test(String(offer.text || ''));
    const pollMs = conversationOnly ? DEEPSEEK_GENERAL_POLL_MS : DEEPSEEK_POLL_MS;
    const leftoverIdleLimit = Math.ceil(90_000 / pollMs);
    const blankIdleLimit = Math.max(3, Math.ceil(16_000 / pollMs));
    const folded = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    let leftoverAbsorb = false;
    while (Date.now() < deadline) {
      if (stoppedProviderOffers.has(offer.id)) {
        stoppedProviderOffers.delete(offer.id);
        await postDeepseekPage(offer, { stopped: true });
        return;
      }
      const snap = await tabReply(tabId, {
        type: 'neuraflok-deepseek-read',
        before,
        beforeThink,
        beforeIdentity
      }, undefined, DEEPSEEK_READ_MS).catch(() => null);
      let publicAnswer = publicFromSnap(snap, before, beforeIdentity);
      const rawAnswer = snap && typeof snap.answer === 'string' ? snap.answer : '';
      const leftoverRecapPaint = looksLikeProjectStatusRecap(publicAnswer)
        || looksLikeProjectStatusRecap(rawAnswer)
        || looksLikeProjectStatusRecap(before);
      leftoverAbsorb = leftoverRecapPaint && (
        (offer.fresh === true && !folded(before))
        || (Boolean(publicAnswer || rawAnswer) && folded(publicAnswer || rawAnswer) === folded(before))
      );
      if (isAck(rawAnswer) && !isAck(before)) {
        leftoverAbsorb = false;
        publicAnswer = isBootstrap ? rawAnswer : '';
      } else if (!isBootstrap && isAck(publicAnswer)) {
        publicAnswer = '';
      } else if (leftoverAbsorb && (looksLikeProjectStatusRecap(publicAnswer) || looksLikeProjectStatusRecap(rawAnswer))) {
        const leftover = looksLikeProjectStatusRecap(publicAnswer) ? publicAnswer : rawAnswer;
        if (leftover && folded(leftover) === folded(before)) publicAnswer = '';
      }
      if (publicAnswer) lastText = publicAnswer;
      if (!publicAnswer && snap && (emptyIdle === 0 || emptyIdle % 10 === 0)) {
        void call('/provider/page/progress', {
          method: 'POST',
          body: JSON.stringify({
            id: offer.id, provider: 'deepseek', conversationId: offer.conversationId,
            text: '', generating: true, inspect: snap.inspect || {
              answer: snap.answer, think: snap.think, generating: snap.generating
            }
          })
        }).catch(() => undefined);
      }
      const state = classifySnapshot({ snap, publicAnswer, lastText, before, beforeIdentity, initial, leftoverAbsorb, conversationOnly, isBootstrap });
      completeText = state.completeText;
      // Provider retries are not progress. Only new public answer text renews
      // the no-progress budget, so repeated Continue clicks cannot keep a dead
      // reply alive for MAX_RESUMES × the full watch window.
      if (completeText && completeText !== lastObservableAnswer) {
        lastObservableAnswer = completeText;
        deadline = Date.now() + DEEPSEEK_WATCH_MS;
      }
      const { generating, pageError, canContinue, leftoverPublic, stalledThink,
        leftoverResumeHold, leftoverGeneral, needsResume, settleText } = state;
      // Click Continue / Retry even if leftover generating chrome is still on the page.
      if (canContinue && needsResume && resumes < MAX_RESUMES) {
        const resumed = await resumePage(tabId);
        if (resumed && resumed.mode !== 'generating') {
          resumes += 1;
          quietIdle = 0;
          emptyIdle = 0;
          await new Promise(resolve => setTimeout(resolve, Math.min(8_000, pollMs * resumes)));
          continue;
        }
      }
      if (!generating && !canContinue && looksIncomplete(completeText) && resumes < MAX_RESUMES) {
        const resumed = await resumePage(tabId);
        if (resumed && resumed.mode !== 'generating') {
          resumes += 1;
          before = completeText;
          quietIdle = 0;
          emptyIdle = 0;
          await new Promise(resolve => setTimeout(resolve, Math.min(8_000, pollMs * resumes)));
          continue;
        }
      }
      // DeepSeek already answered on the page but the send was lost while its
      // home screen restored the previous thread: the page stays completely
      // idle and no new text ever appears.
      const idleError = idleNoReply(generating, completeText, needsResume);
      if (idleError) {
        await postDeepseekPage(offer, { error: idleError });
        return;
      }
      if (isAck(completeText) && !isBootstrap) completeText = '';
      if (completeText && !generating && !pageError && (!looksIncomplete(completeText) || resumes >= MAX_RESUMES)) {
        if (conversationOnly && !leftoverGeneral && folded(completeText) !== folded(before) && !looksLikeProjectStatusRecap(completeText)) {
          const posted = await postDeepseekPage(offer, { text: completeText });
          if (posted) return;
        }
        if (conversationOnly && looksLikeProjectStatusRecap(completeText)) {
          before = completeText;
          quietText = completeText;
          quietIdle = 0;
        } else if (completeText === quietText) {
          quietIdle += 1;
          if (quietIdle >= quietNeed(completeText, conversationOnly)) {
            const posted = await postDeepseekPage(offer, { text: completeText });
            if (posted) return;
          }
        } else {
          quietText = completeText;
          quietIdle = 0;
        }
      } else {
        quietText = completeText;
        quietIdle = 0;
        // Think wrappers/headers can keep the public parser empty after the
        // stream finished; settle the stable visible answer instead of timing out.
        const settled = stableSettle(!completeText && !generating && !pageError ? settleText : '', before, initial);
        if (settled) {
          const posted = await postDeepseekPage(offer, { text: settled });
          if (posted) return;
        }
      }
      if (generating) {
        if (completeText && (completeText !== reportedText || Date.now() - lastProgressAt > 15_000)) {
          reportedText = completeText;
          lastProgressAt = Date.now();
          reportDeepseekProgress(call, offer, { text: completeText, generating: true });
        }
        if (stableSettleText(settleText) && !needsResume && !leftoverGeneral
          && folded(settleText) !== folded(before)) {
          const posted = await postDeepseekPage(offer, { text: settleText });
          if (posted) return;
        }
      } else if (!completeText && lastText && isAck(lastText) && !isAck(before) && isBootstrap) {
        if (stableSettleText(lastText)) {
          const posted = await postDeepseekPage(offer, { text: lastText });
          if (posted) return;
        }
      } else {
        stableSettleText('');
      }
      const blankFresh = (conversationOnly || offer.fresh === true) && !completeText && !leftoverRecapPaint
        && !generating && !needsResume;
      if (!snap || (snap && !completeText && !needsResume && (!generating || leftoverResumeHold || leftoverGeneral || blankFresh))) {
        emptyIdle += 1;
        if (snap && emptyIdle >= 4) {
          const recovered = await recoverIdleSnapshot({
            tabReply, postDeepseekPage, offer, tabId, before, initial, beforeIdentity,
            generating, pageError, identityProvesNewAnswer, isAck, looksLikeServerError, looksLikeProjectStatusRecap
          });
          if (recovered.posted) return;
          before = recovered.before;
        }
        if (blankFresh && emptyIdle >= blankIdleLimit) {
          await postDeepseekPage(offer, { error: BLANK_SEND_ERROR });
          return;
        }
        if (leftoverResumeHold && emptyIdle >= leftoverIdleLimit) {
          await postDeepseekPage(offer, { error: LEFTOVER_CONVERSATION });
          return;
        }
        if (emptyIdle >= Math.ceil(360_000 / pollMs)) {
          const grown = completeText || lastText;
          if (grown && !(leftoverAbsorb && looksLikeProjectStatusRecap(grown)) && !(conversationOnly && looksLikeProjectStatusRecap(grown))) {
            await postDeepseekPage(offer, { text: grown });
          } else await postDeepseekPage(offer, { error: DEEPSEEK_TIMEOUT });
          return;
        }
      } else if (!leftoverResumeHold) emptyIdle = 0;
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    await settleDeepseekWatchDeadline(postDeepseekPage, offer, completeText, lastText,
      leftoverAbsorb, conversationOnly, DEEPSEEK_TIMEOUT, { looksLikeProjectStatusRecap });
  }

  return { watchDeepseekReply, isAck, looksLikeThink, hasToolCall };
}
