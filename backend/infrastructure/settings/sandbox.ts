/** Path sandbox. Every filesystem tool goes through here. Model-facing filesystem results use virtual paths like "/project/src/main.ts". This module maps them onto real filesystem paths and also accepts native absolute input copied from command output when it names the same approved tree. Anything outside an approved root is refused. Containment is decided by canonicalising with fs.realpath and then comparing against the canonicalised root, which is what defeats symlinks, NTFS junctions and other reparse points planted inside an approved tree: following them is fine as long as the destination is still inside the root. Enforcement lives here, in code. It is never delegated to prompt text. */

import { rawPromises as fs } from '../../domains/workspace/rawfs.js';
import path from 'node:path';
import type { Root } from '../../../contracts/types.js';
import { IS_WINDOWS, WSL_PATH, SandboxError, checkSegment, splitVirtualPath, nativePathIdentity, isContained, isAbsoluteVirtualPath, isNativeWindowsPath } from './sandbox/path-policy.js';
import { suggestApprovedSpelling } from './sandbox/root-names.js';
import { canonicalRealpath, realpathDeepest, realRoot, toVirtualPath } from './sandbox/canonical-paths.js';

export { SandboxError, splitVirtualPath, nativePathIdentity, isContained, isAbsoluteVirtualPath, isNativeWindowsPath } from './sandbox/path-policy.js';
export { RESERVED_ROOT_NAMES, suggestApprovedSpelling, normaliseRootName, uniqueRootName } from './sandbox/root-names.js';
export { toVirtualPath } from './sandbox/canonical-paths.js';


export interface Resolved {
  /** Canonical absolute path on disk. */
  real: string;
  /** Normalised virtual path, always "/root/..." with forward slashes. */
  virtual: string;
  /** The root this path belongs to. */
  root: Root;
}

export interface ResolveOptions {
  /** Allow the final path to not exist yet (for create/write). Defaults to false. */
  allowMissing?: boolean;
  /** Virtual folder a path without a leading slash is taken to start from — the calling chat's workspace. Absent means relative paths have nowhere to start and are refused. Applied before validation so traversal remains visible to the segment checks. */
  base?: string | null;
}

function isNativePosixPath(roots: readonly Root[], input: unknown): input is string {
  if (IS_WINDOWS || typeof input !== 'string') return false;
  const trimmed = input.trim();
  if (!path.posix.isAbsolute(trimmed)) return false;
  const first = trimmed.split('/').find((part) => part.length > 0)?.toLowerCase();
  return first !== undefined && !roots.some((root) => root.name.toLowerCase() === first);
}

/** Converts a native absolute path inside an approved root to the virtual spelling used by the rest of the sandbox. Native paths outside the approved roots are still refused. Paths here are virtual on purpose: `/root/...` names an approved folder and nothing else can be addressed. But the model spends its time reading command output, stack traces and error messages, all of which print `C:\Users\...`, and pasting one back got a single sentence about a colon — true, unhelpful, and about the wrong thing. It reads as the sandbox rejecting a path it can plainly see is inside an approved folder. Keeping two independent resolution paths would be dangerous, so this does not bypass any sandbox validation. It performs only a lexical approved-root lookup and returns the equivalent virtual path; resolvePath then runs that through the exact same realpath, symlink/junction and allowMissing checks as an originally-virtual path. */
async function normaliseNativePath(roots: readonly Root[], input: string): Promise<string | null> {
  const nativeWindows = isNativeWindowsPath(input);
  const nativePosix = isNativePosixPath(roots, input);
  if (!nativeWindows && !nativePosix) return null;
  const trimmed = input.trim();
  // Preserve the same lexical invariant virtual paths get. `path.resolve()` erases `..` (and `.`) before `splitVirtualPath()` can see it, which meant a native spelling copied from command output could take a different validation path from the equivalent virtual spelling. Strip only the native root prefix, then validate the user-supplied segments before any normalization happens.
  const withoutNativeRoot = nativeWindows
    ? trimmed.replace(/^[A-Za-z]:[\\/]+/, '').replace(/^\\\\[^\\/]+[\\/]+[^\\/]+[\\/]*/, '')
    : trimmed.replace(/^\/+/, '');
  const nativeSegments = nativeWindows ? withoutNativeRoot.split(/[/\\]+/) : withoutNativeRoot.split(/\/+/);
  for (const segment of nativeSegments.filter((part) => part.length > 0)) checkSegment(segment);
  const native = path.resolve(trimmed);
  // A WSL folder (or a mapped drive's canonical UNC root) may be approved. Reject every other UNC spelling lexically, before a remote host can trigger DNS/SMB or credentials.
  if (nativeWindows && native.startsWith('\\\\') && !roots.some(root => isContained(root.path, native))) {
    const names = roots.map((r) => `/${r.name}`).join(', ') || '(none approved)';
    throw new SandboxError(
      `Native path "${trimmed}" is not inside an approved folder. ` +
        `Approved roots: ${names}`
    );
  }
  let canonicalNative: string;
  try {
    const { real, missing } = await realpathDeepest(native);
    canonicalNative = missing.length === 0 ? real : path.join(real, ...missing);
  } catch {
    canonicalNative = native;
  }
  for (const root of roots) {
    let rootReal: string;
    try {
      rootReal = await realRoot(root);
    } catch {
      continue;
    }
    if (isContained(rootReal, canonicalNative)) {
      return toVirtualPath(root, rootReal, canonicalNative);
    }
    // Preserve the useful distinction between a genuinely outside native path and a spelling that started under the approved root but was redirected out by a junction/symlink.
    if (isContained(rootReal, native)) {
      throw new SandboxError('Path escapes its approved folder via a link');
    }
  }
  const names = roots.map((r) => `/${r.name}`).join(', ') || '(none approved)';
  const suggestion = suggestApprovedSpelling(roots, nativeSegments.filter((part) => part.length > 0));
  throw new SandboxError(
    `Native path "${input.trim()}" is not inside an approved folder. ` +
      `Approved roots: ${names}` +
      (suggestion ? ` If you meant the approved folder, its path is ${suggestion}.` : '')
  );
}

