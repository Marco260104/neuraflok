/** One catalog for web-chat providers supported by the companion extension. */
export const WEB_PROVIDERS = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    chatUrl: 'https://chat.deepseek.com/',
    hostnames: ['chat.deepseek.com'],
    conversationPrefix: 'ds'
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi',
    chatUrl: 'https://www.kimi.com/en/',
    hostnames: ['kimi.com', 'www.kimi.com'],
    conversationPrefix: 'km'
  },
  qwen: {
    id: 'qwen',
    label: 'Qwen',
    chatUrl: 'https://chat.qwen.ai/',
    hostnames: ['chat.qwen.ai'],
    conversationPrefix: 'qw'
  },
  glm: {
    id: 'glm',
    label: 'Z AI',
    chatUrl: 'https://z.ai/chat',
    hostnames: ['z.ai', 'chat.z.ai', 'chatglm.cn', 'www.chatglm.cn'],
    conversationPrefix: 'gm'
  }
} as const;

export type WebProviderId = keyof typeof WEB_PROVIDERS;
export const WEB_PROVIDER_IDS = Object.keys(WEB_PROVIDERS) as WebProviderId[];

export interface WebProviderPresence {
  open: boolean;
  signedIn: boolean | null;
  /** Exact provider tab which answered the current document check. */
  tabId: number | null;
  lastSeenAt: number | null;
}

export type WebProviderPresenceMap = Record<WebProviderId, WebProviderPresence>;

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export function isWebProviderId(value: unknown): value is WebProviderId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(WEB_PROVIDERS, value);
}

export function webProviderForUrl(value: string): WebProviderId | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    return WEB_PROVIDER_IDS.find((id) => (WEB_PROVIDERS[id].hostnames as readonly string[]).includes(url.hostname)) ?? null;
  } catch {
    return null;
  }
}

export function webProviderConversationId(provider: WebProviderId, uuid: string): string {
  if (!new RegExp(`^${UUID_PATTERN}$`, 'i').test(uuid)) throw new Error('Invalid provider conversation UUID');
  return `${WEB_PROVIDERS[provider].conversationPrefix}-${uuid}`;
}

export function providerForConversationId(value: string): WebProviderId | null {
  for (const id of WEB_PROVIDER_IDS) {
    const prefix = WEB_PROVIDERS[id].conversationPrefix;
    if (new RegExp(`^${prefix}-${UUID_PATTERN}$`, 'i').test(value)) return id;
  }
  return null;
}

export function isWebProviderConversationId(value: string): boolean {
  return providerForConversationId(value) !== null;
}

export function emptyWebProviderPresence(): WebProviderPresenceMap {
  return Object.fromEntries(WEB_PROVIDER_IDS.map((id) => [id, {
    open: false,
    signedIn: null,
    tabId: null,
    lastSeenAt: null
  }])) as WebProviderPresenceMap;
}
