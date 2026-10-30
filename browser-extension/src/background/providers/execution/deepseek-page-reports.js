export function createDeepseekPageReports({ call, state, rememberConversationPage }) {
  const { readDeepseekSent, writeDeepseekSent } = state;

  async function postDeepseekPage(offer, body, tabId) {
    if (!offer || typeof offer.id !== 'string' || typeof offer.conversationId !== 'string') return false;
    if ((typeof body.text === 'string' && body.text.trim()) || body.attachmentUploaded === true || body.attachmentRemoved === true) {
      await rememberConversationPage(offer, tabId);
    }
    const reply = await call('/provider/page', {
      method: 'POST',
      body: JSON.stringify({ ...body, id: offer.id, provider: 'deepseek', conversationId: offer.conversationId })
    });
    if (reply.ok && reply.data?.ok === true) {
      const sent = await readDeepseekSent();
      if (sent?.id === offer.id) await writeDeepseekSent(null);
      return true;
    }
    return false;
  }

  async function reportAttachmentUploaded(message, sender) {
    const claim = await readDeepseekSent();
    if (!claim || claim.id !== message?.id || claim.conversationId !== message?.conversationId ||
        claim.tab !== sender?.tab?.id || claim.phase !== 'claimed') return { ok: false };
    const reply = await call('/provider/page/progress', {
      method: 'POST',
      body: JSON.stringify({
        id: claim.id, provider: 'deepseek', conversationId: claim.conversationId,
        attachmentsUploaded: true, generating: false
      })
    });
    return { ok: reply.ok && reply.data?.ok === true };
  }

  return { postDeepseekPage, reportAttachmentUploaded };
}
