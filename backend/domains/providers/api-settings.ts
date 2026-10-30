import type { ApiProviderKind, ApiProviderSettings } from '../../../contracts/types.js';
import { getConfig } from '../../infrastructure/settings/config.js';
import { getSecret } from '../../infrastructure/settings/secrets.js';

export interface ApiProviderEndpoint extends ApiProviderSettings {}

export type ApiEndpointRoute = 'chat' | 'models';

export function configuredApiEndpoint(): ApiProviderEndpoint {
  const provider = getConfig().providers.api;
  if (provider.kind === 'custom') return { ...provider };
  if (provider.kind === 'openai') return { kind: 'openai', baseUrl: 'https://api.openai.com/v1' };
  return { kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' };
}

function customPath(value: string | undefined, fallback: string, optional = false): string | null {
  const path = (value ?? fallback).trim();
  if (!path && optional) return null;
  const normalized = path.replace(/^\/+/, '');
  let decoded: string;
  try { decoded = decodeURIComponent(normalized); }
  catch { throw new Error('invalid_provider: custom API path has invalid encoding'); }
  if (!normalized || normalized.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(normalized) || /[\\?#\u0000-\u001f\u007f]/.test(normalized) ||
      !/^[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(normalized) ||
      decoded.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error('invalid_provider: custom API path must be a relative path without query or fragment');
  }
  return normalized;
}

export function apiRequestUrl(endpoint: ApiProviderEndpoint, route: ApiEndpointRoute): string | null {
  const baseUrl = resolveApiBaseUrl(endpoint);
  const fallback = route === 'chat'
    ? endpoint.kind === 'custom' && endpoint.protocol === 'anthropic-messages' ? 'messages' : 'chat/completions'
    : 'models';
  const configured = endpoint.kind === 'custom'
    ? route === 'chat' ? endpoint.chatPath : endpoint.modelsPath
    : undefined;
  if (route === 'models' && endpoint.kind === 'custom' && configured?.trim() === '') return null;
  const path = customPath(configured, fallback, route === 'models' && endpoint.kind === 'custom');
  return path ? `${baseUrl}/${path}` : null;
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_EXTRA_HEADERS = new Set(['authorization', 'proxy-authorization', 'content-type', 'host', 'cookie', 'set-cookie']);

/** Build provider headers without returning credentials to the renderer or writing additional secrets to config.json. */
export async function apiRequestHeaders(endpoint: ApiProviderEndpoint, key: string | null): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (endpoint.kind === 'custom') {
    const anthropic = endpoint.protocol === 'anthropic-messages';
    const authHeader = (endpoint.authHeader ?? (anthropic ? 'x-api-key' : 'Authorization')).trim();
    const prefix = endpoint.authPrefix ?? (anthropic ? '' : 'Bearer');
    if (authHeader && !HEADER_NAME.test(authHeader)) throw new Error('invalid_provider: authentication header name is invalid');
    if (/[\r\n\u0000]/.test(prefix) || prefix.length > 64) throw new Error('invalid_provider: authentication prefix is invalid');
    if (key && authHeader) headers[authHeader.toLowerCase()] = prefix.trim() ? `${prefix.trim()} ${key}` : key;
    if (anthropic) headers['anthropic-version'] = '2023-06-01';

    const extraJson = await getSecret('customProviderHeaders');
    if (extraJson) {
      let extra: unknown;
      try { extra = JSON.parse(extraJson); }
      catch { throw new Error('invalid_provider: additional API headers must be a JSON object'); }
      if (!extra || typeof extra !== 'object' || Array.isArray(extra) || Object.keys(extra).length > 24) {
        throw new Error('invalid_provider: additional API headers must be an object with at most 24 entries');
      }
      for (const [name, value] of Object.entries(extra)) {
        const lowerName = name.toLowerCase();
        if (!HEADER_NAME.test(name) || FORBIDDEN_EXTRA_HEADERS.has(lowerName) || (authHeader && lowerName === authHeader.toLowerCase()) ||
            typeof value !== 'string' || value.length > 2000 || /[\r\n\u0000]/.test(value)) {
          throw new Error(`invalid_provider: additional API header ${name.slice(0, 80)} is invalid or reserved`);
        }
        headers[lowerName] = value;
      }
    }
  } else if (key) {
    headers['authorization'] = `Bearer ${key}`;
  }
  return headers;
}

export function resolveApiBaseUrl(endpoint: ApiProviderEndpoint): string {
  if (endpoint.kind === 'openrouter') return 'https://openrouter.ai/api/v1';
  if (endpoint.kind === 'openai') return 'https://api.openai.com/v1';
  const raw = endpoint.baseUrl.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('invalid_provider: custom provider URL is invalid');
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('invalid_provider: custom provider URL must be https, or http on localhost');
  }
  return url.toString().replace(/\/+$/, '');
}

export function apiProviderKey(kind: ApiProviderKind): Promise<string | null> {
  return getSecret(kind === 'custom' ? 'customProviderApiKey' : kind === 'openai' ? 'openaiChatApiKey' : 'openRouterApiKey');
}
