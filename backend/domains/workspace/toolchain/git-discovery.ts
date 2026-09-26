// Finds Git metadata in the requested directory or one of its parents.
import path from 'node:path';
import { existsSync } from 'node:fs';

export function isGitRepository(dir: string): boolean {
  let current = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(current, '.git'))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
