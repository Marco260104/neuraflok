import type { AppState } from '../../../contracts/types.js';
import { browserExtensionRequired } from '../../../contracts/types.js';
import type { AccessLevel } from '../settings/permissions.js';
import { $, el, icon } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';

interface BrowserSetup {
  render(next: AppState): { ready: boolean; choosingLocation: boolean };
}

interface SetupWizardOptions {
  getState: () => AppState | null;
  applyCurrent: () => void;
  showTab: (name: string) => void;
  browserSetup: BrowserSetup;
}

interface SetupWizardUpdate {
  next: AppState;
  missingStep: (next: AppState) => { step: string; text: string } | null;
  paintAccess: (next: AppState) => void;
  accessLevel: (next: AppState) => AccessLevel;
  accessWorks: (next: AppState) => boolean;
  addFolder: () => Promise<void>;
}

const READY_CHECKS: Record<string, { done: string; provider?: string; limited?: string }> = {
  browser: { done: 'Browser extension installed', provider: 'Provider session connected' },
  folder: { done: 'Folder shared' },
  access: { done: 'NEURAFLOK can edit files and run commands', limited: 'NEURAFLOK can only read files' }
};

export function createSetupWizard(options: SetupWizardOptions) {
  let selectedStep: string | null = null;
  let path: string[] = [];
  let openStepName: string | null = null;

  function step(name: string): HTMLElement {
    const node = document.querySelector<HTMLElement>(`[data-step="${name}"]`);
    if (node) return node;
    const fallback = document.createElement('div');
    fallback.hidden = true;
    return fallback;
  }

  function paintReady(shown: string[], done: Set<string>, allSet: boolean, access: AccessLevel, limited: boolean): void {
    ui($('readyTitle'), 'textContent', () => allSet ? t('You’re all set!') : t('Almost there'));
    ui($('readyLead'), 'textContent', () => !allSet
      ? t('Finish the steps still open below.')
      : limited
        ? t('NEURAFLOK is ready to read the folders you shared. Choose a connected provider to begin.')
        : t('NEURAFLOK is ready to work in the folders you shared. Choose a connected provider to begin.'));
    $('readyLimited').hidden = !limited;
    $('readyStart').hidden = !allSet;
    step('ready').classList.toggle('is-all-set', allSet);
    const list = $('readyChecks');
    const rows = shown.map(name => {
      const check = READY_CHECKS[name]!;
      const passed = done.has(name);
      const narrowed = name === 'access' && limited;
      const row = el('li', `ready-check${passed ? ' is-passed' : ''}${narrowed ? ' is-limited' : ''}`);
      const label = () => narrowed
        ? t(check.limited ?? (access === 'read' ? 'NEURAFLOK can only read files' : 'NEURAFLOK cannot edit files or run commands'))
        : t(name === 'browser'
          ? passed ? check.provider ?? check.done : 'Connect a provider'
          : check.done);
      if (passed) {
        row.append(icon(narrowed ? 'i-warning' : 'i-check-circle'), el('span', '', label));
      } else {
        const go = el('button', 'ready-go');
        go.setAttribute('type', 'button');
        go.append(el('span', 'ready-pending', () => t('Step {0}', [shown.indexOf(name) + 1])), el('span', '', label), icon('i-arrow-right'));
        go.addEventListener('click', () => openStep(name));
        row.append(go);
      }
      return row;
    });
    list.replaceChildren(...rows);
  }

  function openStep(name: string): void {
    selectedStep = step(name).classList.contains('is-current') ? null : name;
    if (options.getState()) options.applyCurrent();
    options.showTab('setup');
    document.querySelector('.setup-track')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function initializeNavigation(): void {
    for (const body of document.querySelectorAll<HTMLElement>('#wizard > .step > .step-body')) {
      const nav = el('div', 'step-nav');
      const back = el('button', 'btn step-back');
      back.setAttribute('type', 'button');
      back.dataset.stepNav = 'back';
      back.append(icon('i-arrow-left'), el('span', '', () => t('Back')));
      const forward = el('button', 'btn step-next');
      forward.setAttribute('type', 'button');
      forward.dataset.stepNav = 'next';
      forward.append(el('span', '', () => t('Next')), icon('i-arrow-right'));
      nav.append(back, forward);
      body.append(nav);
    }
    document.querySelector('.setup-rail')!.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-rail-step]');
      if (button) openStep(button.dataset.railStep!);
    });
    $('wizard').addEventListener('click', event => {
      const nav = (event.target as HTMLElement).closest<HTMLElement>('[data-step-nav]');
      if (!nav || openStepName === null) return;
      const next = path[path.indexOf(openStepName) + (nav.dataset.stepNav === 'next' ? 1 : -1)];
      if (next) openStep(next);
    });
  }

  function apply(update: SetupWizardUpdate): void {
    const { next } = update;
    const { config } = next;
    const browserRequired = browserExtensionRequired(config);
    const stepBrowser = step('browser');
    if (stepBrowser) stepBrowser.hidden = !browserRequired;
    const browserProgress = options.browserSetup.render(next);
    $('wizAddFolder').dataset.tone = config.roots.length > 0 ? 'ok' : 'off';
    $('wizFolders').replaceChildren(...(config.roots.length === 0
      ? [(() => {
        const row = el('li', 'is-empty');
        const pick = el('button', 'folder-empty');
        pick.setAttribute('type', 'button');
        pick.append(icon('i-folder'), el('span', '', () => t('No folder shared yet. Choose one to start.')));
        pick.addEventListener('click', () => void update.addFolder());
        row.append(pick);
        return row;
      })()]
      : config.roots.map(root => { const row = el('li'); row.append(icon('i-folder'), el('span', '', `/${root.name}`)); return row; })));
    const order = ['browser', 'folder', 'access'];
    const done = new Set<string>();
    if (config.roots.length > 0 || update.missingStep(next)?.step !== 'folder') done.add('folder');
    update.paintAccess(next);
    done.add('access');
    if (!browserRequired || browserProgress.ready) done.add('browser');
    const current = order.find(name => !done.has(name)) ?? null;
    for (const name of order) {
      const node = step(name);
      node.classList.toggle('is-done', done.has(name));
      node.classList.toggle('is-current', name === current);
    }
    const shown = order.filter(name => !step(name).hidden);
    const finished = shown.filter(name => done.has(name)).length;
    const progress = $('setupProgress');
    progress.setAttribute('aria-valuemax', String(shown.length));
    progress.setAttribute('aria-valuenow', String(finished));
    progress.classList.toggle('is-complete', finished === shown.length);
    ui($('setupProgressText'), 'textContent', () => finished === shown.length
      ? t('All {0} steps done', [shown.length])
      : t('{0} of {1} steps done', [finished, shown.length]));
    const steps = [...shown, 'ready'];
    const currentOpen = selectedStep !== null && steps.includes(selectedStep) ? selectedStep : current ?? 'ready';
    path = steps;
    openStepName = currentOpen;
    const allSet = current === null;
    for (const name of steps) {
      step(name).classList.toggle('is-open', name === currentOpen);
      const mark = step(name).querySelector<HTMLElement>('.step-mark');
      if (mark) mark.dataset.number = String(steps.indexOf(name) + 1);
    }
    step('ready').classList.toggle('is-done', allSet);
    for (const button of document.querySelectorAll<HTMLButtonElement>('.setup-rail [data-rail-step]')) {
      const name = button.dataset.railStep!;
      const item = button.closest('li')!;
      item.hidden = !steps.includes(name);
      item.classList.toggle('is-done', name === 'ready' ? allSet : done.has(name));
      item.classList.toggle('is-current', name === current);
      if (name === currentOpen) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    }
    for (const nav of document.querySelectorAll<HTMLElement>('#wizard .step-nav')) {
      const parent = nav.closest<HTMLElement>('.step');
      const name = parent?.dataset.step;
      if (!name) continue;
      const at = steps.indexOf(name);
      const back = nav.querySelector<HTMLButtonElement>('[data-step-nav="back"]');
      if (back) back.hidden = at <= 0;
      const forward = nav.querySelector<HTMLButtonElement>('[data-step-nav="next"]');
      if (forward) {
        forward.hidden = at < 0 || at === steps.length - 1;
        if (name === 'browser') forward.disabled = !browserProgress.ready;
      }
      nav.classList.toggle('is-ready', done.has(name));
      if (name === 'browser') nav.hidden = !browserProgress.choosingLocation;
    }
    paintReady(shown, done, allSet, update.accessLevel(next), !update.accessWorks(next));
  }

  initializeNavigation();
  $('readyChangeAccess').addEventListener('click', () => openStep('access'));
  $('manageComposerAccess').addEventListener('click', () => {
    $<HTMLDetailsElement>('composerAccess').open = false;
    $('readyChangeAccess').click();
  });

  return { apply, openStep, step };
}
