import { z } from 'zod';
import type { InputAttachment } from '../../../../../contracts/input.js';
import { MAX_ATTACHMENT_SIZE_BYTES } from '../../../../../contracts/attachments.js';

export const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_SIZE_BYTES;
export const MAX_ATTACHMENTS = 50;
export const ATTACHMENT_CHUNK_BYTES = 512 * 1024;

export const attachmentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(255),
  size: z.number().int().nonnegative().max(MAX_ATTACHMENT_BYTES),
  mimeType: z.string().max(120).regex(/^[\w.+-]+\/[\w.+-]+$/),
  preview: z.string().max(32768).regex(/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/).optional()
});

export type AttachmentSource = string | { text: string } | { name: string; bytes: Uint8Array };
export type { InputAttachment };
