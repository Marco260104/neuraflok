import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { BROWSER_BRIDGE_PORTS } from '../contracts/browser/bridge.js';
import { isWebProviderId, WEB_PROVIDERS, WEB_PROVIDER_IDS, webProviderForUrl } from '../contracts/web-providers.js';
import { opensInIntegratedBrowser } from '../contracts/browser/integrated-site-policy.js';

it('keeps OpenAI hosts and identity out of the web-provider bridge', () => {
  expect(WEB_PROVIDER_IDS).toEqual(['deepseek', 'kimi', 'qwen', 'glm']);
  expect(isWebProviderId('chatgpt')).toBe(false);
  expect(webProviderForUrl('https://chatgpt.com/')).toBeNull();
  expect(webProviderForUrl('https://chat.openai.com/')).toBeNull();
  expect(opensInIntegratedBrowser('https://chatgpt.com/')).toBe(false);
  expect(opensInIntegratedBrowser('https://chat.openai.com/')).toBe(false);
});

it('limits extension page access to the four web providers and local bridge ports', () => {
  const manifest = JSON.parse(readFileSync(new URL('../browser-extension/manifest.json', import.meta.url), 'utf8'));
  const providerHosts = Object.values(WEB_PROVIDERS).flatMap(provider =>
    provider.hostnames.map(host => `https://${host}/*`)
  ).sort();
  const extensionHosts = manifest.host_permissions.filter((host: string) => host.startsWith('https://')).sort();
  const bridgeHosts = manifest.host_permissions.filter((host: string) => host.startsWith('http://')).sort();
  const contentHosts = manifest.content_scripts.flatMap((script: { matches: string[] }) => script.matches).sort();

  expect(extensionHosts).toEqual(providerHosts);
  expect(contentHosts).toEqual(providerHosts);
  expect(bridgeHosts).toEqual(BROWSER_BRIDGE_PORTS.map(port => `http://127.0.0.1:${port}/*`));
});

it('admits only hostnames registered for the supported web providers', () => {
  for (const provider of Object.values(WEB_PROVIDERS)) {
    for (const hostname of provider.hostnames) {
      expect(opensInIntegratedBrowser(`https://${hostname}/chat`)).toBe(true);
    }
  }
});

it('allows identity provider pages used during sign-in', () => {
  for (const hostname of ['accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com', 'idmsa.apple.com']) {
    expect(opensInIntegratedBrowser(`https://${hostname}/authorize`)).toBe(true);
  }
});

it.each([
  'http://chat.deepseek.com/',
  'https://chat.deepseek.com.evil.invalid/',
  'https://user@chat.deepseek.com/',
  'https://chat.deepseek.com:8443/',
  'https://unsupported.example/chat',
  'not a URL'
])('rejects unregistered or unsafe site URLs: %s', value => {
  expect(opensInIntegratedBrowser(value)).toBe(false);
});
