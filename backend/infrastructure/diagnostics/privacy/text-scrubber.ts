import { redact } from '../../settings/logger.js';
import { escapeRegExp, scrubPath, taggedValue } from './path-scrubber.js';
import type { ScrubContext } from './context.js';

const PUBLIC_HOSTS = /^(?:(?:[a-z0-9-]+\.)*(?:openai\.com|github\.com|githubusercontent\.com|openrouter\.ai)|localhost|127\.0\.0\.1|\[::1\])$/i;

function scrubUrl(url: string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return '<url>'; }
  if (!PUBLIC_HOSTS.test(parsed.hostname)) return `${parsed.protocol}//<host>`;
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
}

export function scrubText(text: string, context: ScrubContext): string {
  let out = redact(text);
  out = out
    .replace(/\bhttps?:\/\/[^\s'"<>)\]]+/g, scrubUrl)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\bBearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/\b([A-Z][A-Z0-9_]{2,})=("[^"]*"|'[^']*'|\S+)/g, '$1=<redacted>')
    .replace(/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, ip => ip === '127.0.0.1' || ip === '0.0.0.0' ? ip : '<ip>');
  if (context.home.length >= 3) {
    const home = escapeRegExp(context.home.replace(/[\\/]+$/, ''));
    out = out.replace(new RegExp(home.replace(/\\\\|\//g, '[\\\\/]'), 'gi'), '~');
  }
  out = out
    .replace(/(['"`])((?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/)[^'"`\n]*?)\1/g, (_match, quote: string, path: string) => quote + scrubPath(path) + quote)
    .replace(/(?:\b[A-Za-z]:[\\/]|\\\\|~[\\/]|(?<![\w.:/<>-])\/(?:Users|home|Volumes|mnt|media)\/)(?:(?![^\\/\n]*\.[A-Za-z0-9]{1,6}\s)[^\\/\n'"`<>|*?~]+[\\/])*(?:[^\\/\n'"`<>|*?]{0,80}?\.[A-Za-z0-9]{1,6}(?![\w.])|[^\s\\/'"`<>|*?]*)/g, scrubPath)
    .replace(/(?<![\w.:/<>~-])\/(?=[^\s/'"`<>]+\/)[^\s'"`<>|*?]+/g, scrubPath);
  const known = [...new Set(context.known.map(value => value.trim()).filter(value => value.length >= 3))]
    .sort((a, b) => b.length - a.length);
  return known.length ? out.replace(new RegExp(known.map(escapeRegExp).join('|'), 'gi'), match => taggedValue('x', match.toLowerCase())) : out;
}
