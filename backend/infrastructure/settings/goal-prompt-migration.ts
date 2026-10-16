import { createHash } from 'node:crypto';

export function migrateGoalPrompt(value: string, replacement: string, fingerprints: readonly string[]): string {
  const digest = createHash('sha256').update(value, 'utf8').digest('hex');
  return fingerprints.includes(digest) ? replacement : value;
}