/** Maps a virtual path onto a real path inside an approved root. Throws SandboxError for anything that is not clearly inside a root. Callers treat every SandboxError as a refusal and never fall back to the raw input. */
export async function resolvePath(
  roots: readonly Root[],
  virtualPath: string,
  options: ResolveOptions = {}
): Promise<Resolved> {
  const normalisedNative = await normaliseNativePath(roots, virtualPath);
  const suppliedPath = normalisedNative ?? virtualPath;
  // A relative path is shorthand for one absolute path, and is turned into that path here, before anything is validated — so there stays exactly one piece of code deciding what may be reached. `..` is still refused segment by segment below, because nothing normalises a traversal away first: shorthand cannot climb out of the workspace, and certainly not out of the root.
  const requested =
    isAbsoluteVirtualPath(suppliedPath) || !options.base
      ? suppliedPath
      : IS_WINDOWS
        ? `${options.base.replace(/[/\\]+$/, '')}/${String(suppliedPath).replace(/^[/\\]+/, '')}`
        : `${options.base.replace(/\/+$/, '')}/${String(suppliedPath).replace(/^\/+/, '')}`;
  if (typeof requested === 'string' && requested.trim() !== '' && !isAbsoluteVirtualPath(requested)) {
    // Not "Unknown root src": the caller was using shorthand, and being told their first folder is not a root explains nothing about what to do instead.
    const names = roots.map((r) => `/${r.name}`).join(', ') || '(none approved)';
    throw new SandboxError(
      `"${requested.slice(0, 120)}" is relative and this chat has no active folder yet. Use a full path: ${names}`
    );
  }
  const segments = splitVirtualPath(requested);
  const rootName = segments[0]!.toLowerCase();
  const root = roots.find((r) => r.name.toLowerCase() === rootName);
  if (!root) {
    const names = roots.map((r) => `/${r.name}`).join(', ') || '(none approved)';
    const suggestion = suggestApprovedSpelling(roots, segments.slice(1));
    throw new SandboxError(
      `Unknown root "/${segments[0]}". Approved roots: ${names}` +
        (suggestion ? ` If you meant the approved folder, its path is ${suggestion}.` : '')
    );
  }

  const rootReal = await realRoot(root);
  const rest = segments.slice(1);
  const candidate = rest.length === 0 ? rootReal : path.join(rootReal, ...rest);

  // Cheap structural check before touching the disk.
  if (!isContained(rootReal, candidate)) {
    throw new SandboxError('Path escapes its approved folder');
  }

  const { real, missing } = await realpathDeepest(candidate);

  // The canonical existing part must still be inside the root. This is the check that catches a symlink or junction inside the tree pointing somewhere else.
  if (!isContained(rootReal, real)) {
    throw new SandboxError('Path escapes its approved folder via a link');
  }

  if (missing.length > 0 && !options.allowMissing) {
    throw new SandboxError(`Not found: ${toVirtualPath(root, rootReal, candidate)}`);
  }

  const finalReal = missing.length === 0 ? real : path.join(real, ...missing);
  if (!isContained(rootReal, finalReal)) {
    throw new SandboxError('Path escapes its approved folder');
  }

  return {
    real: finalReal,
    virtual: toVirtualPath(root, rootReal, finalReal),
    root
  };
}

