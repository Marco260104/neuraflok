import {
  CAPABILITIES,
  CAPABILITY_DETAILS,
  CAPABILITY_LABELS,
  DESKTOP_CAPABILITIES,
  WRITE_CAPABILITIES,
  capabilityTools,
  type AppState,
  type Capability
} from '../../../contracts/types.js';
import { $, disclosureChevron, el, icon } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';
import { createCommandPolicySettings } from './command-policy-settings.js';

export type AccessLevel = 'full' | 'files' | 'read' | 'custom';

type ActionableAccessLevel = Exclude<AccessLevel, 'custom'>;

interface PermissionGroup {
  id: string;
  title: string;
  icon: string;
  caps: Capability[];
}

interface PermissionSettingsDependencies {
  getState: () => AppState | null;
  isApplying: () => boolean;
  save: (patch?: { readOnly?: boolean }) => Promise<void>;
}

const GROUPS: PermissionGroup[] = [
  {
    id: 'read',
    title: 'Look at files',
    icon: 'i-eye',
    caps: ['browse', 'search', 'read', 'metadata']
  },
  {
    id: 'write',
    title: 'Change files',
    icon: 'i-pencil',
    caps: ['create', 'edit', 'move', 'deleteFile']
  },
  {
    id: 'desktop',
    title: 'Browser and desktop control',
    icon: 'i-monitor',
    caps: ['screen', 'control', 'clipboardRead', 'clipboardWrite']
  },
  {
    id: 'run',
    title: 'Run programs',
    icon: 'i-terminal',
    caps: ['command']
  }
];

const FILES_AND_TERMINAL = CAPABILITIES.filter(cap => !DESKTOP_CAPABILITIES.includes(cap));

