import sharp from 'sharp';

import { getMetadata, readFile } from './filesystem.js';
import { formatBytes, imageMime, MAX_IMAGE_BYTES, validateImageStructure, type SupportedImageMime } from '../fsops.js';

export const IMAGE_INSPECTION_DESCRIPTION = 'Inspect a local image file inside an approved folder when visual evidence is needed.';
export const IMAGE_PATH_DESCRIPTION = 'Path to a local image file inside an approved folder.';
export const INVALID_IMAGE_MESSAGE = 'unable to process image: invalid or unsupported image data';

const MAX_IMAGE_RESPONSE_BYTES = 8 * 1024 * 1024;
const IMAGE_RESPONSE_METADATA_BYTES = 64 * 1024;
export const MAX_TOOL_IMAGE_BYTES = Math.min(
  MAX_IMAGE_BYTES,
  Math.floor(((MAX_IMAGE_RESPONSE_BYTES - IMAGE_RESPONSE_METADATA_BYTES) * 3) / 4)
);
export const MAX_DECODED_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_DECODED_IMAGE_PIXELS = 16 * 1024 * 1024;

export class ImageInspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageInspectionError';
  }
}

export interface InspectedImage {
  mimeType: SupportedImageMime;
  base64: string;
  bytes: number;
}

async function decodesToPixels(data: Buffer): Promise<boolean> {
  try {
    const decoded = await sharp(data, {
      failOn: 'warning',
      limitInputPixels: MAX_DECODED_IMAGE_PIXELS,
      sequentialRead: true
    })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = decoded.info;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return false;
    if (!Number.isInteger(channels) || channels <= 0 || channels > 4) return false;
    if (width * height > MAX_DECODED_IMAGE_PIXELS) return false;
    if (decoded.data.length > MAX_DECODED_IMAGE_BYTES) return false;
    return decoded.data.length === width * height * channels;
  } catch {
    return false;
  }
}

export async function validateImageContent(data: Buffer): Promise<SupportedImageMime> {
  if (data.length > MAX_TOOL_IMAGE_BYTES) throw new ImageInspectionError(INVALID_IMAGE_MESSAGE);
  const mime = imageMime(data);
  if (!mime) throw new ImageInspectionError(INVALID_IMAGE_MESSAGE);
  try {
    validateImageStructure(data, mime);
  } catch {
    throw new ImageInspectionError(INVALID_IMAGE_MESSAGE);
  }
  if (!(await decodesToPixels(data))) throw new ImageInspectionError(INVALID_IMAGE_MESSAGE);
  return mime;
}

export async function inspectLocalImage(
  path: string,
  modelVisiblePath: string = path,
  maxBytes: number = MAX_TOOL_IMAGE_BYTES
): Promise<InspectedImage> {
  let metadata;
  try {
    metadata = await getMetadata(path);
  } catch (error) {
    throw new ImageInspectionError(`unable to locate image at \`${modelVisiblePath}\`: ${safeErrorDetail(error, path, modelVisiblePath)}`);
  }

  if (!metadata.isFile) throw new ImageInspectionError(`image path \`${modelVisiblePath}\` is not a file`);

  const requestedLimit = Number.isFinite(maxBytes) ? Math.floor(maxBytes) : MAX_TOOL_IMAGE_BYTES;
  const effectiveLimit = Math.max(1, Math.min(MAX_TOOL_IMAGE_BYTES, requestedLimit));
  if (metadata.size > effectiveLimit) {
    throw new ImageInspectionError(
      `unable to read image at \`${modelVisiblePath}\`: image is too large to return (${formatBytes(metadata.size)}; limit ${formatBytes(effectiveLimit)})`
    );
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(path, effectiveLimit);
  } catch (error) {
    throw new ImageInspectionError(`unable to read image at \`${modelVisiblePath}\`: ${safeErrorDetail(error, path, modelVisiblePath)}`);
  }

  const mimeType = await validateImageContent(bytes);
  return { mimeType, base64: bytes.toString('base64'), bytes: bytes.length };
}

function safeErrorDetail(error: unknown, realPath: string, visiblePath: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return realPath === visiblePath ? message : message.split(realPath).join(visiblePath);
}
