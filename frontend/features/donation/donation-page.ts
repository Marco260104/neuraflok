import { run, toast } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';
import QRCode from 'qrcode';

type DonationCurrency = {
  ticker: string;
  name: string;
  network: string;
  address: string;
  icon?: string;
  monogram?: string;
};

/** EVM accounts use the same 0x address on each compatible network. The network is still selected independently. */
export const EVM_DONATION_ADDRESS = '0x3821B15219Fd7f744809C2f6ae65414FBC4fb7c1';
const TRON_DONATION_ADDRESS = 'TMQ2FZhkAQXSmJrsNA9tsbShuHtarkxdvu';

export const DONATION_CURRENCIES: readonly DonationCurrency[] = [
  { ticker: 'BTC', name: 'Bitcoin', network: 'Bitcoin', address: 'bc1qztd9na4zwhq8jxe0gh27rurfettsdzev6wpugl', icon: './assets/crypto/btc.svg' },
  { ticker: 'ETH', name: 'Ethereum', network: 'Ethereum', address: EVM_DONATION_ADDRESS, icon: './assets/crypto/eth.svg' },
  { ticker: 'BNB', name: 'BNB', network: 'BNB Smart Chain (BEP20)', address: EVM_DONATION_ADDRESS, icon: './assets/crypto/bnb.svg' },
  { ticker: 'USDT', name: 'Tether', network: 'USDT', address: '', icon: './assets/crypto/usdt.svg' },
  { ticker: 'LTC', name: 'Litecoin', network: 'Litecoin', address: 'ltc1qc7sfu3lj9m9xfq03rm28yqw6mn73gkwpl6l2pm', icon: './assets/crypto/ltc.svg' },
  { ticker: 'DOGE', name: 'Dogecoin', network: 'Dogecoin', address: 'D6uT9BVEgzGAXMSzqZaNMwSK4Xnd6zSQRp', icon: './assets/crypto/doge.svg' },
  { ticker: 'SOL', name: 'Solana', network: 'Solana', address: '6kSvCTt2bt1Nrdk56jy7E3Pvoo2pRFA16NMCTTEpHAcG', icon: './assets/crypto/sol.svg' },
  { ticker: 'HYPE', name: 'Hyperliquid', network: 'HyperEVM', address: EVM_DONATION_ADDRESS, icon: './assets/crypto/hype.svg' },
  { ticker: 'XRP', name: 'XRP', network: 'XRP Ledger', address: 'rsdXR2kiQFYuSXV3VZVUDdmxFXff16Fxnn', icon: './assets/crypto/xrp.svg' },
  { ticker: 'TRX', name: 'TRON', network: 'TRON', address: TRON_DONATION_ADDRESS, icon: './assets/crypto/trx.svg' },
  { ticker: 'ZEC', name: 'Zcash', network: 'Zcash', address: 't1W85CYsLhutWHrUvS7NGvGXcpADWnMnpFG', icon: './assets/crypto/zec.svg' },
  { ticker: 'XMR', name: 'Monero', network: 'Monero', address: '85HEAkKWBTybrcpje8QLr45F6A97kaAN5fx94c8VGUHB7H84h4NS8w7ZnJUXyyXpGm5XwfWbKNEBLhDBEfd2BVQAHRkYRbS', icon: './assets/crypto/xmr.svg' }
];

export const USDT_NETWORKS = ['TRC20', 'BEP20', 'ERC20', 'HYPE', 'Polygon', 'Plasma', 'Arbitrum'] as const;
export type UsdtNetwork = (typeof USDT_NETWORKS)[number];

/** TRC20 is the only listed USDT network that uses the separate TRON address. All others are EVM networks. */
export const USDT_NETWORK_ADDRESSES: Readonly<Record<UsdtNetwork, string>> = {
  TRC20: TRON_DONATION_ADDRESS,
  BEP20: EVM_DONATION_ADDRESS,
  ERC20: EVM_DONATION_ADDRESS,
  HYPE: EVM_DONATION_ADDRESS,
  Polygon: EVM_DONATION_ADDRESS,
  Plasma: EVM_DONATION_ADDRESS,
  Arbitrum: EVM_DONATION_ADDRESS
};

const EVM_NETWORKS = new Set([
  'Ethereum', 'BNB Smart Chain (BEP20)', 'HyperEVM',
  'BEP20', 'ERC20', 'HYPE', 'Polygon', 'Plasma', 'Arbitrum'
]);

