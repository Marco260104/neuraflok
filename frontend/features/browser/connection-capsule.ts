import { $ } from '../../shared/dom.js';
import { ui } from '../../shared/i18n.js';

interface ConnectionCapsuleState {
  connected: boolean;
  tone: string;
  label: string;
}

export function createConnectionCapsule(paintClock: () => void): { paint: (state: ConnectionCapsuleState) => void } {
  const trigger = $<HTMLElement>('sidebarConnection');
  const label = $<HTMLElement>('sidebarConnectionLabel');
  const popover = $<HTMLElement>('connectionPopover');
  let previousConnected: boolean | null = null;
  let morph: Animation[] = [];
  let morphGhost: HTMLElement | undefined;

  function endMorph(): void {
    const running = morph;
    morph = [];
    running.forEach(animation => animation.cancel());
    morphGhost?.remove();
    morphGhost = undefined;
    trigger.classList.remove('is-morphing');
  }

  function position(): void {
    if (popover.hidden) return;
    const bounds = trigger.getBoundingClientRect();
    const popoverBounds = popover.getBoundingClientRect();
    const margin = 12;
    const preferredLeft = bounds.left + bounds.width / 2 - popoverBounds.width / 2;
    const maxLeft = Math.max(margin, window.innerWidth - popoverBounds.width - margin);
    popover.style.left = `${Math.min(Math.max(margin, preferredLeft), maxLeft)}px`;
    const below = bounds.bottom + popoverBounds.height + 8 <= window.innerHeight - margin;
    const top = below ? bounds.bottom + 8 : Math.max(margin, bounds.top - popoverBounds.height - 8);
    popover.style.top = `${top}px`;
    popover.style.bottom = 'auto';
  }

  function setOpen(open: boolean): void {
    popover.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    if (open) {
      position();
      paintClock();
    }
  }

  function paint(state: ConnectionCapsuleState): void {
    const wasConnected = trigger.classList.contains('is-connected') || trigger.classList.contains('is-configured');
    const labelled = !state.connected;
    const wasLabelled = trigger.classList.contains('has-label');
    const wordsBefore = label.textContent;
    const opening = !wasLabelled && labelled && previousConnected !== null;
    let shouldMorph = labelled && (opening || (wasLabelled && state.label !== wordsBefore)) && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const capsuleBefore = trigger.getBoundingClientRect();
    const widthBefore = capsuleBefore.width;
    const wordsRightBefore = capsuleBefore.right - label.getBoundingClientRect().right;

    if (shouldMorph || !labelled) endMorph();
    trigger.className = `sidebar-connection${state.tone ? ` ${state.tone}` : ''}${labelled ? ' has-label' : ''}${morph.length ? ' is-morphing' : ''}`;
    if (labelled) ui(label, 'textContent', () => state.label);

    if (shouldMorph) {
      trigger.classList.add('is-morphing');
      if (window.getComputedStyle(label.parentElement!).opacity === '0') {
        endMorph();
        shouldMorph = false;
      }
    }

    if (shouldMorph) {
      const widthAfter = trigger.getBoundingClientRect().width;
      const easing = 'cubic-bezier(.22, 1, .36, 1)';
      let ghost: HTMLElement | undefined;
      if (!opening) {
        ghost = trigger.appendChild(document.createElement('span'));
        ghost.className = 'sidebar-connection-ghost';
        ghost.setAttribute('aria-hidden', 'true');
        const ghostWords = ghost.appendChild(document.createElement('span'));
        ghostWords.style.right = `${wordsRightBefore - trigger.clientLeft}px`;
        ghostWords.textContent = wordsBefore;
      }
      morph = [
        trigger.animate?.([{ width: `${widthBefore}px` }, { width: `${widthAfter}px` }], {
          duration: 320,
          delay: widthAfter < widthBefore ? 60 : 0,
          easing,
          fill: 'backwards'
        }),
        ghost?.animate?.([{ opacity: 1, filter: 'blur(0)' }, { opacity: 0, filter: 'blur(2px)' }], {
          duration: widthAfter < widthBefore ? 110 : 160,
          easing: 'ease-out',
          fill: 'forwards'
        }),
        label.animate?.([{ opacity: 0, filter: 'blur(2px)' }, { opacity: 1, filter: 'blur(0)' }], {
          duration: opening ? 300 : 260,
          delay: opening ? 20 : 60,
          easing,
          fill: 'backwards'
        })
      ].filter((animation): animation is Animation => !!animation);
      morphGhost = ghost;
      const currentMorph = morph;
      if (!currentMorph.length) endMorph();
      else void Promise.all(currentMorph.map(animation => animation.finished)).then(() => {
        if (morph === currentMorph) endMorph();
      }, () => undefined);
    }

    if (state.connected && !wasConnected && previousConnected !== null && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      trigger.querySelector('.sidebar-connection-dot')?.animate?.([
        { transform: 'scale(.4)', boxShadow: '0 0 0 0 color-mix(in srgb, var(--green) 60%, transparent)' },
        { transform: 'scale(1.25)', offset: .45 },
        { transform: 'scale(1)', boxShadow: '0 0 0 10px transparent' }
      ], { duration: 620, delay: 180, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'backwards' });
      trigger.animate?.([
        { borderColor: 'color-mix(in srgb, var(--green) 70%, transparent)' },
        { borderColor: 'var(--line)' }
      ], { duration: 900, easing: 'ease-out' });
    }

    previousConnected = state.connected;
    popover.className = `connection-popover scroll${state.tone ? ` ${state.tone}` : ''}`;
  }

  trigger.addEventListener('click', () => setOpen(Boolean(popover.hidden)));
  trigger.addEventListener('contextmenu', event => {
    event.preventDefault();
    setOpen(true);
  });
  window.addEventListener('resize', position);
  document.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    if (!target.closest('.connection-anchor') && !popover.contains(target) && !popover.hidden) setOpen(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || popover.hidden) return;
    setOpen(false);
    trigger.focus();
  });

  return { paint };
}
