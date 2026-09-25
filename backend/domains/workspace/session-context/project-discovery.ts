// Learns project roots from successfully resolved paths within approved directories.
import path from 'node:path';
import { rawPromises as fs } from '../rawfs.js';
import type { Root } from '../../../../contracts/types.js';
import { isSkillPath, isSkillVirtualPath } from '../../skills/access/path-policy.js';
import { isContained } from '../../../infrastructure/settings/sandbox.js';
import { setCurrentWorkspace, workspaceKey } from './registry.js';

// These markers identify a repository root while discovery stays inside its approved folder.
const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml'];

async function isDirectory(real: string): Promise<boolean> {
  try {
    return (await fs.stat(real)).isDirectory();
  } catch {
    return false;
  }
}

async function hasMarker(real: string): Promise<boolean> {
  for (const marker of PROJECT_MARKERS) {
    try {
      await fs.lstat(path.join(real, marker));
      return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}

/** The project a resolved path belongs to, as a folder to remember. Walks up from the path towards its approved root looking for a project marker, and stops at the root: the search never leaves the folder the user approved, so a stray `.git` in a parent directory outside the sandbox cannot pull the workspace out of it. */
export async function projectFolderOf(
  resolved: { real: string; virtual: string },
  rootReal: string
): Promise<{ real: string; virtual: string }> {
  const startReal = (await isDirectory(resolved.real)) ? resolved.real : path.dirname(resolved.real);
  const depth = path.posix.normalize(resolved.virtual).split('/').filter(Boolean).length;
  const startVirtual = (await isDirectory(resolved.real))
    ? path.posix.normalize(resolved.virtual)
    : path.posix.dirname(path.posix.normalize(resolved.virtual));

  let currentReal = startReal;
  let currentVirtual = startVirtual;
  // Bounded by the virtual depth, so a malformed pair can never spin.
  for (let step = 0; step <= depth; step++) {
    // Never above the approved root: containment is the boundary, here as everywhere.
    if (!isContained(rootReal, currentReal)) break;
    if (await hasMarker(currentReal)) return { real: currentReal, virtual: currentVirtual };
    const parentReal = path.dirname(currentReal);
    if (parentReal === currentReal) break;
    currentReal = parentReal;
    currentVirtual = path.posix.dirname(currentVirtual);
  }
  return { real: startReal, virtual: startVirtual };
}

/** Records where a successful call was working, so the next one can be brief. Deliberately learned from *absolute* paths only. A workspace inferred from a relative path would be circular — it would let one loose resolution define where the next loose resolution points — and a workspace can then only ever name somewhere the chat has already proven it can reach. */
export async function learnWorkspace(resolved: { real: string; virtual: string; root: Root }): Promise<void> {
  if (isSkillPath(resolved.real) || isSkillVirtualPath(resolved.virtual) || resolved.root.name.toLowerCase() === 'skills') return;
  if (!workspaceKey()) return;
  let rootReal: string;
  try {
    rootReal = await fs.realpath(resolved.root.path);
  } catch {
    return;
  }
  const folder = await projectFolderOf(resolved, rootReal);
  setCurrentWorkspace(folder);
}

