import { $ } from '../../shared/dom.js';
import { setLegalReturnToSettings } from './legal-view.js';

interface QuickSettingsDependencies {
  showTab: (name: string) => void;
}

function settingsScreenOpen(): boolean {
  return document.querySelector<HTMLElement>('.app')?.dataset.screen === 'settings';
}

function paintGear(selected: boolean, expanded: boolean): void {
  const gear = $('workspaceSettings');
  gear.classList.toggle('is-sel', selected);
  gear.setAttribute('aria-expanded', String(expanded));
}

export function initQuickSettings(dependencies: QuickSettingsDependencies): { open(): void; close(): void; sync(): void } {
  const dialog = document.getElementById('quickSettingsDialog') as HTMLDialogElement;
  const themeSelect = $('appearanceTheme') as HTMLSelectElement;
  const follow = document.getElementById('followOutput') as HTMLInputElement | null;
  const quickFollow = document.getElementById('quickFollowOutput') as HTMLInputElement;
  let mirroringFollow = false;

  function syncThemeButtons(): void {
    const theme = themeSelect.value;
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('[data-quick-theme]')) {
      button.setAttribute('aria-pressed', String(button.dataset.quickTheme === theme));
    }
  }

  function syncFollow(): void {
    if (!follow) return;
    quickFollow.checked = follow.checked;
  }

  function sync(): void {
    syncThemeButtons();
    syncFollow();
  }

  function showPane(name: string): void {
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('[data-quick-pane]')) {
      button.setAttribute('aria-current', button.dataset.quickPane === name ? 'page' : 'false');
    }
    for (const view of dialog.querySelectorAll<HTMLElement>('[data-quick-view]')) {
      view.hidden = view.dataset.quickView !== name;
    }
  }

  function close(): void {
    if (dialog.open) dialog.close();
    paintGear(settingsScreenOpen(), false);
  }

  function open(): void {
    sync();
    showPane('general');
    if (!dialog.open) dialog.showModal();
    paintGear(true, true);
  }

  setLegalReturnToSettings(open);

  $('workspaceSettings').addEventListener('click', () => {
    if (dialog.open) close();
    else open();
  });

  dialog.addEventListener('click', event => {
    if (event.target === dialog) {
      close();
      return;
    }
    const pane = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-quick-pane]');
    if (pane?.dataset.quickPane) {
      showPane(pane.dataset.quickPane);
      return;
    }
    const theme = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-quick-theme]');
    if (theme?.dataset.quickTheme) {
      themeSelect.value = theme.dataset.quickTheme;
      themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      syncThemeButtons();
      return;
    }
    const go = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-settings-go]');
    if (!go?.dataset.settingsGo) return;
    close();
    dependencies.showTab(go.dataset.settingsGo);
  });

  dialog.addEventListener('close', () => {
    paintGear(settingsScreenOpen(), false);
  });

  themeSelect.addEventListener('change', syncThemeButtons);

  if (follow) {
    follow.addEventListener('change', () => {
      if (mirroringFollow) return;
      mirroringFollow = true;
      quickFollow.checked = follow.checked;
      mirroringFollow = false;
    });
    quickFollow.addEventListener('change', () => {
      if (mirroringFollow) return;
      mirroringFollow = true;
      follow.checked = quickFollow.checked;
      follow.dispatchEvent(new Event('change', { bubbles: true }));
      mirroringFollow = false;
    });
  }

  return { open, close, sync };
}
