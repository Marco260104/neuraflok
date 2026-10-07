import type { PinnedSourceArchive } from './source-inventory.mjs';

export interface ArchivePreparationOptions {
  concurrency?: number;
  fetchSource?: typeof fetch;
  onVerified?: (completed: number, total: number, source: PinnedSourceArchive) => void;
}

export function downloadVerifiedArchive(
  source: PinnedSourceArchive,
  archivesDirectory: string,
  fetchSource?: typeof fetch,
  signal?: AbortSignal
): Promise<Buffer>;

export function prepareVerifiedArchives(
  sources: PinnedSourceArchive[],
  archivesDirectory: string,
  options?: ArchivePreparationOptions
): Promise<number>;
