const URL_SCHEMES = new Set(['http', 'https', 'file', 'ftp']);

type HostRule =
  | { kind: 'any' }
  | { kind: 'exact'; value: string; includePort: boolean }
  | { kind: 'domain'; value: string; includePort: boolean };

interface UrlQueryPattern {
  allUrls: boolean;
  scheme: string;
  host: HostRule;
  path: RegExp;
}

function escapePatternText(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function compilePath(value: string): RegExp {
  const expression = value.split('*').map(escapePatternText).join('.*');
  return new RegExp(`^${expression}$`);
}

function compileHost(value: string, scheme: string): HostRule | null {
  if (value === '*') return { kind: 'any' };
  if (value.startsWith('*.')) {
    const domain = value.slice(2);
    return domain && !domain.includes('*')
      ? { kind: 'domain', value: domain, includePort: domain.includes(':') }
      : null;
  }
  if (value.includes('*') || (!value && scheme !== 'file')) return null;
  return { kind: 'exact', value, includePort: value.includes(':') };
}

function compilePattern(value: string): UrlQueryPattern | null {
  if (value === '<all_urls>') return { allUrls: true, scheme: '', host: { kind: 'any' }, path: /.*/ };
  const separator = value.indexOf('://');
  if (separator < 1) return null;
  const scheme = value.slice(0, separator);
  if (scheme !== '*' && !URL_SCHEMES.has(scheme)) return null;
  const remainder = value.slice(separator + 3);
  const pathStart = remainder.indexOf('/');
  if (pathStart < 0) return null;
  const host = compileHost(remainder.slice(0, pathStart), scheme);
  if (!host) return null;
  return { allUrls: false, scheme, host, path: compilePath(remainder.slice(pathStart)) };
}

function hostMatches(url: URL, rule: HostRule): boolean {
  if (rule.kind === 'any') return true;
  const host = rule.includePort ? url.host : url.hostname;
  if (rule.kind === 'exact') return host === rule.value;
  return host === rule.value || host.endsWith(`.${rule.value}`);
}

function patternMatches(url: URL, pattern: UrlQueryPattern): boolean {
  const scheme = url.protocol.slice(0, -1);
  if (pattern.allUrls) return URL_SCHEMES.has(scheme);
  const schemeMatches = pattern.scheme === '*'
    ? scheme === 'http' || scheme === 'https'
    : scheme === pattern.scheme;
  return schemeMatches && hostMatches(url, pattern.host) && pattern.path.test(url.pathname + url.search);
}

export function matchesTabUrlPatterns(url: string, patterns: string | readonly string[]): boolean {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return false;
  }
  const candidates = typeof patterns === 'string' ? [patterns] : patterns;
  return candidates.some((pattern) => {
    const compiled = compilePattern(pattern);
    return compiled !== null && patternMatches(parsedUrl, compiled);
  });
}
