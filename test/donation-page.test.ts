import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import QRCode from 'qrcode';
import { DONATION_CURRENCIES, EVM_DONATION_ADDRESS, initDonationPage, USDT_NETWORKS, USDT_NETWORK_ADDRESSES } from '../frontend/features/donation/donation-page.js';

const html = readFileSync('frontend/shell/views/donation.html', 'utf8');
const sidebar = readFileSync('frontend/shell/layout/sidebar.html', 'utf8');
const foundationStyles = readFileSync('frontend/styles/foundation.css', 'utf8');
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
  expect(DONATION_CURRENCIES.map(coin => coin.ticker)).toEqual(['BTC', 'ETH', 'BNB', 'USDT', 'LTC', 'DOGE', 'SOL', 'HYPE', 'XRP', 'TRX', 'ZEC', 'XMR']);
  expect(DONATION_CURRENCIES.filter(coin => ['HYPE', 'XRP', 'TRX'].includes(coin.ticker)))
    .toMatchObject([
      { ticker: 'HYPE', icon: './assets/crypto/hype.svg' },
      { ticker: 'XRP', icon: './assets/crypto/xrp.svg' },
      { ticker: 'TRX', icon: './assets/crypto/trx.svg' }
    ]);
  expect(USDT_NETWORKS).toEqual(['TRC20', 'BEP20', 'ERC20', 'HYPE', 'Polygon', 'Plasma', 'Arbitrum']);
  expect(USDT_NETWORK_ADDRESSES.TRC20).toBe('TMQ2FZhkAQXSmJrsNA9tsbShuHtarkxdvu');
  for (const network of USDT_NETWORKS.filter(network => network !== 'TRC20')) {
    expect(USDT_NETWORK_ADDRESSES[network], `${network} shares the EVM address`).toBe(EVM_DONATION_ADDRESS);
  }

  const evmCurrencies = DONATION_CURRENCIES.filter(coin => ['ETH', 'BNB', 'HYPE'].includes(coin.ticker));
  expect(evmCurrencies.map(coin => coin.address)).toEqual([EVM_DONATION_ADDRESS, EVM_DONATION_ADDRESS, EVM_DONATION_ADDRESS]);
  expect(DONATION_CURRENCIES.find(coin => coin.ticker === 'BNB')).toMatchObject({
    name: 'BNB', network: 'BNB Smart Chain (BEP20)', icon: './assets/crypto/bnb.svg'
  });

  const document = mountDonationPage();
  const usdt = document.querySelector<HTMLButtonElement>('[data-donation-coin="USDT"]')!;
  usdt.click();
  expect(document.getElementById('donationNetworkField')!.hidden).toBe(false);
  expect(document.getElementById('donationWalletTicker')!.textContent).toBe('USDT');
  expect(document.getElementById('donationAddressStatus')!.textContent).toBe(USDT_NETWORK_ADDRESSES.TRC20);
  expect(usdt.getAttribute('aria-pressed')).toBe('true');
  const network = document.getElementById('donationNetwork') as HTMLSelectElement;
  for (const evmNetwork of ['BEP20', 'ERC20', 'HYPE', 'Polygon', 'Plasma', 'Arbitrum']) {
    network.value = evmNetwork;
    network.dispatchEvent(new dom!.window.Event('change', { bubbles: true }));
    expect(document.getElementById('donationAddressStatus')!.textContent, `${evmNetwork} receives at the shared EVM address`).toBe(EVM_DONATION_ADDRESS);
  }

  const hype = document.querySelector<HTMLButtonElement>('[data-donation-coin="HYPE"]')!;
  hype.click();
  expect(document.getElementById('donationWalletLogo')!.getAttribute('src')).toBe('./assets/crypto/hype.svg');
  expect(document.getElementById('donationWalletTicker')!.textContent).toBe('HYPE');
  expect(document.getElementById('donationWalletMonogram')!.hidden).toBe(true);

  const xrp = document.querySelector<HTMLButtonElement>('[data-donation-coin="XRP"]')!;
  xrp.click();
  expect(document.getElementById('donationWalletLogo')!.getAttribute('src')).toBe('./assets/crypto/xrp.svg');

  const trx = document.querySelector<HTMLButtonElement>('[data-donation-coin="TRX"]')!;
  trx.click();
  expect(document.getElementById('donationNetworkField')!.hidden).toBe(true);
  expect(document.getElementById('donationNativeNetwork')!.hidden).toBe(false);
  expect(document.getElementById('donationWalletLogo')!.getAttribute('src')).toBe('./assets/crypto/trx.svg');
  expect(document.getElementById('donationWalletMonogram')!.hidden).toBe(true);
  expect(trx.getAttribute('aria-pressed')).toBe('true');
  expect(usdt.getAttribute('aria-pressed')).toBe('false');
});

