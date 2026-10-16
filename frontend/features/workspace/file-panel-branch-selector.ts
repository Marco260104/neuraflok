import type { LocalProject } from '../../../contracts/workspace/projects.js';
import type { ProjectGitSnapshot } from '../../../contracts/workspace/project-git.js';
import { el, icon } from '../../shared/dom.js';
import { t } from '../../shared/i18n.js';

interface Runtime {
  project(): LocalProject | null;
  snapshot(): ProjectGitSnapshot | null;
  selectedBaseRef(): string | null;
  selectBaseRef(ref: string | null): void;
}

export function installFileBranchSelector(trigger: HTMLButtonElement, runtime: Runtime) {
  let menu: HTMLElement | null = null;

  function close(restoreFocus = false): void {
    if (!menu) return;
    const leaving = menu;
    menu = null;
    leaving.inert = true;
    leaving.classList.add('is-leaving');
    const motion = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches && typeof leaving.animate === 'function';
    if (motion) void leaving.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-4px)' }], { duration: 120, easing: 'ease-in' })
      .finished.catch(() => undefined).then(() => leaving.remove());
    else leaving.remove();
    document.removeEventListener('pointerdown', dismiss, true);
    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('resize', dismissOnResize);
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus();
  }

  function dismiss(event: PointerEvent): void {
    if (menu && !menu.contains(event.target as Node) && !trigger.contains(event.target as Node)) close();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
  }

  function dismissOnResize(): void { close(); }

  trigger.addEventListener('click', () => {
    if (menu) { close(); return; }
    const project = runtime.project();
    const snapshot = runtime.snapshot();
    if (!project || (snapshot?.state !== 'ready' && !runtime.selectedBaseRef())) return;
    const next = el('div', 'file-branch-menu');
    next.setAttribute('role', 'dialog');
    next.setAttribute('aria-label', t('Compare branches'));
    const search = el('input', 'file-branch-search') as HTMLInputElement;
    search.type = 'search'; search.placeholder = t('Search branches…');
    search.setAttribute('aria-label', t('Search branches…'));
    const items = el('div', 'file-branch-items');
    const renderItems = (): void => {
      items.replaceChildren();
      const query = search.value.trim().toLocaleLowerCase();
      const choices = [{ ref: '', label: t('Working tree') }, ...(runtime.snapshot()?.branches ?? [])];
      for (const choice of choices.filter(entry => entry.label.toLocaleLowerCase().includes(query))) {
        const option = el('button', 'file-branch-option') as HTMLButtonElement;
        option.type = 'button';
        if (choice.ref.startsWith('refs/remotes/')) option.title = t('Locally cached remote branch; no automatic fetch');
        option.append(el('span', '', choice.label));
        if (choice.ref === (runtime.selectedBaseRef() ?? '')) option.append(icon('i-check'));
        option.addEventListener('click', () => {
          close();
          const ref = choice.ref || null;
          if (runtime.selectedBaseRef() !== ref) runtime.selectBaseRef(ref);
        });
        items.append(option);
      }
      if (!items.childElementCount) items.append(el('p', 'file-branch-empty', () => t('No branches found')));
      if (runtime.snapshot()?.branchesTruncated) items.append(el('p', 'file-branch-empty', () => t('More branches exist than can be shown.')));
    };
    search.addEventListener('input', renderItems);
    search.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); items.querySelector<HTMLButtonElement>('button')?.focus(); }
      if (event.key === 'Enter') { event.preventDefault(); items.querySelector<HTMLButtonElement>('button')?.click(); }
    });
    items.addEventListener('keydown', event => {
      const buttons = [...items.querySelectorAll<HTMLButtonElement>('button')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
      }
    });
    next.append(search, items);
    const rect = trigger.getBoundingClientRect();
    next.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 300))}px`;
    next.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 270))}px`;
    document.body.append(next); menu = next;
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('resize', dismissOnResize);
    renderItems(); search.focus();
  });

  return { close };
}
