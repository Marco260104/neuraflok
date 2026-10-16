import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { InputAttachment } from '../../../../../contracts/input.js';
import { injectableAttachments, MAX_INPUT_IMAGES } from '../../../../../contracts/input.js';
import { normalizeInputImage } from '../input-images.js';
import { ATTACHMENT_CHUNK_BYTES } from './contracts.js';
import { attachmentPath, readAttachmentImage, runAttachmentOperation, validateStoredAttachments } from './store.js';

const PROVIDER_TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cfg', '.cpp', '.cs', '.css', '.csv', '.go', '.h', '.hpp', '.html', '.ini', '.ipynb',
  '.java', '.js', '.json', '.jsx', '.log', '.md', '.mjs', '.py', '.r', '.rb', '.rs', '.sh', '.sql',
  '.svg', '.swift', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml', '.zsh'
]);

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
  return attachment.mimeType.startsWith('text/') || [
    'application/json', 'application/javascript', 'application/xml', 'application/x-yaml', 'application/toml'
  ].includes(attachment.mimeType) || PROVIDER_TEXT_EXTENSIONS.has(path.extname(attachment.name).toLowerCase());
}

export function readProviderTextAttachment(attachment: InputAttachment, maxBytes = 1_000_000): Promise<string> {
  return runAttachmentOperation(async () => {
    if (!isProviderTextAttachment(attachment)) throw new Error(`“${attachment.name}” is not a supported text or code attachment.`);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_000_000) throw new Error('Invalid text attachment limit');
    if (attachment.size > maxBytes) {
      throw new Error(`“${attachment.name}” is too large to include inline (limit 1 MB). Add its folder as a project instead.`);
    }
    await validateStoredAttachments([attachment]);
    const bytes = await fs.readFile(attachmentPath(attachment.id));
    if (bytes.length !== attachment.size || bytes.length > maxBytes) {
      throw new Error(`“${attachment.name}” changed while it was being read; attach it again.`);
    }
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
