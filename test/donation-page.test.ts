import { afterEach, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { DONATION_CURRENCIES, initDonationPage, USDT_NETWORKS } from '../frontend/features/donation/donation-page.js';

const html = readFileSync('frontend/shell/views/donation.html', 'utf8');
const sidebar = readFileSync('frontend/shell/layout/sidebar.html', 'utf8');
const supportStyles = readFileSync('frontend/styles/neuraflok/support-and-donation.css', 'utf8');
let dom: JSDOM | undefined;
let previousDocument: PropertyDescriptor | undefined;
let previousWindow: PropertyDescriptor | undefined;

function mountDonationPage(): Document {
  dom = new JSDOM(html);
  previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  initDonationPage();
  return dom.window.document;
}

afterEach(() => {
  dom?.window.close();
  dom = undefined;
  if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
  else Reflect.deleteProperty(globalThis, 'document');
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

it('keeps currencies in the requested order and only offers network selection for USDT', () => {
  expect(DONATION_CURRENCIES.map(coin => coin.ticker)).toEqual(['BTC', 'ETH', 'USDT', 'LTC', 'DOGE', 'SOL', 'HYPE', 'XRP', 'TRX', 'ZEC', 'XMR']);
  expect(USDT_NETWORKS).toEqual(['TRC20', 'BEP20', 'ERC20', 'HYPE', 'Polygon', 'Plasma', 'Arbitrum']);

  const document = mountDonationPage();
  const usdt = document.querySelector<HTMLButtonElement>('[data-donation-coin="USDT"]')!;
  usdt.click();
  expect(document.getElementById('donationNetworkField')!.hidden).toBe(false);
  expect(document.getElementById('donationWalletTicker')!.textContent).toBe('USDT');
  expect(usdt.getAttribute('aria-pressed')).toBe('true');

  const trx = document.querySelector<HTMLButtonElement>('[data-donation-coin="TRX"]')!;
  trx.click();
  expect(document.getElementById('donationNetworkField')!.hidden).toBe(true);
  expect(document.getElementById('donationNativeNetwork')!.hidden).toBe(false);
  expect(document.getElementById('donationWalletMonogram')!.textContent).toBe('T');
  expect(trx.getAttribute('aria-pressed')).toBe('true');
  expect(usdt.getAttribute('aria-pressed')).toBe('false');
});

it('does not present a placeholder wallet as a real address or scannable QR', () => {
  const document = mountDonationPage();
  expect(document.getElementById('donationAddressStatus')!.textContent).toContain('added later');
  expect(document.querySelector<HTMLButtonElement>('.donation-copy')!.disabled).toBe(true);
  expect(document.querySelector('.donation-qr-placeholder')!.getAttribute('aria-hidden')).toBe('true');
});

it('uses the hand-heart support icon and compact title and spacing tokens', () => {
  const icons = readFileSync('frontend/icons.css', 'utf8');
  expect(sidebar).toContain('id="supportProject"');
  expect(sidebar).toContain('ico ph ph-hand-heart');
  expect(html).toContain('ico ph ph-hand-heart');
  expect(icons).toContain(".ph.ph-hand-heart::before { content: '\\e810'; }");
  expect(supportStyles).toContain('font-size: calc(19px * var(--text-scale, 1))');
  expect(supportStyles).toContain('min-height: 166px');
  expect(supportStyles).toContain('.sidebar-session-heading { min-height: 30px;');
  expect(supportStyles).toContain('.sess { min-height: 28px; padding-block: 4px; }');
  expect(supportStyles).toContain('.sess-top b { font-size: calc(12px * var(--text-scale, 1)); line-height: 18px; }');
  expect(supportStyles).toContain('.composer-workspace-tools { min-height: 32px;');
});
