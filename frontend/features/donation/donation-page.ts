import { t, ui } from '../../shared/i18n.js';

type DonationCurrency = {
  ticker: string;
  name: string;
  network: string;
  icon?: string;
  monogram?: string;
};

export const DONATION_CURRENCIES: readonly DonationCurrency[] = [
  { ticker: 'BTC', name: 'Bitcoin', network: 'Bitcoin', icon: './assets/crypto/btc.svg' },
  { ticker: 'ETH', name: 'Ethereum', network: 'Ethereum', icon: './assets/crypto/eth.svg' },
  { ticker: 'USDT', name: 'Tether', network: 'USDT', icon: './assets/crypto/usdt.svg' },
  { ticker: 'LTC', name: 'Litecoin', network: 'Litecoin', icon: './assets/crypto/ltc.svg' },
  { ticker: 'DOGE', name: 'Dogecoin', network: 'Dogecoin', icon: './assets/crypto/doge.svg' },
  { ticker: 'SOL', name: 'Solana', network: 'Solana', icon: './assets/crypto/sol.svg' },
  { ticker: 'HYPE', name: 'Hyperliquid', network: 'HyperEVM', monogram: 'H' },
  { ticker: 'XRP', name: 'XRP', network: 'XRP Ledger', icon: './assets/crypto/xrp.svg' },
  { ticker: 'TRX', name: 'TRON', network: 'TRON', monogram: 'T' },
  { ticker: 'ZEC', name: 'Zcash', network: 'Zcash', icon: './assets/crypto/zec.svg' },
  { ticker: 'XMR', name: 'Monero', network: 'Monero', icon: './assets/crypto/xmr.svg' }
];

export const USDT_NETWORKS = ['TRC20', 'BEP20', 'ERC20', 'HYPE', 'Polygon', 'Plasma', 'Arbitrum'] as const;

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
  if (!walletTitle || !walletTicker || !walletLogo || !walletMonogram || !networkField || !networkSelect || !nativeNetwork) return;
  const coinList = list!;
  const title = walletTitle;
  const tickerOutput = walletTicker;
  const logo = walletLogo;
  const monogram = walletMonogram;
  const networkPicker = networkField;
  const nativeNetworkLabel = nativeNetwork;

  function paint(ticker: string): void {
    const coin = DONATION_CURRENCIES.find(option => option.ticker === ticker);
    if (!coin) return;

    for (const button of coinList.querySelectorAll<HTMLButtonElement>('[data-donation-coin]')) {
      const selected = button.dataset.donationCoin === coin.ticker;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }

    title.textContent = coin.name;
    tickerOutput.textContent = coin.ticker;
    logo.hidden = !coin.icon;
    monogram.hidden = !coin.monogram;
    logo.alt = '';
    if (coin.icon) logo.src = coin.icon;
    if (coin.monogram) monogram.textContent = coin.monogram;

    const requiresNetwork = coin.ticker === 'USDT';
    networkPicker.hidden = !requiresNetwork;
    nativeNetworkLabel.hidden = requiresNetwork;
    if (!requiresNetwork) ui(nativeNetworkLabel, 'textContent', () => t('Native network'));
  }

  coinList.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-donation-coin]');
    if (button?.dataset.donationCoin) paint(button.dataset.donationCoin);
  });

  const initial = coinList.querySelector<HTMLButtonElement>('[data-donation-coin][aria-pressed="true"]')?.dataset.donationCoin ?? 'BTC';
  paint(initial);
}
