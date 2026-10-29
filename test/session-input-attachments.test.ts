import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
import { createSession, initSessionStore, readEvents } from '../backend/domains/sessions/history/store.js';
import { stageInputAttachment, stageInputAttachments, validateInputAttachments, readInputAttachmentChunk, readProviderPdfAttachment, readProviderTextAttachment, readProviderUploadAttachment, ATTACHMENT_CHUNK_BYTES, MAX_ATTACHMENT_BYTES } from '../backend/domains/sessions/input/attachments/index.js';
import { isDeepseekDirectUpload, isDeepseekSupportedAttachment, MAX_ATTACHMENT_SIZE_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from '../contracts/attachments.js';
import { extractProviderPdfText } from '../backend/domains/sessions/input/attachments/pdf-text.js';
import type { InputEntry } from '../backend/domains/sessions/input/input.js';
import { recordDeliveredInput, updateDeliveredInputAttachmentStatus } from '../backend/domains/sessions/input/input-history.js';
let directory: string;
function pdfWithText(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(source, 'latin1'));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(source, 'latin1');
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) source += `${String(offset).padStart(10, '0')} 00000 n \n`;
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source, 'latin1');
}
beforeEach(async () => { directory = await makeTempDir('neuraflok-attachments-'); initSessionStore(directory); });
afterEach(async () => { await removeTempDir(directory); });
it('snapshots arbitrary file bytes across chunks without exposing the source path', async () => {
  const original = Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 19, 173);
  const source = path.join(directory, 'notes.md'); await fs.writeFile(source, original);
  const file = await stageInputAttachment(source, new Set());
  await fs.writeFile(source, 'later user edit');
  expect(file).toMatchObject({ name: 'notes.md', size: original.length, mimeType: 'text/markdown' });
  expect(JSON.stringify(file)).not.toContain(directory);
  await validateInputAttachments([file]);
  const chunks = await Promise.all([0, ATTACHMENT_CHUNK_BYTES].map(offset => readInputAttachmentChunk(file, offset)));
  expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk, 'base64')))).toEqual(original);
  await expect(readInputAttachmentChunk(file, 1)).rejects.toThrow('offset');
  await expect(validateInputAttachments([{ ...file, name: 'spoof.pdf' }])).rejects.toThrow('changed');
});
it('keeps dropped Unicode text exact and permits empty native files', async () => {
  const text = 'Text\n中文 — ä 🎈';
  const file = await stageInputAttachment({ text }, new Set());
  expect(Buffer.from(await readInputAttachmentChunk(file, 0), 'base64').toString()).toBe(text);
  const empty = await stageInputAttachment({ text: '' }, new Set());
  expect(empty.size).toBe(0); await validateInputAttachments([empty]);
});
it('extracts selectable PDF text and preserves the original when a PDF is image-only', async () => {
  const readableBytes = pdfWithText('Selectable PDF text');
  const readablePath = path.join(directory, 'guide.pdf');
  await fs.writeFile(readablePath, readableBytes);
  const readable = await stageInputAttachment(readablePath, new Set());
  expect(await readProviderTextAttachment(readable)).toContain('Selectable PDF text');
  expect(await readProviderPdfAttachment(readable)).toEqual(readableBytes);

  const scanBytes = pdfWithText('');
  const scanned = await stageInputAttachment({ name: 'scan-only.pdf', bytes: scanBytes }, new Set());
  await expect(extractProviderPdfText(scanBytes)).rejects.toThrow('no selectable text');
  // DeepSeek Web receives this exact original, so its page images remain available for visual reading.
  expect(await readProviderPdfAttachment(scanned)).toEqual(scanBytes);
});
it('keeps the authored PDF bubble in uploading state until the provider receipt updates it', async () => {
  const session = await createSession({ conversationId: `ds-${randomUUID()}` });
  const attachment = await stageInputAttachment({ name: 'synthetic-scan.pdf', bytes: Buffer.from('%PDF-1.4\nsynthetic scan') }, new Set());
  const now = Date.now();
  const input = {
    id: randomUUID(), sessionId: session.id, deliveredSessionId: session.id,
    state: 'sent', owner: null, text: 'Describe this scanned document.', deliveryText: 'Describe this scanned document.',
    mode: 'auto', dueAt: now, createdAt: now, deliveredAt: now, messageId: `user:${randomUUID()}`,
    conversationId: session.conversationId, model: null, reasoningEffort: null, attachments: [attachment]
  } as InputEntry;

  await recordDeliveredInput(input, undefined, { turnId: 'upload-turn', attachmentUpload: true });
  let message = (await readEvents(session.id, { kinds: ['user_message'] })).find(event =>
    event.kind === 'user_message' && event.inputId === input.id);
  expect(message).toMatchObject({ kind: 'user_message', attachmentUpload: 'uploading', attachments: [attachment] });

  await updateDeliveredInputAttachmentStatus(input, 'ready');
  message = (await readEvents(session.id, { kinds: ['user_message'] })).find(event =>
    event.kind === 'user_message' && event.inputId === input.id);
  expect(message).toMatchObject({ kind: 'user_message', attachmentUpload: 'ready', attachments: [attachment] });
});
it('prunes and measures staging once for a multi-file batch', async () => {
  const read = vi.spyOn(fs, 'readdir');
  try {
    const files = await stageInputAttachments([
      { text: 'first' },
      { text: 'second' },
      { name: 'third.bin', bytes: new Uint8Array([1, 2, 3]) }
    ], new Set());
    expect(files).toHaveLength(3);
    expect(read).toHaveBeenCalledTimes(1);
    await validateInputAttachments(files);
  } finally {
    read.mockRestore();
  }
});
it('rejects folders, traversal IDs, files over 100 MB and messages over 50 files', async () => {
  await expect(stageInputAttachment(directory, new Set())).rejects.toThrow('folders');
  const source = path.join(directory, 'big.bin');
  const handle = await fs.open(source, 'w'); await handle.truncate(MAX_ATTACHMENT_BYTES + 1); await handle.close();
  await expect(stageInputAttachment(source, new Set())).rejects.toThrow('100 MB');
  const file = await stageInputAttachment({ text: 'x' }, new Set());
  await expect(validateInputAttachments([{ ...file, id: '../config' }])).rejects.toThrow();
  await expect(validateInputAttachments(Array(MAX_ATTACHMENTS_PER_MESSAGE + 1).fill(file))).rejects.toThrow('50 supported files');
  expect(MAX_ATTACHMENT_BYTES).toBe(MAX_ATTACHMENT_SIZE_BYTES);
});
it('stages DeepSeek-supported images and office files, and validates original image bytes', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
  const image = await stageInputAttachment({ name: 'pasted-image.png', bytes: png }, new Set());
  expect(image.mimeType).toBe('image/png');
  expect(isDeepseekDirectUpload(image.name, image.mimeType)).toBe(true);
  expect(await readProviderUploadAttachment(image)).toEqual(png);

  const document = await stageInputAttachment({ name: 'report.docx', bytes: Buffer.from('PK\u0003\u0004synthetic') }, new Set());
  expect(document.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  expect(isDeepseekDirectUpload(document.name, document.mimeType)).toBe(true);
  expect(await readProviderUploadAttachment(document)).toEqual(Buffer.from('PK\u0003\u0004synthetic'));
  expect(isDeepseekSupportedAttachment('source.ts', 'text/typescript')).toBe(true);
  expect(isDeepseekSupportedAttachment('movie.mp4', 'video/mp4')).toBe(false);
  const brokenImage = await stageInputAttachment({ name: 'broken-image.png', bytes: Buffer.from('not a PNG') }, new Set());
  await expect(readProviderUploadAttachment(brokenImage)).rejects.toThrow('valid PNG');
});
it('prunes only expired unreferenced staging while durable input members survive', async () => {
  const keep = await stageInputAttachment({ text: 'keep' }, new Set());
  const discard = await stageInputAttachment({ text: 'discard' }, new Set());
  const old = new Date(Date.now() - 48 * 3600000);
  for (const file of [keep, discard]) await fs.utimes(path.join(directory, 'input-attachments', file.id), old, old);
  await stageInputAttachment({ text: 'new' }, new Set([keep.id]));
  await validateInputAttachments([keep]);
  await expect(validateInputAttachments([discard])).rejects.toThrow();
});
it('releases thumbnail source files so expired image originals can be pruned immediately', async () => {
  const bytes = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#437b79' } }).webp().toBuffer();
  const cachedFiles = sharp.cache().files.current;
  const image = await stageInputAttachment({ name: 'reference.webp', bytes }, new Set());
  expect(image.preview).toMatch(/^data:image\/webp;base64,/);
  expect(sharp.cache().files.current).toBe(cachedFiles);
  expect(Buffer.from(await readInputAttachmentChunk(image, 0), 'base64')).toEqual(bytes);
  const original = path.join(directory, 'input-attachments', image.id);
  const old = new Date(Date.now() - 48 * 3600000);
  await fs.utimes(original, old, old);
  await stageInputAttachment({ text: 'next draft' }, new Set());
  await expect(fs.stat(original)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.stat(original + '.json')).rejects.toMatchObject({ code: 'ENOENT' });
});
