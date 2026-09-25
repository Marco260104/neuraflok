import type { FileChange } from '../../../../contracts/session.js';
import { formatDelta } from '../../workspace/diffstat.js';

export function shortPath(virtualPath: string): string {
  const parts = String(virtualPath ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 1) return `/${parts.join('/')}`;
  return parts.slice(1).join('/');
}

/** File name plus its parent folder, so activity reads "foo.ts in src" rather than a raw path or command. */
export function locatedPath(virtualPath: string): { file: string; folder: string | null } {
  const raw = String(virtualPath ?? '').replace(/\\/g, '/');
  const parts = raw.split('/').filter(Boolean);
  if (parts.length === 0) return { file: String(virtualPath ?? ''), folder: null };
  const skipRoot = (raw.startsWith('/') || /^[A-Za-z]:$/.test(parts[0] ?? '')) && parts.length > 1 && !parts[0]!.includes('.');
  const rest = skipRoot ? parts.slice(1) : parts;
  const file = rest[rest.length - 1] || parts[parts.length - 1]!;
  const folder = rest.length > 1 ? rest[rest.length - 2]! : null;
  return { file, folder };
}

export function locatedTitle(verb: string, virtualPath: string): string {
  const { file, folder } = locatedPath(virtualPath);
  const body = folder ? `${file} in ${folder}` : file;
  return verb ? `${verb} ${body}` : body;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function totalDelta(changes: readonly FileChange[]): string | null {
  if (changes.length === 0) return null;
  const added = changes.reduce((sum, change) => sum + change.added, 0);
  const removed = changes.reduce((sum, change) => sum + change.removed, 0);
  const text = formatDelta({ added, removed });
  if (!text) return null;
  return changes.some(change => change.approximate) ? `~${text}` : text;
}

export function lineRangeMetric(detail: string | null): string | null {
  if (!detail) return null;
  const match = /^lines\s+(\d+)[–-](\d+)(?:\s+of\s+\d+)?$/i.exec(detail.trim());
  if (!match) return null;
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first) return null;
  return plural(last - first + 1, 'line');
}

export function scriptLabel(script: string | null): string {
  if (!script) return 'a command';
  const lines = script
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
  const first = (lines[0] ?? '').replace(/\s+/g, ' ');
  if (!first) return 'a command';
  const shown = first.slice(0, 70);
  return lines.length > 1 || shown.length < first.length ? `${shown} …` : shown;
}

export function fileTitle(verb: string, changes: readonly FileChange[], fallback: string | null): string {
  if (changes.length === 1) return locatedTitle(verb, changes[0]!.path);
  if (changes.length > 1) return `${verb} ${plural(changes.length, 'file')}`;
  return fallback ? locatedTitle(verb, fallback) : verb;
}
