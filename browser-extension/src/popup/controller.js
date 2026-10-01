const $ = (id) => document.getElementById(id);
const i18n = globalThis.NEURAFLOK_I18N;
const t = (key, values = []) => i18n?.t(key, values) || key;
const PROVIDERS = {
  deepseek: { name: 'DeepSeek', key: 'DeepSeek', mark: 'DS', patterns: ['https://chat.deepseek.com/*'], url: 'https://chat.deepseek.com/' },
  kimi: { name: 'Kimi', key: 'Kimi', mark: 'K', patterns: ['https://kimi.com/*', 'https://www.kimi.com/*'], url: 'https://www.kimi.com/en/' },
  qwen: { name: 'Qwen', key: 'Qwen', mark: 'Q', patterns: ['https://chat.qwen.ai/*'], url: 'https://chat.qwen.ai/' },
  glm: { name: 'Z AI', key: 'Glm', mark: 'Z', patterns: ['https://z.ai/*', 'https://chat.z.ai/*', 'https://chatglm.cn/*', 'https://www.chatglm.cn/*'], url: 'https://z.ai/chat' }
};

let refreshGeneration = 0;
let latest = { status: null, tab: null };

function paintConnection(status) {
  const root = $('bridgeState');
  const connected = status?.connected === true;
  const paired = status?.paired === true;
  const compatible = status?.compatible !== false;
  const ready = connected && paired && compatible;
  const deliberatelyOff = status?.disconnected === true;
  const state = !compatible
    ? t('stateMismatch')
    : ready
      ? t('stateActive')
      : deliberatelyOff
        ? t('statePaused')
        : !connected
          ? t('stateSearching')
          : t('statePreparing');

  root.dataset.state = !compatible ? 'error' : ready ? 'active' : deliberatelyOff ? 'problem' : 'checking';
  $('state').textContent = state;
  $('port').textContent = connected && status.port ? `127.0.0.1:${status.port}` : '';
  $('appHint').hidden = ready || !connected && deliberatelyOff;
  $('appHint').textContent = !compatible
    ? t('mismatchHint')
    : t('appHint');
  $('retryBtn').hidden = ready || !connected || !compatible;
  $('retryBtn').textContent = deliberatelyOff ? t('connect') : t('retry');

  const error = !compatible
    ? t('versionMismatchDetails', [status.appVersion || '?', status.extensionVersion || '?', status.appProtocol ?? '?', status.extensionProtocol ?? '?'])
    : status?.pairError?.message || '';
  $('alert').textContent = error;
  $('alert').hidden = !error;
  $('appVersion').textContent = status?.appVersion ? `v${status.appVersion}` : '—';
  $('extensionVersion').textContent = status?.extensionVersion ? `v${status.extensionVersion}` : '—';
  $('pendingCount').textContent = Number.isFinite(status?.pending) ? String(status.pending) : '—';
  $('footerState').textContent = ready ? t('secureReady') : t('footerAuto');
  return ready;
}

function paintProviders(tab) {
  const current = typeof tab?.provider === 'string' && PROVIDERS[tab.provider] ? tab.provider : null;
  const presence = tab?.webProviders && typeof tab.webProviders === 'object' ? tab.webProviders : {};
  let activeCount = 0;

  for (const [id, provider] of Object.entries(PROVIDERS)) {
    const item = presence[id] || {};
    const row = document.querySelector(`[data-provider="${id}"]`);
    const label = $(`provider${provider.key}Status`);
    const isReady = item.signedIn === true;
    const needsLogin = item.open === true && item.signedIn === false;
    if (isReady) activeCount += 1;
    row.dataset.state = isReady ? 'ready' : needsLogin ? 'login' : item.open ? 'checking' : 'off';
    row.dataset.active = String(current === id);
    label.textContent = isReady ? t('sessionActive') : needsLogin ? t('signIn') : item.open ? t('checking') : t('notDetected');
    row.querySelector('[data-open-provider]')?.setAttribute('aria-label', `${t('open')} ${provider.name}`);
  }
  $('providerCount').textContent = t('providerCount', [activeCount, 4]);

  const active = current ? PROVIDERS[current] : null;
  const page = tab?.page;
  $('activeMark').textContent = active?.mark || 'NF';
  $('activeProvider').textContent = active?.name || t('noProvider');
  $('activeLabel').textContent = !active
    ? t('noSession')
    : page?.generating
      ? t('responding')
      : page?.signedIn === true
        ? t('sessionActive')
        : t('signIn');
  $('activeDetail').textContent = !active
    ? t('openSupported')
    : page?.signedIn === true
      ? tab?.conversationId ? t('sessionDetail', [tab.conversationId.slice(0, 10)]) : t('signedInTab')
      : t('signInProvider');
  $('thinkingIndicator').hidden = !(active && page?.generating === true);
}

async function refresh() {
  const generation = ++refreshGeneration;
  try {
    const [status, tab] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'status' }),
      chrome.runtime.sendMessage({ type: 'tabStatus' })
    ]);
    if (generation !== refreshGeneration) return;
    latest = { status, tab };
    paintConnection(status);
    paintProviders(tab);
  } catch {
    if (generation !== refreshGeneration) return;
    $('bridgeState').dataset.state = 'error';
    $('state').textContent = t('queryFailed');
    $('port').textContent = '';
    $('appHint').hidden = false;
    $('appHint').textContent = t('checkOpen');
    $('footerState').textContent = t('footerAuto');
  }
}

async function openProvider(id) {
  const provider = PROVIDERS[id];
  if (!provider) return;
  let result;
  try {
    result = await chrome.runtime.sendMessage({ type: 'open_provider', provider: id });
  } catch (error) {
    const detail = String(error && error.message ? error.message : error || '')
      .replace(/\s+/g, ' ').trim().slice(0, 180);
    throw new Error(t('openFailed', [provider.name, t('integratedUnresponsive') + (detail ? ' ' + detail : '')]));
  }
  if (result?.ok !== true) {
    const labels = {
      popup_required: t('popupRequired'),
      unsupported_provider: t('unsupportedProvider'),
      activate_failed: t('activateFailed'),
      focus_failed: t('focusFailed'),
      tab_id_unavailable: t('tabUnknown'),
      open_failed: t('openRejected')
    };
    const label = labels[result?.error] || t('navigationError');
    const detail = typeof result?.detail === 'string' ? result.detail.slice(0, 180) : '';
    throw new Error(t('openFailed', [provider.name, detail ? label + ' ' + detail : label]));
  }
  $('footerState').textContent = t('providerOpened', [provider.name]);
}

$('refreshBtn').addEventListener('click', () => void refresh());
$('retryBtn').addEventListener('click', async () => {
  const button = $('retryBtn');
  button.disabled = true;
  try { await chrome.runtime.sendMessage({ type: 'pair' }); } catch { /* Refresh reports the failure. */ }
  button.disabled = false;
  await refresh();
});
for (const button of document.querySelectorAll('[data-open-provider]')) {
  button.addEventListener('click', () => {
    const id = button.dataset.openProvider;
    const provider = PROVIDERS[id];
    button.disabled = true;
    void openProvider(id).catch((error) => {
      const detail = String(error && error.message ? error.message : error || 'Error de navegación')
        .replace(/\s+/g, ' ').trim().slice(0, 220);
      $('footerState').textContent = detail;
    }).finally(() => { button.disabled = false; });
  });
}

setInterval(() => void refresh(), 4000);
void i18n?.ready?.then(() => {
  i18n.localizeDocument();
  void refresh();
});
globalThis.addEventListener?.('neuraflok-language-changed', () => {
  i18n?.localizeDocument();
  void refresh();
});
