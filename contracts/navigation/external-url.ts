const MAX_URL_LENGTH = 8192;
const ENCODED_CONTROL = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i;
const CREDENTIAL_SEPARATOR = /[/?#]/;

function hasUnsafeCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === '\\' || /\s/u.test(character) || codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return ENCODED_CONTROL.test(value);
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function hasNoUrlCredentials(target: URL): boolean {
  return target.username.length === 0 && target.password.length === 0;
}

function hasNoWebCredentials(value: string): boolean {
  const delimiter = value.indexOf(':');
  const authority = value.slice(delimiter + 1).split(CREDENTIAL_SEPARATOR, 1)[0] ?? '';
  return !authority.includes('@');
}

function hasWebAuthority(value: string, target: URL): boolean {
  const separator = value.indexOf(':');
  const scheme = value.slice(0, separator).toLowerCase();
  const authority = value.slice(separator + 1);
  return (scheme === 'http' || scheme === 'https')
    && authority.startsWith('//')
    && target.hostname.length > 0;
}

function hasMailRecipient(value: string, target: URL): boolean {
  const separator = value.indexOf(':');
  return value.slice(0, separator).toLowerCase() === 'mailto'
    && target.protocol === 'mailto:'
    && target.pathname.length > 0;
}

export function safeExternalLink(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH || hasUnsafeCharacters(value)) return false;
  const target = parseUrl(value);
  if (!target || !hasNoUrlCredentials(target)) return false;
  return (hasWebAuthority(value, target) && hasNoWebCredentials(value)) || hasMailRecipient(value, target);
}
