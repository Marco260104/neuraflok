export async function loadDeepseekAttachments(offer, call) {
  const rows = Array.isArray(offer.attachments) ? offer.attachments : [];
  const files = [];
  for (const attachment of rows) {
    if (!attachment || typeof attachment.id !== 'string' || typeof attachment.name !== 'string' ||
        typeof attachment.mimeType !== 'string' || !Number.isSafeInteger(attachment.size) || attachment.size < 0) {
      throw new Error('The selected file could not be prepared for DeepSeek.');
    }
    const chunks = [];
    for (let offset = 0; offset < attachment.size; offset += 256 * 1024) {
      const reply = await call('/provider/page/attachment', {
        method: 'POST',
        body: JSON.stringify({
          id: offer.id, provider: 'deepseek', conversationId: offer.conversationId,
          attachmentId: attachment.id, offset
        })
      });
      if (!reply.ok || typeof reply.data?.chunk !== 'string') {
        throw new Error(`DeepSeek could not retrieve “${attachment.name}”. Keep the chat open and retry.`);
      }
      chunks.push(reply.data.chunk);
    }
    files.push({ ...attachment, chunks });
  }
  return files;
}
