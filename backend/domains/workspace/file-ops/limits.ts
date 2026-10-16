export const DEFAULT_READ_BYTES = 256 * 1024;
export const MAX_READ_BYTES = 512 * 1024;
export const MAX_WRITE_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_BINARY_WRITE_BYTES = 5 * 1024 * 1024;
export const MAX_BINARY_BASE64_CHARS = 7_000_000;

export class FsOpError extends Error {}

export function assertWritableSize(content: string): void {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_WRITE_BYTES) {
    throw new FsOpError(`Content is too large to write (${formatBytes(bytes)})`);
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
