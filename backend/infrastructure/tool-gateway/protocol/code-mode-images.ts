import type { ToolContent } from './kernel.js';
import { validateImageContent, MAX_TOOL_IMAGE_BYTES } from '../../../domains/workspace/execution/image-inspection.js';

type ImageRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ImageRecord {
  return typeof value === 'object' && value !== null;
}

function decodeDataUrl(value: string): { data: string; mime: string } {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  if (!match) throw new Error('IMAGE_INVALID');
  return { mime: match[1]!, data: match[2]! };
}

function imageParts(value: unknown): { data: unknown; mime: unknown } {
  if (typeof value === 'string') return decodeDataUrl(value);
  if (!isRecord(value)) return { data: undefined, mime: undefined };
  if ('image_url' in value) {
    if (typeof value.image_url !== 'string') throw new Error('IMAGE_INVALID');
    return decodeDataUrl(value.image_url);
  }
  if (value.type === 'image') return { data: value.data, mime: value.mimeType };
  return { data: undefined, mime: undefined };
}

export async function validateEmittedImage(value: unknown): Promise<ToolContent> {
  const { data, mime } = imageParts(value);
  if (typeof data !== 'string' || typeof mime !== 'string' ||
      data.length > Math.ceil(MAX_TOOL_IMAGE_BYTES / 3) * 4 || data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('IMAGE_INVALID');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) throw new Error('IMAGE_INVALID');
  const actualMime = await validateImageContent(bytes);
  if (mime !== actualMime && mime !== 'application/octet-stream') throw new Error('IMAGE_INVALID');
  return { type: 'image', data: bytes.toString('base64'), mimeType: actualMime };
}
