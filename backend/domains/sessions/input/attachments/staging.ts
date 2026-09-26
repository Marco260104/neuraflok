import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { InputAttachment } from '../../../../../contracts/input.js';
import { MAX_ATTACHMENT_BYTES, ATTACHMENT_CHUNK_BYTES, attachmentSchema, type AttachmentSource } from './contracts.js';
import { attachmentDirectory, attachmentPath, readAttachmentImage, runAttachmentOperation } from './store.js';

const MIME_TYPES: Record<string, string> = {
  '.md': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg'
};

export function stageInputAttachment(source: AttachmentSource, retained: Set<string>): Promise<InputAttachment> {
  return stageInputAttachments([source], retained).then(attachments => attachments[0]!);
}

export function stageInputAttachments(sources: AttachmentSource[], retained: Set<string>): Promise<InputAttachment[]> {
  return runAttachmentOperation(() => stageBatch(sources, retained));
}

async function stageBatch(sources: AttachmentSource[], retained: Set<string>): Promise<InputAttachment[]> {
  const directory = attachmentDirectory();
  await fs.mkdir(directory, { recursive: true });
  let usedBytes = 0;

  for (const name of await fs.readdir(directory)) {
    if (!/^[a-f0-9-]{36}$/.test(name)) continue;
    const file = attachmentPath(name);
    const stat = await fs.stat(file);
    if (!retained.has(name) && Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) {
      await fs.unlink(file);
      await fs.unlink(file + '.json').catch(() => undefined);
      continue;
    }
    usedBytes += stat.size;
  }

  const staged: InputAttachment[] = [];
  for (const source of sources) {
    const attachment = await stageOne(source, usedBytes);
    usedBytes += attachment.size;
    staged.push(attachment);
  }
  return staged;
}

async function stageOne(source: AttachmentSource, usedBytes: number): Promise<InputAttachment> {
  const sourceStat = typeof source === 'string' ? await fs.stat(source) : null;
  if (sourceStat && !sourceStat.isFile()) throw new Error('Attach files individually; folders cannot be uploaded');
  let size: number;
  if (typeof source === 'string') size = sourceStat!.size;
  else if ('text' in source) size = Buffer.byteLength(source.text);
  else size = source.bytes.byteLength;
  if (size > MAX_ATTACHMENT_BYTES) throw new Error('Each attachment must be 512 MB or smaller');
  if (usedBytes + size > 2 * 1024 * 1024 * 1024) {
    throw new Error('Attachment storage is full; finish or remove pending messages first');
  }

  const name = typeof source === 'string'
    ? path.basename(source)
    : 'text' in source ? 'Attached text.txt' : path.basename(source.name);
  const attachment = attachmentSchema.parse({
    id: randomUUID(),
    name,
    size,
    mimeType: MIME_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream'
  });
  const destination = attachmentPath(attachment.id);

  try {
    if (typeof source === 'string') await copySnapshot(source, destination, sourceStat!, size);
    else await fs.writeFile(destination, 'text' in source ? source.text : source.bytes, { flag: 'wx' });
    await createPreview(attachment);
    await fs.writeFile(destination + '.json', JSON.stringify(attachment), { flag: 'wx' });
    return attachment;
  } catch (error) {
    await fs.unlink(destination).catch(() => undefined);
    throw error;
  }
}

async function copySnapshot(source: string, destination: string, original: Awaited<ReturnType<typeof fs.stat>>, size: number): Promise<void> {
  const input = await fs.open(source, 'r');
  try {
    const output = await fs.open(destination, 'wx');
    try {
      const buffer = Buffer.alloc(ATTACHMENT_CHUNK_BYTES);
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
        if (!bytesRead) throw new Error('The attachment changed while being read; attach it again');
        let written = 0;
        while (written < bytesRead) {
          written += (await output.write(buffer, written, bytesRead - written, offset + written)).bytesWritten;
        }
        offset += bytesRead;
      }
    } finally {
      await output.close();
    }
    const current = await input.stat();
    if (current.size !== size || current.mtimeMs !== original.mtimeMs) {
      throw new Error('The attachment changed while being read; attach it again');
    }
  } finally {
    await input.close();
  }
}

async function createPreview(attachment: InputAttachment): Promise<void> {
  if (!attachment.mimeType.startsWith('image/') || attachment.size > 12 * 1024 * 1024) return;
  try {
    const thumbnail = await sharp(await readAttachmentImage(attachment), {
      limitInputPixels: 30_000_000,
      animated: false
    }).rotate().resize({ width: 160, height: 160, fit: 'inside', withoutEnlargement: true }).webp({ quality: 60 }).toBuffer();
    if (thumbnail.length <= 24000) attachment.preview = `data:image/webp;base64,${thumbnail.toString('base64')}`;
  } catch {
    return;
  }
}
