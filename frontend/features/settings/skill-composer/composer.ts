import type { LibrarySkill, SkillLibrary } from '../../../../contracts/skills.js';
import type { ComposerCommand, SkillChoice, SkillComposerOptions } from './contracts.js';
import { COMPOSER_COMMAND_PROJECTION, skillCompletion, splitSkillDraft } from './command-completion.js';
import { renderSkillChoices } from './choices-view.js';
import { renderSelectedSkills } from './selected-view.js';

export function initSkills(options: SkillComposerOptions) {
  const { input, host, selectedHost } = options;
  host.className = 'skill-autocomplete';
  host.setAttribute('role', 'listbox');
  const cache = new Map<string, SkillLibrary>();
  let epoch = 0;
  let surfaceOwner = '';
  let loadedKey: string | null = null;
  let loading = false;
  let error = '';
  let composing = false;
  let library: SkillLibrary | null = null;
  let choices: SkillChoice[] = [];
  let selected = 0;
  let painted = '';
  let displayedPrefix = '';
  let prefixOwner = options.owner();

  const scopeKey = (): string => JSON.stringify(options.scope());
  const selectionKey = (): string => `${input.value}\0${input.selectionStart}\0${input.selectionEnd}`;
  const authoredText = (): string => (prefixOwner === options.owner() ? displayedPrefix : '') + input.value;
  const fragment = () => skillCompletion(input.value, input.selectionStart, input.selectionEnd);
  const current = (): boolean => surfaceOwner === options.owner();
  const hideInline = (): void => {
    host.hidden = true;
    choices = [];
    input.removeAttribute('aria-controls');
    input.removeAttribute('aria-expanded');
    input.removeAttribute('aria-activedescendant');
  };
  const close = (): void => {
    epoch++;
    loading = false;
    loadedKey = null;
    hideInline();
    if (prefixOwner !== options.owner()) {
      selectedHost.replaceChildren();
      selectedHost.hidden = true;
    }
  };
  const renderSelected = (): void => {
    const owner = options.owner();
    const ids = splitSkillDraft(owner === prefixOwner ? displayedPrefix : '').ids;
    renderSelectedSkills(selectedHost, ids, cache.get(scopeKey()) ?? null, id => {
      if (owner !== options.owner()) return;
      const retained = splitSkillDraft(displayedPrefix).ids.filter(value => value !== id);
      project(`${retained.map(value => `/${value}\n`).join('')}${input.value}`);
      input.focus();
    });
  };
  const restore = (): void => {
    close();
    const draft = splitSkillDraft(options.draft() ?? input.value);
    displayedPrefix = draft.prefix;
    prefixOwner = options.owner();
    input.value = draft.body;
    renderSelected();
  };
  const project = (authored: string, source: 'authored' | 'command' = 'authored'): void => {
    options.saveDraft(authored);
    const draft = splitSkillDraft(authored);
    displayedPrefix = draft.prefix;
    prefixOwner = options.owner();
    input.value = draft.body;
    renderSelected();
    input.setSelectionRange(input.value.length, input.value.length);
    const view = input.ownerDocument.defaultView!;
    input.dispatchEvent(source === 'command'
      ? new view.CustomEvent('input', { bubbles: true, detail: COMPOSER_COMMAND_PROJECTION })
      : new view.Event('input', { bubbles: true }));
  };
  const choose = (skill: SkillChoice): void => {
    if ('command' in skill) {
      const range = fragment();
      if (!current() || !range || painted !== selectionKey() || composing) { close(); return; }
      const text = range ? input.value.slice(0, range.start) + input.value.slice(range.end) : input.value;
      const authored = (prefixOwner === options.owner() ? displayedPrefix : '') + text;
      if (options.deferCommand?.(skill.command)) {
        const draft = splitSkillDraft(authored);
        const prefix = draft.ids.includes(skill.command) ? draft.prefix
          : `${draft.prefix}${draft.prefix && !/\s$/.test(draft.prefix) ? '\n' : ''}/${skill.command}\n`;
        close();
        project(prefix + draft.body);
        input.focus();
        return;
      }
      close();
      project(authored, 'command');
      options.command?.(skill.command);
      input.focus();
      return;
    }
    if (!current() || composing) { close(); return; }
    const range = fragment();
    if (!range || painted !== selectionKey()) { close(); return; }
    const text = range ? input.value.slice(0, range.start) + input.value.slice(range.end).replace(/^\s+/, '') : input.value;
    const draft = splitSkillDraft((prefixOwner === options.owner() ? displayedPrefix : '') + text);
    const prefix = draft.ids.includes(skill.id) ? draft.prefix
      : `${draft.prefix}${draft.prefix && !/\s$/.test(draft.prefix) ? '\n' : ''}/${skill.id}\n`;
    close();
    project(prefix + draft.body);
    input.focus();
  };
  const filtered = (query: string): LibrarySkill[] => {
    const needle = query.trim().toLocaleLowerCase();
    return (library?.skills ?? []).filter(skill => `${skill.id} ${skill.displayName || skill.name} ${skill.description} ${skill.scope}`.toLocaleLowerCase().includes(needle));
  };
  const paintInline = (): void => {
    if (!current() || composing) { hideInline(); return; }
    const range = fragment();
    if (!range) { hideInline(); return; }
    const query = range.query;
    const commandChoices: ComposerCommand[] = options.command ? [
      { command: 'plan', name: 'Plan', description: 'Turn the next composer request into editable stages.', glyph: 'i-steps' },
      { command: 'goal', name: 'Goal', description: 'Pursue a saved objective and stop when it is complete.', glyph: 'i-target' },
      { command: 'loop', name: 'Loop', description: 'Keep continuing toward the saved objective.', glyph: 'i-loop' },
      { command: 'compact', name: 'Compact', description: 'Compact this chat and resume it in a fresh conversation.', glyph: 'i-copy' }
    ].filter(row => row.command.includes(query) && (options.commandAvailable?.(row.command) ?? true)) : [];
    const matchingSkills = loading && !library ? [] : filtered(query).slice(0, 64);
    choices = [...commandChoices, ...matchingSkills];
    selected = Math.min(selected, Math.max(0, choices.length - 1));
    painted = selectionKey();
    const exact = query && !loading && !commandChoices.some(row => row.command === query)
      ? library?.skills.find(skill => skill.id.toLocaleLowerCase() === query)
      : undefined;
    const hasLongerId = exact && library?.skills.some(skill => {
      const id = skill.id.toLocaleLowerCase();
      return id !== query && id.startsWith(query);
    });
    if (exact && !hasLongerId) { choose(exact); return; }
    renderSkillChoices({
      host,
      input,
      choices,
      selected,
      commandCount: commandChoices.length,
      query,
      loading,
      error,
      library,
      renderEpoch: epoch,
      renderOwner: options.owner(),
      renderSelection: selectionKey(),
      owner: options.owner,
      selection: selectionKey,
      epoch: () => epoch,
      choose
    });
  };
  const load = async (): Promise<void> => {
    const request = ++epoch;
    const owner = options.owner();
    const scope = options.scope();
    const key = JSON.stringify(scope);
    surfaceOwner = owner;
    loadedKey = key;
    loading = true;
    error = '';
    library = cache.get(key) ?? null;
    paintInline();
    try {
      const result = await options.list(scope);
      if (request !== epoch || owner !== options.owner() || scopeKey() !== key) return;
      if (!result.ok) error = result.error;
      else {
        library = result.data;
        cache.delete(key);
        cache.set(key, library);
        while (cache.size > 12) cache.delete(cache.keys().next().value!);
      }
    } catch (failure) {
      if (request === epoch && current()) error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      if (request === epoch && current()) { loading = false; paintInline(); renderSelected(); }
    }
  };
  const update = (): void => {
    options.saveDraft(authoredText());
    if (composing) return;
    if (!fragment()) { hideInline(); loadedKey = null; return; }
    selected = 0;
    if (loadedKey !== scopeKey() || !current()) void load();
    else paintInline();
  };

  input.addEventListener('compositionstart', () => { composing = true; hideInline(); });
  for (const [button, add] of [[options.openButton, false], [options.addButton, true]] as const) {
    button.addEventListener('click', event => {
      event.stopPropagation();
      const menu = button.closest('details');
      if (menu) menu.open = false;
      if (add) {
        const range = fragment();
        const text = range ? input.value.slice(0, range.start) + input.value.slice(range.end) : input.value;
        close();
        project((prefixOwner === options.owner() ? displayedPrefix : '') + `Please add the following skills to my NEURAFLOK skills:\n${text}`);
      } else {
        input.setRangeText(input.value ? '/\n' : '/', 0, 0, 'start');
        input.setSelectionRange(1, 1);
        input.dispatchEvent(new input.ownerDocument.defaultView!.Event('input', { bubbles: true }));
      }
      input.focus();
    });
  }
  input.addEventListener('compositionend', () => { composing = false; update(); });
  input.addEventListener('input', event => { if ((event as InputEvent).isComposing) { hideInline(); return; } update(); });
  input.addEventListener('click', () => { if (!host.hidden) paintInline(); });
  document.addEventListener('click', event => {
    if (!host.contains(event.target as Node) && event.target !== input) hideInline();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.isComposing && !host.hidden) { hideInline(); input.focus(); }
  });
  const hasCommand = (name: string): boolean => splitSkillDraft(prefixOwner === options.owner() ? displayedPrefix : '').ids.includes(name);
  const removeCommand = (name: string): void => {
    if (prefixOwner !== options.owner()) return;
    const retained = splitSkillDraft(displayedPrefix).ids.filter(value => value !== name);
    project(`${retained.map(value => `/${value}\n`).join('')}${input.value}`);
  };
  return {
    close,
    restore,
    authoredText,
    hasCommand,
    removeCommand,
    keydown: (event: KeyboardEvent): boolean => {
      if (host.hidden || !current() || composing || event.isComposing) return false;
      if (!fragment() || painted !== selectionKey()) { hideInline(); return false; }
      if (event.key === 'Escape') { hideInline(); event.preventDefault(); return true; }
      if (!choices.length || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        selected = (selected + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length;
        paintInline();
      } else if (event.key === 'Enter' || event.key === 'Tab') choose(choices[selected]!);
      else return false;
      event.preventDefault();
      return true;
    }
  };
}