/** Converts a real path back into the virtual path the model sees. */
export async function validateNewRoot(folderPath: string, existing: readonly Root[]): Promise<string> {
  if (!path.isAbsolute(folderPath)) {
    throw new SandboxError('Folder path must be absolute');
  }
  // WSL's local redirector is not an arbitrary SMB host. Both supported aliases still have to exist on this Windows installation; no fallback or remote lookup is added.
  const windowsPath = folderPath.replace(/\//g, '\\');
  if (IS_WINDOWS && windowsPath.startsWith('\\\\') && !WSL_PATH.test(windowsPath)) {
    throw new SandboxError('Network (UNC) paths are not supported. Map it to a drive letter first.');
  }
  if (IS_WINDOWS && WSL_PATH.test(windowsPath)) {
    for (const segment of windowsPath.split(/\\+/).slice(1).filter(Boolean)) checkSegment(segment);
  }
  const real = await canonicalRealpath(folderPath);
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) {
    throw new SandboxError('That is not a folder');
  }
  const parsed = path.parse(real);
  const sameRoot = nativePathIdentity(parsed.root) === nativePathIdentity(real);
  if (sameRoot) {
    throw new SandboxError(
      IS_WINDOWS
        ? 'Approving an entire drive is not allowed. Pick a folder inside it.'
        : 'Approving the entire filesystem root is not allowed. Pick a folder inside it.'
    );
  }
  for (const other of existing) {
    let otherReal: string;
    try {
      otherReal = await canonicalRealpath(other.path);
    } catch {
      continue;
    }
    if (isContained(otherReal, real) || isContained(real, otherReal)) {
      throw new SandboxError(`That folder overlaps the existing root "/${other.name}"`);
    }
  }
  return real;
}

/** A virtual path written inside a shell command, which nothing will translate. `exec_command` resolves `cwd` and hands `cmd` to the shell verbatim — it has to, since a command is a program and not a path, and rewriting text inside one would corrupt quoting, regexes and URLs the moment it guessed wrong. But every other field of every other tool takes virtual paths as well as approved native paths, so the model is taught exactly one path dialect and then meets one field that does not speak it. Path-taking fields can normalize a native path, but command text is an opaque program and cannot be rewritten safely. What the model wrote was `/project/example/...`, and PowerShell reads a leading slash as the root of the current drive: the command ran against `C:\project\...`, did not exist, and failed in a way that looks like a missing folder rather than a wrong dialect. So the one field that cannot translate says so instead of running. Only a `/name/…` whose first segment is an approved root is claimed, unless it also spells an approved native POSIX path. This is a command diagnostic, not filesystem authorization. `de/example/doppel` inside a regex or `https://host/example` are left alone because neither starts at a boundary a virtual path can start at. */
export function strayVirtualPath(text: string, roots: readonly Root[]): string | null {
  if (typeof text !== 'string' || roots.length === 0) return null;
  const names = new Set(roots.map((root) => root.name.toLowerCase()));
  // A candidate must start the string or follow whitespace or an opening quote/bracket: anything else in front of it means it is part of a longer token, not a path.
  const candidate = /(^|[\s'"`(,=[{])(\/[A-Za-z0-9._-]+(?:\/[^\s'"`;|)\]}]*)?)/g;
  for (let match = candidate.exec(text); match; match = candidate.exec(text)) {
    const found = match[2]!;
    const first = found.slice(1).split('/')[0]!.toLowerCase();
    if (!names.has(first)) continue;
    // Root paths carry the native dialect. A POSIX /Users root may have the alias "users"; that must not make its real spelling virtual-only. Keep exact case and a segment boundary, and never reinterpret a Windows drive-rooted path.
    const native = roots.some(root => {
      if (!path.posix.isAbsolute(root.path)) return false;
      const prefix = root.path.replace(/\/+$/, '');
      return found === prefix || found.startsWith(`${prefix}/`);
    });
    if (!native) return found;
  }
  return null;
}