export function initDonationPage(): void {
  const list = document.getElementById('donationCoinList');
  if (!list || list.dataset.initialized === 'true') return;
  list.dataset.initialized = 'true';

  const walletTitle = document.getElementById('donationWalletTitle');
  const walletTicker = document.getElementById('donationWalletTicker');
  const walletLogo = document.getElementById('donationWalletLogo') as HTMLImageElement | null;
  const walletMonogram = document.getElementById('donationWalletMonogram');
  const networkField = document.getElementById('donationNetworkField');
  const networkSelect = document.getElementById('donationNetwork') as HTMLSelectElement | null;
  const nativeNetwork = document.getElementById('donationNativeNetwork');
  const addressOutput = document.getElementById('donationAddressStatus');
  const addressDetail = document.getElementById('donationAddressDetail');
  const qrCode = document.getElementById('donationQrCode') as HTMLImageElement | null;
  const copyButton = document.querySelector<HTMLButtonElement>('.donation-copy');
  if (!walletTitle || !walletTicker || !walletLogo || !walletMonogram || !networkField || !networkSelect || !nativeNetwork || !addressOutput || !addressDetail || !qrCode || !copyButton) return;

  const coinList = list;
  const title = walletTitle;
  const tickerOutput = walletTicker;
  const logo = walletLogo;
  const monogram = walletMonogram;
  const networkPicker = networkField;
  const networkSelectElement = networkSelect;
  const nativeNetworkLabel = nativeNetwork;
  const addressValueElement = addressOutput;
  const addressDescription = addressDetail;
  const qrImage = qrCode;
  const copyAddressButton = copyButton;
  let selectedTicker = 'BTC';
  let addressToCopy = '';
  let qrGeneration = 0;

  async function renderQr(address: string): Promise<void> {
    const generation = ++qrGeneration;
    qrImage.hidden = true;
    qrImage.removeAttribute('src');
    if (!address) return;
    try {
      const svg = await QRCode.toString(address, {
        type: 'svg',
        errorCorrectionLevel: 'M', margin: 2, width: 232,
        color: { dark: '#111318', light: '#ffffff' }
      });
      if (generation !== qrGeneration) return;
      qrImage.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      qrImage.hidden = false;
    } catch {
      // The readable wallet address and copy action remain available if QR
      // rendering fails locally.
      if (generation === qrGeneration) qrImage.hidden = true;
    }
  }

  function paint(ticker: string): void {
    const coin = DONATION_CURRENCIES.find(option => option.ticker === ticker);
    if (!coin) return;
    selectedTicker = coin.ticker;

    for (const button of coinList.querySelectorAll<HTMLButtonElement>('[data-donation-coin]')) {
      const selected = button.dataset.donationCoin === coin.ticker;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }

    ui(title, 'textContent', () => t(coin.name));
    tickerOutput.textContent = coin.ticker;
    logo.hidden = !coin.icon;
    monogram.hidden = !coin.monogram;
    logo.alt = '';
    if (coin.icon) logo.src = coin.icon;
    if (coin.monogram) monogram.textContent = coin.monogram;

    const requiresNetwork = coin.ticker === 'USDT';
    networkPicker.hidden = !requiresNetwork;
    nativeNetworkLabel.hidden = requiresNetwork;
    const selectedUsdtNetwork = networkSelectElement.value as UsdtNetwork;
    const network = requiresNetwork ? selectedUsdtNetwork : coin.network;
    if (requiresNetwork) {
      addressToCopy = USDT_NETWORK_ADDRESSES[selectedUsdtNetwork] ?? '';
    } else {
      addressToCopy = coin.address;
    }

    ui(nativeNetworkLabel, 'textContent', () => t(requiresNetwork ? 'Native network' : coin.network));
    ui(addressValueElement, 'textContent', () => addressToCopy || t('Address unavailable'));
    addressValueElement.title = addressToCopy;
    copyAddressButton.disabled = !addressToCopy;
    void renderQr(addressToCopy);
    ui(addressDescription, 'textContent', () => EVM_NETWORKS.has(network)
      ? t('This address is shared across supported EVM networks. Funds stay on the network used to send them.')
      : t('Use this address on {0} only.', [t(network)]));
  }

  coinList.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-donation-coin]');
    if (button?.dataset.donationCoin) paint(button.dataset.donationCoin);
  });
  networkSelectElement.addEventListener('change', () => paint(selectedTicker));
  copyAddressButton.addEventListener('click', async () => {
    if (!addressToCopy) return;
    const copied = await run(window.api.writeClipboard(addressToCopy));
    if (copied !== null) toast(t('Copied'));
  });

  const initial = coinList.querySelector<HTMLButtonElement>('[data-donation-coin][aria-pressed="true"]')?.dataset.donationCoin ?? 'BTC';
  paint(initial);
}
