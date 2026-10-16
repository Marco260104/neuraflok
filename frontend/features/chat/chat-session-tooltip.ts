import type { SessionSummary } from '../../../contracts/session.js';
import { el } from '../../shared/dom.js';

export function createChatSessionTooltip() {
  let dismissedSession: string | null = null;

  function placeSessionTooltip(tip: HTMLElement, row: HTMLElement): void {
    tip.textContent = row.title;
    const bounds = row.getBoundingClientRect();
    tip.style.left = `${Math.min(bounds.right + 10, window.innerWidth - 290)}px`;
    tip.style.top = `${Math.min(bounds.top, window.innerHeight - 110)}px`;
  }

  function bind(row: HTMLElement, summary: SessionSummary): void {
    const showTip = () => {
      if (dismissedSession === summary.id) return;
      const current = document.getElementById('sessionTooltip');
      if (current?.dataset.for === summary.id) {
        placeSessionTooltip(current, row);
        return;
      }
      current?.remove();
      if (document.querySelector('.row-menu')) return;
      const tip = el('div', 'session-tooltip');
      tip.id = 'sessionTooltip';
      tip.setAttribute('role', 'tooltip');
      tip.dataset.for = summary.id;
      placeSessionTooltip(tip, row);
      document.body.append(tip);
    };
    row.addEventListener('pointerenter', showTip);
    row.addEventListener('pointerleave', () => {
      if (dismissedSession === summary.id) dismissedSession = null;
      document.getElementById('sessionTooltip')?.remove();
    });
    row.addEventListener('click', () => {
      if (row.matches(':hover')) dismissedSession = summary.id;
      document.getElementById('sessionTooltip')?.remove();
    });
  }

  return { placeSessionTooltip, bind };
}
