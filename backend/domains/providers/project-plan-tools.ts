import path from 'node:path';

function normalizedVirtualPath(value: string): string | null {
  const normalized = value.replace(/\\/g, '/');
  if (!normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:/.test(normalized)) return null;
  return path.posix.resolve('/', normalized);
}

function inProject(root: string, candidate: string): boolean {
  const normalizedRoot = normalizedVirtualPath(root);
  const normalizedCandidate = normalizedVirtualPath(candidate.replace(/:\d+(?:-\d+)?$/, ''));
  return Boolean(normalizedRoot && normalizedCandidate &&
    (normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)));
}

/** Restrict project-plan reads to the project bound to the current session. */
export function scopeProjectPlanTool(name: string, args: unknown, projectDirectory: string): { ok: true; args: unknown } | { ok: false } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false };
  const value = { ...(args as Record<string, unknown>) };
  if (name === 'read') {
    const paths = value.paths;
    if (!Array.isArray(paths) || paths.length === 0 || paths.some(item => typeof item !== 'string' || !inProject(projectDirectory, item))) {
      return { ok: false };
    }
  } else if (name === 'find') {
    if (value.path === undefined) value.path = projectDirectory;
    if (typeof value.path !== 'string' || !inProject(projectDirectory, value.path)) return { ok: false };
  } else {
    return { ok: false };
  }
  return { ok: true, args: value };
}
