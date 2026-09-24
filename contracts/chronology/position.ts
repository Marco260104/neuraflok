import type { Chronological } from './types.js';

/** Where an entry sits in the log: its first appearance if it has revisions, else its seq. */
export function positionOf(entry: Chronological): number {
  return typeof entry.origin === 'number' && Number.isFinite(entry.origin) ? entry.origin : entry.seq;
}
