import { createHash } from 'node:crypto';

const STRUCTURAL = new Set([
  '~', 'Users', 'home', 'Library', 'Application Support', 'Caches', 'Logs', 'AppData', 'Roaming', 'Local', 'LocalLow',
  'Program Files', 'Program Files (x86)', 'ProgramData', 'Applications', 'Contents', 'Resources', 'MacOS', 'tmp', 'var',
  'private', 'opt', 'usr', 'bin', 'lib', 'etc', 'Temp', 'Windows', 'System32',
  'NEURAFLOK', 'neuraflok', '.neuraflok', 'sessions', 'extension', 'logs', 'skills', 'plugins',
  'workspace', 'state', 'durable', 'app.asar', 'node_modules', 'Google', 'Chrome', 'Chromium', 'Microsoft', 'Edge',
  'BraveSoftware', 'Brave-Browser', 'User Data', 'Default', 'Extensions', '.codex',
  'commands', 'ack', 'redeem', 'step', 'status', 'activity', 'events', 'input', 'revivals', 'pending', 'mcp', 'core',
  'desktop', 'wake', 'hello', 'pair', 'extension', 'update'
]);

export function taggedValue(kind: string, value: string): string {
  return `<${kind}:${createHash('sha256').update(value).digest('hex').slice(0, 4)}>`;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scrubSegment(segment: string): string {
  if (!segment || STRUCTURAL.has(segment) || /^\d+$/.test(segment)) return segment;
  const dot = segment.lastIndexOf('.');
  const extension = dot > 0 && segment.length - dot <= 7 && /^\.[A-Za-z0-9]+$/.test(segment.slice(dot)) ? segment.slice(dot) : '';
  const stem = extension ? segment.slice(0, dot) : segment;
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(stem) || /^[0-9a-f]{12,64}$/i.test(stem) ||
      /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/i.test(stem)) return segment;
  return taggedValue('p', stem) + extension;
}

export function scrubPath(path: string): string {
  const separator = path.includes('\\') && !path.startsWith('/') ? '\\' : '/';
  return path.split(/[\\/]/).map(scrubSegment).join(separator);
}