it('shows the real address, keeps it copyable, and renders a local QR for the selected wallet', async () => {
  const document = mountDonationPage();
  expect(document.getElementById('donationAddressStatus')!.textContent).toBe(DONATION_CURRENCIES[0]!.address);
  expect(document.querySelector<HTMLButtonElement>('.donation-copy')!.disabled).toBe(false);
  const qr = document.getElementById('donationQrCode') as HTMLImageElement;
  await vi.waitFor(() => expect(qr.src).toMatch(/^data:image\/svg\+xml;charset=utf-8,/));
  const expectedBitcoinQr = await QRCode.toString(DONATION_CURRENCIES[0]!.address, {
    type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 232,
    color: { dark: '#111318', light: '#ffffff' }
  });
  expect(decodeURIComponent(qr.src.slice(qr.src.indexOf(',') + 1))).toBe(expectedBitcoinQr);
  expect(qr.hidden).toBe(false);
  expect(qr.getAttribute('aria-hidden')).toBe('true');
  expect(document.querySelector('.donation-note')!.textContent).toContain('EVM networks share an address');

  const writeClipboard = vi.fn(async (value: string) => ({ ok: true as const, data: value }));
  Object.defineProperty(dom!.window, 'api', { configurable: true, value: { writeClipboard } });
  document.querySelector<HTMLButtonElement>('[data-donation-coin="BNB"]')!.click();
  const expectedEvmQr = await QRCode.toString(EVM_DONATION_ADDRESS, {
    type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 232,
    color: { dark: '#111318', light: '#ffffff' }
  });
  await vi.waitFor(() => expect(decodeURIComponent(qr.src.slice(qr.src.indexOf(',') + 1))).toBe(expectedEvmQr));
  document.querySelector<HTMLButtonElement>('.donation-copy')!.click();
  return vi.waitFor(() => expect(writeClipboard).toHaveBeenCalledWith(EVM_DONATION_ADDRESS));
});

it('ships HYPE, XRP, TRON, and BNB marks as public assets without hidden monogram fallbacks', () => {
  const hypeMark = readFileSync('frontend/public/assets/crypto/hype.svg', 'utf8');
  const xrpMark = readFileSync('frontend/public/assets/crypto/xrp.svg', 'utf8');
  const tronMark = readFileSync('frontend/public/assets/crypto/trx.svg', 'utf8');
  const bnbMark = readFileSync('frontend/public/assets/crypto/bnb.svg', 'utf8');

  expect(hypeMark).toContain('#97fce4');
  expect(xrpMark).toContain('<title>XRP</title>');
  expect(tronMark).toContain('#c53027');
  expect(tronMark).not.toMatch(/<animate|@keyframes|animation:/i);
  expect(bnbMark).toContain('#F0B90B');
  for (const coin of DONATION_CURRENCIES) {
    if (coin.icon) expect(readFileSync(`frontend/public/${coin.icon.slice(2)}`, 'utf8')).toContain('<svg');
  }
  expect(supportStyles).toContain('.donation-wallet-monogram:not([hidden])');
  expect(html).not.toContain('donation-qr-placeholder');

  const document = mountDonationPage();
  for (const ticker of ['HYPE', 'XRP', 'TRX']) {
    document.querySelector<HTMLButtonElement>(`[data-donation-coin="${ticker}"]`)!.click();
    expect(document.getElementById('donationWalletLogo')!.hidden).toBe(false);
    expect(document.getElementById('donationWalletMonogram')!.hidden).toBe(true);
  }
});

it('uses the hand-heart support icon and compact title and spacing tokens', () => {
  const icons = readFileSync('frontend/icons.css', 'utf8');
  expect(sidebar).toContain('id="supportProject"');
  expect(sidebar).toContain('ico ph ph-hand-heart');
  expect(html).toContain('ico ph ph-hand-heart');
  expect(html).not.toContain('donation-social-links');
  expect(icons).toContain(".ph.ph-hand-heart::before { content: '\\e810'; }");
  expect(supportStyles).toContain('font-size: calc(19px * var(--text-scale, 1))');
  expect(foundationStyles).toContain('--text-scale: 1.15;');
  expect(supportStyles).toContain('.composer textarea:focus-visible { border: 0;');
  expect(supportStyles).toContain('.composer:focus-within { box-shadow: 0 0 0 1px var(--accent-edge)');
  expect(supportStyles).toContain('.donation-qr-frame');
  expect(supportStyles).toContain('width: min(100%, 256px)');
  expect(supportStyles).toContain('.donation-wallet-copy .donation-address');
  expect(supportStyles).toContain('.sidebar-session-heading { min-height: 30px;');
  expect(supportStyles).toContain('.sess { min-height: 28px; padding-block: 4px; }');
  expect(supportStyles).toContain('.sess-top b { font-size: calc(12px * var(--text-scale, 1)); line-height: 18px; }');
  expect(supportStyles).toContain('.composer-workspace-tools { min-height: 32px;');
});
