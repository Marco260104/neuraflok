import type { SettingsPatch } from '../../../backend/preload/index.js';
import { parseCommandAllowlistText } from '../../../contracts/command-allowlist/rules.js';
import { $, el } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';

interface CommandPolicySettingsDependencies {
  isApplying: () => boolean;
  save: () => Promise<void>;
}

export function createCommandPolicySettings(dependencies: CommandPolicySettingsDependencies) {
  const { isApplying, save } = dependencies;

  function readMode(): 'allow' | 'deny' {
    return document.getElementById('commandPolicyDeny')?.getAttribute('aria-checked') === 'true' ? 'deny' : 'allow';
  }

  function paintMode(mode: 'allow' | 'deny'): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-command-policy-mode]')) {
      const selected = button.dataset.commandPolicyMode === mode;
      button.setAttribute('aria-checked', String(selected));
      button.classList.toggle('is-sel', selected);
    }
    $('commandPolicyRulesLabel').textContent = t(mode === 'deny'
      ? 'Blocked commands (one rule per line)'
      : 'Allowed commands (one rule per line)');
    $('commandPolicyDescription').textContent = t(mode === 'deny'
      ? 'Commands matching any of these rules may not start.'
      : 'Only commands matching one of these rules may start.');
  }

  function readAllowlist(): SettingsPatch['commandAllowlist'] | null {
    const parsed = parseCommandAllowlistText($<HTMLTextAreaElement>('commandAllowlistRules').value);
    const error = $('commandAllowlistError');
    const first = parsed.issues[0];
    error.textContent = first ? t('Line {0}: {1}', [first.line, first.message]) : '';
    error.hidden = !first;
    return first ? null : {
      enabled: $<HTMLInputElement>('commandAllowlistEnabled').checked,
      mode: readMode(),
      rules: parsed.rules
    };
  }

  function build(): HTMLElement {
    const section = el('div', 'command-allowlist');
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.id = 'commandAllowlistEnabled';
    const toggle = el('label', 'tool command-allowlist-toggle');
    const body = el('span');
    const description = el('em');
    description.id = 'commandPolicyDescription';
    body.append(el('strong', '', () => t('Limit command launches')), description);
    toggle.append(enabled, body);

    const mode = el('div', 'seg command-policy-mode');
    mode.id = 'commandPolicyMode';
    mode.setAttribute('role', 'radiogroup');
    ui(mode, 'aria-label', () => t('Command policy mode'));
    for (const [value, text] of [['allow', 'Allowlist'], ['deny', 'Denylist']] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = value === 'allow' ? 'commandPolicyAllow' : 'commandPolicyDeny';
      button.dataset.commandPolicyMode = value;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(value === 'allow'));
      button.classList.toggle('is-sel', value === 'allow');
      ui(button, 'textContent', () => t(text));
      button.addEventListener('click', () => {
        paintMode(value);
        if (!isApplying()) void save();
      });
      mode.append(button);
    }

    const label = el('label', 'command-allowlist-label');
    label.id = 'commandPolicyRulesLabel';
    label.setAttribute('for', 'commandAllowlistRules');
    const rules = document.createElement('textarea');
    rules.id = 'commandAllowlistRules';
    rules.rows = 5;
    rules.placeholder = 'git status\ngit diff *\ndotnet build *\ndotnet test *';
    const help = el('p', 'hint', () => t('Use an exact command or a trailing standalone * for additional arguments. Compound shell syntax is rejected. Allowed programs and their child processes remain trusted; this is not an OS sandbox.'));
    const error = el('p', 'command-allowlist-error');
    error.id = 'commandAllowlistError';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const changed = (): void => { if (!isApplying()) void save(); };
    enabled.addEventListener('change', changed);
    rules.addEventListener('change', changed);
    rules.addEventListener('input', () => readAllowlist());
    ui(description, 'textContent', () => t(readMode() === 'deny'
      ? 'Commands matching any of these rules may not start.'
      : 'Only commands matching one of these rules may start.'));
    ui(label, 'textContent', () => t(readMode() === 'deny'
      ? 'Blocked commands (one rule per line)'
      : 'Allowed commands (one rule per line)'));
    section.append(toggle, mode, label, rules, help, error);
    return section;
  }

  return { build, paintMode, readAllowlist };
}
