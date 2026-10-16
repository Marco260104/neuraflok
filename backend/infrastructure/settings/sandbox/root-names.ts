import path from 'node:path';

import type { Root } from '../../../../contracts/types.js';
import { SandboxError } from './path-policy.js';
export const RESERVED_ROOT_NAMES = new Set(['skills']);


export function suggestApprovedSpelling(roots: readonly Root[], segments: readonly string[]): string | null {
  for (const [index, segment] of segments.entries()) {
    const slug = normaliseRootName(segment);
    const root = roots.find((candidate) => candidate.name === slug);
    if (root) return `/${root.name}${segments.slice(index + 1).map((part) => `/${part}`).join('')}`;
  }
  return null;
}

/** Normalises a user-supplied root name into the slug used in virtual paths. */
export function normaliseRootName(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 32);
  return slug || 'folder';
}

/** Picks a root name derived from a folder that does not collide with existing ones. */
export function uniqueRootName(folderPath: string, existing: readonly Root[]): string {
  const base = normaliseRootName(path.basename(folderPath) || 'folder');
  const taken = new Set([...RESERVED_ROOT_NAMES, ...existing.map((r) => r.name)]);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new SandboxError('Could not find a free root name');
}

/** Validates one path segment. Traversal/control constraints apply everywhere; Windows also rejects drive/ADS syntax, reserved device names and names Win32 silently aliases. */

