import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { InputAttachment } from '../../../../../contracts/input.js';
import { isDeepseekDirectUpload, isProviderOfficeDocument, isSupportedProviderImage, isSupportedProviderText, MAX_ATTACHMENT_SIZE_BYTES } from '../../../../../contracts/attachments.js';
import { injectableAttachments, MAX_INPUT_IMAGES } from '../../../../../contracts/input.js';
import { normalizeInputImage } from '../input-images.js';
import { ATTACHMENT_CHUNK_BYTES } from './contracts.js';
import { extractProviderPdfText, MAX_PROVIDER_PDF_BYTES } from './pdf-text.js';
import { attachmentPath, readAttachmentImage, runAttachmentOperation, validateStoredAttachments } from './store.js';

export function validateInputAttachments(attachments: InputAttachment[]): Promise<void> {
  return runAttachmentOperation(() => validateStoredAttachments(attachments));
}

export function normalizeInputAttachments(attachments: InputAttachment[]) {
  return runAttachmentOperation(async () => {
    if (!injectableAttachments(attachments)) throw new Error(`Inject up to ${MAX_INPUT_IMAGES} PNG, JPEG, WebP or GIF images`);
    await validateStoredAttachments(attachments);
    const images = [];
    for (const attachment of attachments) {
      images.push(await normalizeInputImage(await readAttachmentImage(attachment), attachment.name));
    }
    return images;
  });
}

export function isProviderTextAttachment(attachment: InputAttachment): boolean {
  return attachment.mimeType === 'application/pdf' || path.extname(attachment.name).toLowerCase() === '.pdf' ||
    isSupportedProviderText(attachment.name, attachment.mimeType);
}

async function readStagedBytes(attachment: InputAttachment): Promise<Buffer> {
  await validateStoredAttachments([attachment]);
  const handle = await fs.open(attachmentPath(attachment.id), 'r');
  try {
    const stat = await handle.stat();
    if (stat.size !== attachment.size || stat.size > MAX_ATTACHMENT_SIZE_BYTES) {
      throw new Error(`“${attachment.name}” changed while it was being read; attach it again.`);
    }
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('Attachment read incomplete');
      offset += bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export function readProviderTextAttachment(attachment: InputAttachment, maxBytes = 1_000_000): Promise<string> {
  return runAttachmentOperation(async () => {
    if (!isProviderTextAttachment(attachment)) throw new Error(`“${attachment.name}” is not a supported text or code attachment.`);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_000_000) throw new Error('Invalid text attachment limit');
    const isPdf = attachment.mimeType === 'application/pdf' || path.extname(attachment.name).toLowerCase() === '.pdf';
    if (isPdf && attachment.size > MAX_PROVIDER_PDF_BYTES) throw new Error('Attach a valid PDF of 20 MB or smaller.');
    if (!isPdf && attachment.size > maxBytes) {
      throw new Error(`“${attachment.name}” is too large to include inline (limit 1 MB). Add its folder as a project instead.`);
    }
    await validateStoredAttachments([attachment]);
    const bytes = await fs.readFile(attachmentPath(attachment.id));
    if (bytes.length !== attachment.size || (!isPdf && bytes.length > maxBytes)) {
      throw new Error(`“${attachment.name}” changed while it was being read; attach it again.`);
    }
    if (isPdf) return extractProviderPdfText(bytes, maxBytes);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`“${attachment.name}” is not valid UTF-8 text.`);
    }
    if (text.includes('\0')) throw new Error(`“${attachment.name}” is binary and cannot be included as text.`);
    return text;
  });
}

/** Return the original, validated PDF bytes only for the pending DeepSeek upload path. */
export function readProviderPdfAttachment(attachment: InputAttachment): Promise<Buffer> {
  return runAttachmentOperation(async () => {
    if (attachment.mimeType !== 'application/pdf' && path.extname(attachment.name).toLowerCase() !== '.pdf') {
      throw new Error(`“${attachment.name}” is not a PDF attachment.`);
    }
    if (attachment.size > MAX_ATTACHMENT_SIZE_BYTES) throw new Error('Attach a PDF of 100 MB or smaller to DeepSeek Web.');
    const bytes = await readStagedBytes(attachment);
    if (bytes.length !== attachment.size || bytes.length > MAX_ATTACHMENT_SIZE_BYTES) {
      throw new Error(`“${attachment.name}” changed while it was being read; attach it again.`);
    }
    if (bytes.length < 5 || bytes.toString('ascii', 0, 5) !== '%PDF-') throw new Error(`“${attachment.name}” is not a valid PDF.`);
    return bytes;
  });
}

/** Read an original image for a provider web upload, after validating the staged bytes. */
export function readProviderImageAttachment(attachment: InputAttachment): Promise<Buffer> {
  return runAttachmentOperation(async () => {
    if (!isSupportedProviderImage(attachment.mimeType)) {
      throw new Error(`“${attachment.name}” is not a supported image attachment.`);
    }
    const bytes = await readStagedBytes(attachment);
    const valid = bytes.length > 0 && (attachment.mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : attachment.mimeType === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : attachment.mimeType === 'image/gif' ? /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))
          : attachment.mimeType === 'image/webp' ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
            : attachment.mimeType === 'image/bmp' ? bytes.toString('ascii', 0, 2) === 'BM'
              : false);
    if (!valid) throw new Error(`“${attachment.name}” is not a valid ${attachment.mimeType.replace('image/', '').toUpperCase()} image.`);
    return bytes;
  });
}

/** Read an Office document or image/PDF in the original format for DeepSeek Web. */
export function readProviderUploadAttachment(attachment: InputAttachment): Promise<Buffer> {
  if (!isDeepseekDirectUpload(attachment.name, attachment.mimeType)) {
    return Promise.reject(new Error(`“${attachment.name}” is not supported for direct upload to DeepSeek Web.`));
  }
  if (isSupportedProviderImage(attachment.mimeType)) return readProviderImageAttachment(attachment);
  if (attachment.mimeType === 'application/pdf' || path.extname(attachment.name).toLowerCase() === '.pdf') {
    return readProviderPdfAttachment(attachment);
  }
  if (!isProviderOfficeDocument(attachment.name)) return Promise.reject(new Error(`“${attachment.name}” cannot be uploaded to DeepSeek Web.`));
  return runAttachmentOperation(() => readStagedBytes(attachment));
}

export async function readInputAttachmentChunk(attachment: InputAttachment, offset: number): Promise<string> {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > attachment.size || offset % ATTACHMENT_CHUNK_BYTES !== 0) {
    throw new Error('Invalid attachment offset');
  }
  const handle = await fs.open(attachmentPath(attachment.id), 'r');
  try {
    if ((await handle.stat()).size !== attachment.size) throw new Error('Attachment changed');
    const buffer = Buffer.alloc(Math.min(ATTACHMENT_CHUNK_BYTES, attachment.size - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (bytesRead !== buffer.length) throw new Error('Attachment read incomplete');
    return buffer.toString('base64');
  } finally {
    await handle.close();
  }
}
