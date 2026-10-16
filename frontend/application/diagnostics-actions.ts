import type { AppApi } from '../../backend/preload/index.js';
import type { AppState } from '../../contracts/types.js';
import type { createProviderStatusView } from '../features/settings/provider-status-view.js';
import { $, el, run, toast } from '../shared/dom.js';
import { t, ui } from '../shared/i18n.js';

interface DiagnosticsActionsDependencies {
  api: AppApi;
  getState: () => AppState | null;
  apply: (state: AppState) => void;
  providerStatusView: ReturnType<typeof createProviderStatusView>;
}

export function initDiagnosticsActions(dependencies: DiagnosticsActionsDependencies): void {
  const { api, getState, apply, providerStatusView } = dependencies;

  async function runChecks(): Promise<void> {
    const button = $<HTMLButtonElement>('runChecks');
    button.disabled = true;
    ui($('runChecksLabel'), 'textContent', () => t('Checking…'));
    try {
      const state = getState();
      if (!state) return;
      const result = providerStatusView.checks(state);
      ui($('checksSummary'), 'textContent', () => t(result.summary));
      $('checkList').replaceChildren(
        ...result.checks.map(check => {
          const li = el(
            'li',
            check.status === 'pass'
              ? 'check is-ok'
              : check.status === 'fail'
                ? 'check is-bad'
                : `check is-${check.status}`
          );
          const mark = el(
            'span',
            'check-mark',
            check.status === 'pass' ? '✓' : check.status === 'fail' ? '!' : check.status === 'skipped' ? '–' : '…'
          );
          const body = el('div');
          body.append(el('strong', '', () => t(check.name)), el('p', '', () => t(check.detail)));
          li.append(mark, body);
          return li;
        })
      );
      $('checksBox').hidden = false;
      $('checksBox').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } finally {
      button.disabled = false;
      ui($('runChecksLabel'), 'textContent', () => t('Run checks'));
    }
  }

  $('runChecks').addEventListener('click', () => void runChecks());
  $('requestDesktopAccessibility').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('requestDesktopAccessibility');
    button.disabled = true;
    try {
      const next = await run(api.requestDesktopAccessibility());
      if (next) apply(next);
    } finally {
      button.disabled = false;
    }
  });
  $('closeChecks').addEventListener('click', () => {
    $('checksBox').hidden = true;
  });
  for (const id of ['copyLog', 'copyLogText']) {
    $(id).addEventListener('click', async () => {
      const text = await run(api.getLogText());
      if (text === null) return;
      const copied = await run(api.writeClipboard(text));
      if (copied) toast(t('Activity copied'));
    });
  }
  $('saveDiagnosticsReport').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('saveDiagnosticsReport');
    button.disabled = true;
    try {
      const result = await run(api.saveDiagnosticsReport());
      if (result?.saved) toast(t('Diagnostics report saved as {0}. Read it before you share it.', [result.name]));
    } finally {
      button.disabled = false;
    }
  });
  $('copyLogJson').addEventListener('click', async () => {
    const text = await run(api.getLogJson());
    if (text === null) return;
    const copied = await run(api.writeClipboard(text));
    if (copied) toast(t('Activity JSON copied'));
  });
}
