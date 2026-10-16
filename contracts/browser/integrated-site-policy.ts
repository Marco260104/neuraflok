import { WEB_PROVIDERS } from '../web-providers.js';

const SIGN_IN_HOSTS = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'idmsa.apple.com'
];

const INTEGRATED_BROWSER_HOSTS = new Set([
  ...Object.values(WEB_PROVIDERS).flatMap(provider => provider.hostnames),
  ...SIGN_IN_HOSTS
]);

export function opensInIntegratedBrowser(value: string): boolean {
  try {
    const address = new URL(value);
    return address.protocol === 'https:' && !address.username && !address.password && !address.port &&
      INTEGRATED_BROWSER_HOSTS.has(address.hostname);
  } catch {
    return false;
  }
}
