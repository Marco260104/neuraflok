import { createDeepseekSessionResolver } from '../deepseek-session.js';
import { createDeepseekReplyWatcher, hasDeepseekToolCall, isDeepseekAck, looksLikeDeepseekThink } from './deepseek-reply-watch.js';
import { loadDeepseekAttachments } from './deepseek-attachments.js';
import { stageDeepseekAttachmentsInMainWorld } from './deepseek-main-world-attachments.js';
import { createDeepseekTabReuse } from './deepseek-tab-reuse.js';
import { createDeepseekPageReports } from './deepseek-page-reports.js';
import { openFreshDeepseekChat } from '../deepseek-new-chat.js';

export function createDeepseekPageExecutor({ chrome, activeTabs, call, tabReply, createBrowserTab, queryProviderTabs, restoreDeepseekTab, waitForTabReady, isDeepseekUrl, usableProviderTab, state, replyWatchTimings = {} }) {
  const { stoppedProviderOffers, readDeepseekSent, writeDeepseekSent, readProviderTab, writeProviderTab } = state;
  let deepseekPageFlight = null;
  // Uploading a large PDF can take longer than the text-only send path. Keep
  // the tab request alive while the page confirms the file and accepts send.
  const DEEPSEEK_SEND_MS = 360_000;
  const DEEPSEEK_READ_MS = 8_000;
  const DEEPSEEK_READY_MS = 20_000;
  const DEEPSEEK_READY_POLL_MS = 250;
  const sessionPages = createDeepseekSessionResolver({
    chrome, tabReply, createBrowserTab, queryProviderTabs, restoreDeepseekTab,
    waitForTabReady, isDeepseekUrl, usableProviderTab, state
  });
  const { conversationPageUrl, rememberConversationPage, resolveExistingDeepseekTab } = sessionPages;
  const { postDeepseekPage, reportAttachmentUploaded } = createDeepseekPageReports({
    call, state, rememberConversationPage
  });
  const reusableFreshTab = createDeepseekTabReuse({
    chrome, queryProviderTabs, usableProviderTab, restoreDeepseekTab, tabReply,
    isDeepseekUrl, readProviderTab, conversationPageUrl
  });

  const watchDeepseekReply = createDeepseekReplyWatcher({
    stoppedProviderOffers, call, tabReply, postDeepseekPage, timings: replyWatchTimings
  });

  function inspectDeepseekPage(offer, background) {
    if (!offer || typeof offer.id !== 'string' || typeof offer.conversationId !== 'string') return;
    if (deepseekPageFlight) {
      if (offer.stop === true) {
        stoppedProviderOffers.add(offer.id);
        void (async () => {
          const sent = await readDeepseekSent();
          const binding = await readProviderTab(offer.conversationId);
          const tabId = sent?.id === offer.id && sent.conversationId === offer.conversationId
            ? sent.tab : binding?.tab;
          if (Number.isInteger(tabId)) {
            await tabReply(tabId, { type: 'neuraflok-deepseek-complete', id: offer.id, conversationId: offer.conversationId, stop: true, text: '' }, undefined, 5_000);
          }
          await postDeepseekPage(offer, { stopped: true });
        })().catch(() => undefined);
      }
      return;
    }
    deepseekPageFlight = (async () => {
      const fail = async (error) => {
        await postDeepseekPage(offer, { error: String(error || 'DeepSeek page did not answer.').slice(0, 500) });
      };
      try {
        const sent = await readDeepseekSent();
        if (sent && sent.id === offer.id && sent.conversationId === offer.conversationId && Number.isInteger(sent.tab) && !offer.stop) {
          await watchDeepseekReply(
            sent.tab,
            offer,
            typeof sent.before === 'string' ? sent.before : '',
            typeof sent.beforeThink === 'string' ? sent.beforeThink : '',
            '',
            typeof sent.beforeIdentity === 'string' ? sent.beforeIdentity : ''
          );
          return;
        }
        let tab = null;
        let binding = null;
        let savedUrl = null;
        let rebindSavedConversation = false;
        if (offer.fresh === true && !offer.stop) {
          const reusable = await reusableFreshTab(offer, background);
          if (reusable) {
            tab = reusable.tab;
            rebindSavedConversation = reusable.rebindSavedConversation;
          } else {
            tab = await createBrowserTab('https://chat.deepseek.com/', background === true);
          }
          if (Number.isInteger(tab?.id)) {
            if (!await writeProviderTab(offer.conversationId, tab.id)) throw new Error('Could not reserve this DeepSeek tab for the local session.');
            await waitForTabReady(tab.id);
            await restoreDeepseekTab(tab.id);
            tab = await chrome.tabs.get(tab.id);
            if (!isDeepseekUrl(tab.url) || tab.pendingUrl || tab.status !== 'complete') {
              throw new Error('The new DeepSeek page did not finish loading. No message was sent.');
            }
          }
        } else {
          const resolved = await resolveExistingDeepseekTab(offer, background);
          tab = resolved.tab;
          binding = resolved.binding;
          savedUrl = resolved.savedUrl;
          if (tab.discarded === true || tab.frozen === true || tab.status === 'loading') {
            try { await chrome.tabs.reload(tab.id); } catch {}
            await waitForTabReady(tab.id);
            await restoreDeepseekTab(tab.id);
            tab = await chrome.tabs.get(tab.id).catch(() => null);
            if (!tab || !isDeepseekUrl(tab.url || tab.pendingUrl)) {
              throw new Error('The assigned DeepSeek tab changed while waking. No message was sent.');
            }
          }
        }
        if (!Number.isInteger(tab?.id)) {
          throw new Error('NeuraFlok could not find the DeepSeek chat tab for this request. Open DeepSeek in the integrated browser and retry. No message was sent.');
        }
        if (offer.fresh !== true && await restoreDeepseekTab(tab.id) === false) {
          throw new Error('Could not refresh the DeepSeek chat controls. Reload the provider page and retry.');
        }
        await activeTabs?.set(`provider:${offer.id}`, [tab], candidate =>
          candidate.id === tab.id && isDeepseekUrl(candidate.url));
        const status = await tabReply(tab.id, { type: 'neuraflok-deepseek-status' });
        if (!status || typeof status.signedIn !== 'boolean') await restoreDeepseekTab(tab.id);
        let snapshot = await tabReply(tab.id, { type: 'neuraflok-deepseek-snapshot' }, undefined, DEEPSEEK_READ_MS);
        // `tabs.onUpdated(status: complete)` can fire before DeepSeek finishes
        // restoring its signed-in workspace. Do not turn that short hydration
        // window into a false sign-in error; wait for the page adapter to see
        // the chat controls before deciding that this browser is disconnected.
        if (!snapshot || snapshot.signedIn !== true) {
          const readyUntil = Date.now() + DEEPSEEK_READY_MS;
          while (Date.now() < readyUntil) {
            await new Promise(resolve => setTimeout(resolve, DEEPSEEK_READY_POLL_MS));
            snapshot = await tabReply(tab.id, { type: 'neuraflok-deepseek-snapshot' }, undefined,
              Math.min(DEEPSEEK_READ_MS, 2_000)).catch(() => null);
            if (snapshot?.signedIn === true) break;
          }
        }
        if (!snapshot || snapshot.signedIn !== true) {
          if (status?.signedIn === true) {
            throw new Error('DeepSeek is still signed in, but NeuraFlok could not detect its chat controls. Refresh the DeepSeek page and retry. No message was sent.');
          }
          const diagnostics = snapshot?.diagnostics;
          const safeSummary = diagnostics && typeof diagnostics === 'object'
            ? JSON.stringify(diagnostics).slice(0, 350)
            : `status=${String(status?.signedIn ?? 'missing')}; snapshot=${String(snapshot?.signedIn ?? 'missing')}`;
          throw new Error(`NeuraFlok could not verify the active DeepSeek session through its browser connection. It did not change the provider sign-in state and no message was sent. Refresh the DeepSeek page and retry; if DeepSeek itself shows a sign-in form, sign in there. [diagnostic ${safeSummary}]`);
        }
        let freshPagePrepared = false;
        if (offer.fresh === true) {
          try {
            snapshot = await openFreshDeepseekChat({
              chrome, tabReply, conversationPageUrl, tabId: tab.id,
              previousSnapshot: { ...snapshot, url: tab.url || tab.pendingUrl },
              readTimeoutMs: DEEPSEEK_READ_MS, readyTimeoutMs: 8_000, pollMs: DEEPSEEK_READY_POLL_MS
            });
            freshPagePrepared = true;
          } catch {
            // The content agent can use DeepSeek's exact, visible New chat
            // control when the browser shortcut is unavailable. It verifies
            // the route change before it sends any setup text.
          }
        }
        if (offer.fresh !== true && snapshot.conversationId && snapshot.conversationId !== offer.conversationId) {
          const savedPageMatches = savedUrl && conversationPageUrl(tab.url || tab.pendingUrl) === savedUrl && snapshot.hasConversation === true;
          if (!savedPageMatches) throw new Error('DEEPSEEK_CONTEXT_UNAVAILABLE: The page no longer belongs to this DeepSeek session. No message was sent.');
        }
        if (offer.fresh !== true) {
          const currentUrl = conversationPageUrl(tab.url || tab.pendingUrl);
          const savedPageMatches = Boolean(savedUrl && currentUrl === savedUrl);
          const legacyMappedPage = !snapshot.conversationId && binding?.tab === tab.id && Boolean(currentUrl);
          const pageIsBoundToChat = snapshot.conversationId === offer.conversationId || savedPageMatches || legacyMappedPage;
          const isPreparedEmptyAttachmentPage = offer.preparedAttachmentPage === true &&
            snapshot.hasConversation !== true && snapshot.conversationId === offer.conversationId && binding?.tab === tab.id;
          if ((!snapshot.hasConversation && !isPreparedEmptyAttachmentPage) || !pageIsBoundToChat) {
            throw new Error('DEEPSEEK_CONTEXT_UNAVAILABLE: The saved DeepSeek page no longer contains this chat history. No message was sent.');
          }
          await writeProviderTab(offer.conversationId, tab.id, 'deepseek', currentUrl);
        }
        const claim = {
          id: offer.id, provider: 'deepseek', conversationId: offer.conversationId, tab: tab.id,
          before: typeof snapshot.before === 'string' ? snapshot.before : '',
          beforeThink: typeof snapshot.beforeThink === 'string' ? snapshot.beforeThink : '',
          beforeIdentity: typeof snapshot.beforeIdentity === 'string' ? snapshot.beforeIdentity : '',
          uploadOnly: offer.uploadOnly === true,
          removeOnly: offer.removeOnly === true,
          preparedAttachmentPage: offer.preparedAttachmentPage === true,
          at: Date.now(), phase: 'claimed'
        };
        if (!await writeDeepseekSent(claim)) throw new Error('Could not record the send claim. No message was sent; retry after restarting the extension.');
        const attachments = offer.removeOnly === true ? [] : await loadDeepseekAttachments(offer, call);
        let pageAttachments = attachments;
        let preStagedAttachments = false;
        if (attachments.some(file => String(file?.mimeType || '').startsWith('image/'))) {
          const metadata = attachments.map(({ chunks: _chunks, ...file }) => file);
          const attachmentState = await tabReply(tab.id, {
            type: 'neuraflok-deepseek-attachment-state',
            conversationId: offer.conversationId,
            attachments: metadata
          }, undefined, DEEPSEEK_READ_MS).catch(() => null);
          let presentIds = Array.isArray(attachmentState?.presentIds)
            ? attachmentState.presentIds
            : null;
          // A just-opened DeepSeek chat can accept the following completion
          // message before its first attachment-state reply arrives. Retry the
          // read-only handshake once; if it still has no response, stage the
          // image in MAIN and let the completion handler verify the actual UI.
          if (presentIds === null) {
            const retry = await tabReply(tab.id, {
              type: 'neuraflok-deepseek-attachment-state',
              conversationId: offer.conversationId,
              attachments: metadata
            }, undefined, Math.min(DEEPSEEK_READ_MS, 2_000)).catch(() => null);
            if (Array.isArray(retry?.presentIds)) presentIds = retry.presentIds;
          }
          const existing = new Set(presentIds || []);
          const missing = attachments.filter(file => !existing.has(file.id));
          if (!missing.length || await stageDeepseekAttachmentsInMainWorld(chrome, tab.id, missing)) {
            // Files created in the provider page's main world are accepted
            // by DeepSeek's controlled input. The isolated content script
            // only needs metadata to verify the chip and upload receipt.
            pageAttachments = metadata;
            preStagedAttachments = true;
          }
        }
        const reply = await tabReply(tab.id, {
          type: 'neuraflok-deepseek-complete',
          id: offer.id,
          conversationId: offer.conversationId,
          text: typeof offer.text === 'string' ? offer.text : '',
          uploadOnly: offer.uploadOnly === true,
          removeOnly: offer.removeOnly === true,
          preparedAttachmentPage: offer.preparedAttachmentPage === true,
          attachments: offer.removeOnly === true ? (offer.attachments || []) : pageAttachments,
          ...(preStagedAttachments ? { preStagedAttachments: true } : {}),
          stop: offer.stop === true,
          fresh: offer.fresh === true,
          ...(freshPagePrepared ? { freshPagePrepared: true } : {}),
          ...(rebindSavedConversation ? { rebindSavedConversation: true } : {}),
          before: claim.before,
          beforeThink: claim.beforeThink,
          beforeIdentity: claim.beforeIdentity
        }, undefined, DEEPSEEK_SEND_MS);
        if (offer.stop) {
          await postDeepseekPage(offer, { stopped: true });
          return;
        }
        if (reply && typeof reply.error === 'string' && reply.error.trim()) {
          await fail(reply.error);
          return;
        }
        if (offer.uploadOnly === true) {
          if (reply?.uploaded !== true) {
            await fail('DeepSeek did not confirm that the selected files finished uploading.');
            return;
          }
          await postDeepseekPage(offer, { attachmentUploaded: true }, tab.id);
          return;
        }
        if (offer.removeOnly === true) {
          if (reply?.removed !== true) {
            await fail('DeepSeek did not confirm that the selected files were removed.');
            return;
          }
          await postDeepseekPage(offer, { attachmentRemoved: true }, tab.id);
          return;
        }
        const immediate = reply && typeof reply.text === 'string' ? reply.text : '';
        const before = typeof reply?.before === 'string' ? reply.before : claim.before;
        const beforeThink = typeof reply?.beforeThink === 'string' ? reply.beforeThink : claim.beforeThink;
        const beforeIdentity = typeof reply?.beforeIdentity === 'string' ? reply.beforeIdentity : claim.beforeIdentity;
        const answerIdentity = typeof reply?.answerIdentity === 'string' ? reply.answerIdentity : '';
        const normalized = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const sameAsPrior = normalized(immediate) === normalized(before) || normalized(immediate) === normalized(offer.text);
        const beforePage = /^node:([^:]+):/.exec(beforeIdentity)?.[1] || '';
        const answerPage = /^node:([^:]+):/.exec(answerIdentity)?.[1] || '';
        const newAssistantMessage = Boolean(beforeIdentity && answerIdentity && beforeIdentity !== answerIdentity &&
          (!(beforePage || answerPage) || (beforePage && answerPage && beforePage === answerPage)));
        const staleAnswer = sameAsPrior && !newAssistantMessage;
        const ackRepeat = isDeepseekAck(immediate) && isDeepseekAck(before) && !newAssistantMessage;
        const staleAck = isDeepseekAck(immediate) && String(before || '').trim() !== '' && !newAssistantMessage;
        const planningOnly = looksLikeDeepseekThink(immediate) && !hasDeepseekToolCall(immediate);
        if (immediate && reply.pending !== true && reply.continueAvailable !== true && !staleAnswer && !ackRepeat && !staleAck && !planningOnly) {
          await postDeepseekPage(offer, { text: immediate }, tab.id);
          return;
        }
        if (!reply) {
          await fail('DeepSeek page did not answer.');
          return;
        }
        if (immediate && reply.generating !== true && reply.continueAvailable !== true && !staleAnswer && !ackRepeat && !staleAck && reply.pending !== true && !planningOnly) {
          await postDeepseekPage(offer, { text: immediate }, tab.id);
          return;
        }
        await watchDeepseekReply(tab.id, offer, before, beforeThink, immediate, beforeIdentity);
      } catch (error) {
        await fail(error && error.message ? error.message : error);
      }
    })().finally(async () => {
      await activeTabs?.set(`provider:${offer.id}`, []).catch(() => undefined);
      deepseekPageFlight = null;
    });
  }

  return { inspect: inspectDeepseekPage, busy: () => deepseekPageFlight !== null, reportAttachmentUploaded };
}