export function initPermissionSettings(dependencies: PermissionSettingsDependencies) {
  const { getState,isApplying,save } = dependencies;
  const commandPolicy = createCommandPolicySettings({ isApplying, save });
  let openGroup: string | null = null;

  function groupShell(id: string, title: string, iconId: string, box: HTMLInputElement): HTMLElement {
    const root = el('div', 'perm');
    root.dataset.group = id;
    const main = document.createElement('button');
    main.className = 'perm-main';
    main.type = 'button';
    const text = el('span');
    text.append(el('b', '', () => t(title)), el('em', 'group-count'));
    main.append(disclosureChevron('ico chev'), icon(iconId), text);
    main.addEventListener('click', () => {
      openGroup = openGroup === id ? null : id;
      paintGroups();
      if (openGroup === id) root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    const sw = el('span', 'sw');
    sw.append(box, el('i'));
    const head = el('div', 'perm-head');
    head.append(main, sw);
    root.append(head);
    return root;
  }

  function toolNames(names: readonly string[]): HTMLElement {
    const row = el('div', 'tool-names');
    for (const name of names) row.append(el('code', '', name));
    return row;
  }

  function capInput(cap: Capability): HTMLInputElement {
    return document.querySelector<HTMLInputElement>(`[data-cap="${cap}"]`)!;
  }

  function buildGroups(): void {
    const permissionGroups = GROUPS.map(group => {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'group-box';
      ui(box, 'title', () => t('Turn everything in "{0}" on or off', [t(group.title)]));
      box.addEventListener('change', () => {
        for (const cap of group.caps) {
          const input = capInput(cap);
          if (!input.disabled) input.checked = box.checked;
        }
        void save();
      });
      const root = groupShell(group.id, group.title, group.icon, box);
      const tools = el('div', 'tools');
      for (const cap of group.caps) {
        const label = el('label', 'tool');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.cap = cap;
        input.addEventListener('change', () => void save());
        const body = el('span');
        body.append(el('strong', '', () => t(CAPABILITY_LABELS[cap])), el('em', '', () => t(CAPABILITY_DETAILS[cap])));
        label.append(input, body);
        tools.append(label);
      }
      tools.append(toolNames([]));
      if (group.id === 'run') tools.append(commandPolicy.build());
      root.append(tools);
      return root;
    });

    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.id = 'homeMaEnabled';
    ui(enabled, 'title', () => t('Expose or hide the sub-agent tools for connected providers'));
    enabled.addEventListener('change', () => void save());
    const agents = groupShell('agents', 'Sub-agents', 'i-agents', enabled);
    const tools = el('div', 'tools');
    const agentTools: Array<[string, string]> = [
      ['spawn', 'Open worker sessions for parts of the task, using the same project context.'],
      ['message', 'Steer one worker or several at once, or report back to prime.'],
      ['status', 'See every worker, and collect messages not yet delivered on a tool result.'],
      ['finish', 'Hand the worker result back to prime and close that slot.']
    ];
    for (const [name, detail] of agentTools) {
      const row = el('div', 'tool is-static');
      const body = el('span');
      body.append(el('strong', '', name), el('em', '', () => t(detail)));
      row.append(body);
      tools.append(row);
    }
    tools.append(toolNames(['agents']));
    agents.append(tools);
    $('groups').replaceChildren(...permissionGroups, agents);
  }

  function paintGroups(): void {
    const state = getState();
    if (!state) return;
    const { readOnly } = state.config;
    const desktopSupported = state.platform?.desktopAutomation ?? true;
    for (const group of GROUPS) {
      const root = document.querySelector<HTMLElement>(`[data-group="${group.id}"]`)!;
      root.hidden = false;
      root.classList.toggle('is-open', openGroup === group.id);
      const names = [...new Set(group.caps.flatMap(cap => capabilityTools(cap, state.platform?.family)))];
      if (group.id === 'desktop' && names.length > 0) names.push('exec');
      const namesRow = root.querySelector<HTMLElement>('.tool-names')!;
      if (Array.from(namesRow.children, child => child.textContent).join('\n') !== names.join('\n')) {
        namesRow.replaceChildren(...names.map(name => el('code', '', name)));
      }
      const usable = group.caps.filter(cap => !(readOnly && WRITE_CAPABILITIES.includes(cap)) &&
        (desktopSupported || cap !== 'clipboardRead' && cap !== 'clipboardWrite'));
      const on = group.caps.filter(cap => capInput(cap).checked);
      const box = root.querySelector<HTMLInputElement>('.group-box')!;
      box.checked = usable.length > 0 && usable.every(cap => capInput(cap).checked);
      box.indeterminate = !box.checked && on.length > 0;
      box.disabled = usable.length === 0;
      ui(root.querySelector<HTMLElement>('.group-count')!, 'textContent', () => usable.length === 0
        ? t('off in read-only mode')
        : on.length === 0
          ? 'off'
          : on.length === group.caps.length
            ? t(on.length === 1 ? '{0} permission' : '{0} permissions', [on.length])
            : t('{0} of {1} permissions', [on.length, group.caps.length]));
      root.classList.toggle('is-on', on.length > 0);
      root.classList.toggle('is-locked', usable.length === 0);
    }
    for (const cap of WRITE_CAPABILITIES) capInput(cap).disabled = readOnly;
    for (const cap of ['clipboardRead', 'clipboardWrite'] as const) {
      capInput(cap).disabled = !desktopSupported || (readOnly && WRITE_CAPABILITIES.includes(cap));
    }
    const root = document.querySelector<HTMLElement>('[data-group="agents"]');
    if (!root) return;
    const box = root.querySelector<HTMLInputElement>('.sw input')!;
    root.classList.toggle('is-open', openGroup === 'agents');
    root.classList.toggle('is-on', box.checked);
    ui(root.querySelector<HTMLElement>('.group-count')!, 'textContent', () => t(box.checked ? 'agents tool exposed' : 'off'));
  }

  function paintDesktopAccess(next: AppState): void {
    const box = $('desktopAccess');
    const access = next.desktopAccess;
    const needsScreen = next.config.capabilities.screen;
    const needsAccessibility = next.config.capabilities.control && !next.config.readOnly;
    if (next.platform?.family !== 'macos' || (!needsScreen && !needsAccessibility) || !access) {
      box.hidden = true;
      return;
    }
    const missing: string[] = [];
    if (needsScreen && access.screen !== 'granted') missing.push(t('Screen Recording: {0}', [access.screen]));
    if (needsAccessibility && access.accessibility !== 'granted') missing.push(t('Accessibility: {0}', [access.accessibility]));
    box.hidden = missing.length === 0;
    if (box.hidden) return;
    ui($('desktopAccessTitle'), 'textContent', () => t('Desktop access needs attention'));
    ui($('desktopAccessDetail'), 'textContent', () => t('{0}. These are live checks from the NEURAFLOK desktop service. ', [missing.join(' · ')]) +
      t('Grant the missing macOS permission, then fully quit and reopen the app.'));
    $<HTMLButtonElement>('openDesktopScreen').hidden = !needsScreen || access.screen === 'granted';
    $<HTMLButtonElement>('openDesktopAccessibility').hidden = !needsAccessibility || access.accessibility === 'granted';
    $<HTMLButtonElement>('requestDesktopAccessibility').hidden = !needsAccessibility || access.accessibility === 'granted';
  }

  function toolsOn(next: AppState): number {
    const { config, platform } = next;
    const desktopSupported = platform?.desktopAutomation ?? true;
    const enabled = CAPABILITIES.filter(capability => config.capabilities[capability] &&
      !(config.readOnly && WRITE_CAPABILITIES.includes(capability)) &&
      (desktopSupported || capability !== 'clipboardRead' && capability !== 'clipboardWrite'));
    return new Set(enabled.flatMap(capability => capabilityTools(capability, platform?.family))).size;
  }

  function hostDesktopCapabilities(next: AppState): Capability[] {
    const native = next.platform?.desktopAutomation ?? true;
    return DESKTOP_CAPABILITIES.filter(cap => native || cap === 'screen' || cap === 'control');
  }

  function accessLevel(next: AppState): AccessLevel {
    const { config } = next;
    if (config.readOnly) return 'read';
    if (!FILES_AND_TERMINAL.every(cap => config.capabilities[cap])) return 'custom';
    const desktop = hostDesktopCapabilities(next);
    if (desktop.every(cap => config.capabilities[cap])) return 'full';
    return desktop.some(cap => config.capabilities[cap]) ? 'custom' : 'files';
  }

  function accessWorks(next: AppState): boolean {
    const { config } = next;
    return !config.readOnly && config.capabilities.create && config.capabilities.edit && config.capabilities.command;
  }

  function chooseAccess(level: Exclude<AccessLevel, 'custom'>): void {
    const state = getState();
    if (!state) return;
    if (level !== 'read') {
      const desktop = hostDesktopCapabilities(state);
      for (const cap of FILES_AND_TERMINAL) capInput(cap).checked = true;
      for (const cap of DESKTOP_CAPABILITIES) capInput(cap).checked = level === 'full' && desktop.includes(cap);
    }
    void save({ readOnly: level === 'read' });
  }

  function bindAccessChoiceKeyboard(container: Element | null, optionSelector: string): void {
    container?.addEventListener('keydown', event => {
      const key = (event as KeyboardEvent).key;
      const move = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0;
      if (!move) return;
      event.preventDefault();
      const options = [...document.querySelectorAll<HTMLButtonElement>(optionSelector)];
      if (options.length === 0) return;
      const at = options.indexOf(document.activeElement as HTMLButtonElement);
      const target = options[(Math.max(at, 0) + move + options.length) % options.length]!;
      target.focus();
      target.click();
    });
  }

  function bindAccessChoiceControls(): void {
    for (const option of document.querySelectorAll<HTMLButtonElement>('[data-access]')) {
      option.addEventListener('click', () => {
        chooseAccess(option.dataset.access as ActionableAccessLevel);
        if (!option.closest('#composerAccess')) return;
        $<HTMLDetailsElement>('composerAccess').open = false;
        $<HTMLElement>('composerAccessTrigger').focus();
      });
    }
    bindAccessChoiceKeyboard(document.querySelector('.access-choice'), '.access-choice [data-access]');
    bindAccessChoiceKeyboard($('composerAccessChoice'), '#composerAccessChoice [data-access]');
  }

  function paintAccess(next: AppState): void {
    const level = accessLevel(next);
    for (const option of document.querySelectorAll<HTMLButtonElement>('[data-access]')) {
      const on = option.dataset.access === level;
      option.setAttribute('aria-checked', String(on));
      option.tabIndex = on || (level === 'custom' && option.dataset.access === 'full') ? 0 : -1;
    }
    const composerLabel = level === 'full' ? t('Full access')
      : level === 'files' ? t('Files and terminal')
        : level === 'read' ? t('Read only') : t('Custom permissions, set in Workspace.');
    $('composerAccessLabel').textContent = composerLabel;
    $('composerAccessTrigger').setAttribute('aria-label', `${t('Access')}: ${composerLabel}`);
    $('composerAccessTrigger').setAttribute('title', `${t('Access')}: ${composerLabel}`);
    $('composerAccessStatus').hidden = level !== 'custom';
    $('accessRecovered').hidden = !next.settingsRecovered;
    const access = next.desktopAccess;
    const macConsent = next.platform?.family === 'macos' && level === 'full' && !!access &&
      (access.screen !== 'granted' || access.accessibility !== 'granted');
    const note = $('accessNote');
    const text = () => level === 'read'
      ? t('The selected provider can only read files. Choose another option to allow edits and commands.')
      : level === 'custom'
        ? accessWorks(next)
          ? t('Custom permissions, set in Workspace.')
          : t('These permissions prevent the selected provider from editing files or running commands. Change them above or in Workspace.')
        : macConsent
          ? t('On macOS, desktop control also needs Screen Recording and Accessibility in System Settings.')
          : '';
    note.hidden = text() === '';
    note.classList.toggle('is-warn', !accessWorks(next) || macConsent);
    ui(note, 'textContent', text);
  }

  return {
    accessLevel,
    accessWorks,
    bindAccessChoiceControls,
    buildGroups,
    chooseAccess,
    paintAccess,
    paintCommandPolicyMode: commandPolicy.paintMode,
    paintDesktopAccess,
    paintGroups,
    readCommandAllowlist: commandPolicy.readAllowlist,
    toolsOn
  };
}
