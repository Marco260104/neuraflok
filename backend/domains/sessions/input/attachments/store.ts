import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { sessionsRoot } from '../../history/store.js';
import type { InputAttachment } from '../../../../../contracts/input.js';
import { MAX_ATTACHMENT_BYTES, attachmentSchema } from './contracts.js';

let operations: Promise<unknown> = Promise.resolve();

export function runAttachmentOperation<T>(operation: () => Promise<T>): Promise<T> {
  const next = operations.then(operation);
  operations = next.catch(() => undefined);
  return next;
}

export function attachmentDirectory(): string {
  const root = sessionsRoot();
  if (!root) throw new Error('Session storage is not ready');
  return path.join(path.dirname(root), 'input-attachments');
}

export function attachmentPath(id: string): string {
  return path.join(attachmentDirectory(), z.string().uuid().parse(id));
}

export async function readAttachmentImage(attachment: InputAttachment): Promise<Buffer> {
  if (attachment.size > 12 * 1024 * 1024) throw new Error('Images for injection must be 12 MB or smaller');
  const handle = await fs.open(attachmentPath(attachment.id), 'r');
  try {
    if ((await handle.stat()).size !== attachment.size) throw new Error('Attachment changed; attach it again');
    const bytes = Buffer.alloc(attachment.size);
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

export async function validateStoredAttachments(attachments: InputAttachment[]): Promise<void> {
  if (attachments.length > 20 || attachments.reduce((sum, file) => sum + file.size, 0) > MAX_ATTACHMENT_BYTES) {
    throw new Error('Attach up to 20 files and 512 MB per message');
  }

  for (const attachment of attachments) {
    const file = attachmentPath(attachment.id);
    const stored = attachmentSchema.parse(JSON.parse(await fs.readFile(file + '.json', 'utf8')));
    const submitted = attachmentSchema.parse(attachment);
    if (JSON.stringify(stored) !== JSON.stringify(submitted) || (await fs.stat(file)).size !== attachment.size) {
      throw new Error('Attachment is missing or changed; attach it again');
    }
    const now = new Date();
    await fs.utimes(file, now, now);
  }
}

