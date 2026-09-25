import path from 'node:path';

export const IS_WINDOWS = process.platform === 'win32';

/** WSL's local redirector aliases; the Linux part of their paths is case-sensitive. */
export const WSL_PATH = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(.*)$/i;

/** Native path identity shared by the sandbox and project catalog. */
export function nativePathIdentity(input: string): string {
  const resolved = path.resolve(input);
  if (!IS_WINDOWS) return resolved;
  const wsl = WSL_PATH.exec(resolved);
  return wsl ? `\\\\wsl.localhost\\${wsl[1]!.toLowerCase()}${wsl[2]}` : resolved.toLowerCase();
}

/** Final-path identity, using Windows' native canonicalizer when path spelling is ambiguous. */

/** Windows treats these as devices no matter which directory they appear in. */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul', 'conin$', 'conout$',
  'com0', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt0', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

/** Root names this app keeps for itself. `/skills` is the virtual namespace the design reserves for progressive-disclosure skill files reachable through `read` (`docs/tool-surface.md` §5). Reserving it here rather than inside `read` is the point: once a user has an approved folder called `skills`, `/skills/x/SKILL.md` is ambiguous between their disk and ours, and no amount of care in the reader can undo that. Cheap to reserve now, impossible to reclaim later. */

export class SandboxError extends Error {}


/** Validates one path segment. Traversal/control constraints apply everywhere; Windows also rejects drive/ADS syntax, reserved device names and names Win32 silently aliases. */
export function checkSegment(segment: string): void {
  if (segment === '' || segment === '.') {
    throw new SandboxError('Path contains an empty segment');
  }
  if (segment === '..') {
    throw new SandboxError('Path traversal ("..") is not allowed');
  }
  if (segment.includes('\0')) {
    throw new SandboxError('Path contains a null byte');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(segment)) {
    throw new SandboxError('Path contains a control character');
  }
  if (IS_WINDOWS) {
    // ":" would open an alternate data stream or a drive-relative path.
    if (segment.includes(':')) {
      throw new SandboxError('Path contains ":", which is not allowed');
    }
    if (/[<>"|?*]/.test(segment)) {
      throw new SandboxError('Path contains a character Windows does not allow');
    }
    if (/[. ]$/.test(segment)) {
      throw new SandboxError('Path segment ends with a dot or space');
    }
    const stem = segment.split('.')[0]!.toLowerCase();
    if (RESERVED_NAMES.has(stem)) {
      throw new SandboxError(`"${segment}" is a reserved Windows device name`);
    }
  }
  if (segment.length > 255) {
    throw new SandboxError('Path segment is too long');
  }
}

/** Splits a virtual path into validated segments. Windows accepts both native separators. */
export function splitVirtualPath(input: string): string[] {
  if (typeof input !== 'string') {
    throw new SandboxError('Path must be a string');
  }
  if (input.includes('\0')) {
    throw new SandboxError('Path contains a null byte');
  }
  if (input.length > 4096) {
    throw new SandboxError('Path is too long');
  }
  const segments = (IS_WINDOWS ? input.split(/[/\\]+/) : input.split(/\/+/)).filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new SandboxError('Path is empty. Use an approved virtual root such as /<root>/file.txt.');
  }
  for (const segment of segments) checkSegment(segment);
  return segments;
}

/** True when `child` is `parent` or lives underneath it; WSL retains Linux path case. */
export function isContained(parent: string, child: string): boolean {
  const na = nativePathIdentity(parent);
  const nb = nativePathIdentity(child);
  if (na === nb) return true;
  // The separator check stops "C:\Root" from matching "C:\RootEvil".
  const prefix = na.endsWith(path.sep) ? na : na + path.sep;
  return nb.startsWith(prefix);
}

/** Canonicalises the deepest part of `absPath` that exists, returning it along with the segments that do not exist yet. Used so a create/write can be checked for containment before anything is written. */

/** True for a path that names its root, rather than starting from somewhere already known. */
export function isAbsoluteVirtualPath(input: string): boolean {
  if (typeof input !== 'string') return false;
  const trimmed = input.trim();
  return IS_WINDOWS ? /^[/\\]/.test(trimmed) : trimmed.startsWith('/');
}

/** A drive-letter path or a UNC share — what Windows itself prints and the model copies. */
const NATIVE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** True when a model-supplied path is an absolute native Windows path. */
export function isNativeWindowsPath(input: unknown): input is string {
  return IS_WINDOWS && typeof input === 'string' && NATIVE_PATH.test(input.trim());
}

/** POSIX absolute paths and virtual paths both begin with `/`. The virtual namespace wins when the first segment is an approved root name; every other absolute spelling is treated as a native path copied from shell output and must prove containment before it is translated. */

