import type { ApiProviderKind, ApiProviderSettings } from '../../../contracts/types.js';
import { getConfig } from '../../infrastructure/settings/config.js';
import { getSecret } from '../../infrastructure/settings/secrets.js';

export interface ApiProviderEndpoint extends ApiProviderSettings {}

export function configuredApiEndpoint(): ApiProviderEndpoint {
  const provider = getConfig().providers.api;
  if (provider.kind === 'custom') return { kind: 'custom', baseUrl: provider.baseUrl };
  if (provider.kind === 'openai') return { kind: 'openai', baseUrl: 'https://api.openai.com/v1' };
  return { kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' };
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
