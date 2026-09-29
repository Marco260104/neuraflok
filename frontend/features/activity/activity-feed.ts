import type { LogEntry } from '../../../contracts/types.js';
import type { SwarmState } from '../../../contracts/session.js';
import { $, el } from '../../shared/dom.js';
import { currentLanguage, t, ui } from '../../shared/i18n.js';

export function initActivityFeed() {
  // Anything the user might have to act on, counted so problems are never buried. Counted from the rows the feed still holds, not from everything that ever arrived. The feed keeps 500 lines and drops the rest, so a running total drifted away from what the Problems filter could actually show: "4 problems" above an empty list, which reads as the filter being broken rather than as the rows having aged out.
  function paintProblems(): void {
    const problems = $('fullFeed').querySelectorAll('p.bad').length;
    for (const id of ['homeProblems', 'logProblems']) {
      const badge = $(id);
      badge.hidden = problems === 0;
      ui(badge, 'textContent', () => t(problems === 1 ? '{0} problem' : '{0} problems', [problems]));
    }
  }

  // Splits a log line into a short subject and the rest so the eye can scan the left column; bridge errors and MCP request lines both work.
  function splitMessage(message: string): [string, string] {
    const colon = message.indexOf(': ');
    if (colon > 0 && colon <= 24) return [message.slice(0, colon), message.slice(colon + 2)];
    const space = message.indexOf(' ');
    if (space > 0 && space <= 24) return [message.slice(0, space), message.slice(space + 1)];
    return [message, ''];
  }

  function logRow(entry: LogEntry): HTMLElement {
    const [what, rest] = splitMessage(entry.message);
    const line = el('p', entry.level === 'info' ? '' : 'bad');
    if (entry.agent) line.dataset.agent = entry.agent;
    const time = document.createElement('time');
    // Bound like other copy, so lines already shown follow a language change instead of keeping the old clock format next to new lines in the new one.
    ui(time, 'textContent', () => new Date(entry.time).toLocaleTimeString(currentLanguage()));
    line.append(time, el('span', 'what', what), el('span', 'rest', rest));
    return line;
  }

  const FEEDS = ['homeFeed', 'fullFeed'];

  // Whether each feed is following the newest line. Remembered rather than measured on every append, because a feed inside a panel that is not on screen has no geometry to measure: `clientHeight` and `scrollHeight` are both 0, every arriving line looks like it was appended at the bottom, and the pin is written as `scrollTop = 0`. That is exactly what the Activity panel did — every line of a session arrived while Home was showing, so opening Activity landed on the oldest line in the buffer and stayed there. A feed is pinned until the user scrolls it up themselves, and scrolling back to the bottom re-pins it.
  const pinned = new Map<string, boolean>(FEEDS.map((id) => [id, true]));

  function atBottom(view: HTMLElement): boolean {
    return view.scrollTop + view.clientHeight >= view.scrollHeight - 24;
  }

  /** Puts a feed back on its newest line. Safe on a hidden panel: it is re-applied on show. */
  function stickToNewest(id: string): void {
    if (pinned.get(id) === false) return;
    const view = $(id);
    view.scrollTop = view.scrollHeight;
  }

  for (const id of FEEDS) {
    // Only a real user scroll may unpin. `scroll` also fires for the programmatic pin above, which is harmless: that one always lands at the bottom and re-pins.
    $(id).addEventListener('scroll', () => {
      const view = $(id);
      // A hidden panel reports zeroes; never let that be read as "scrolled away".
      if (view.clientHeight === 0) return;
      pinned.set(id, atBottom(view));
    });
  }

  function addLogLine(entry: LogEntry): void {
    let evicted = false;
    for (const id of FEEDS) {
      const view = $(id);
      const row = logRow(entry);
      // Home always shows everything; only the Activity panel has the agent filter.
      if (id === 'fullFeed' && agentFilter !== null) row.hidden = entry.agent !== agentFilter;
      view.append(row);
      while (view.childElementCount > 500) {
        if (id === 'fullFeed' && view.firstElementChild?.classList.contains('bad')) evicted = true;
        view.firstElementChild?.remove();
      }
      stickToNewest(id);
    }
    // After the eviction above, so the badge counts what is there rather than what arrived. A quiet run of 500 info lines retires old problems just as surely as a new one adds to them, so both directions have to repaint.
    if (entry.level !== 'info' || evicted) paintProblems();
  }

  $('logFilter').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-filter]');
    if (!button) return;
    for (const other of $('logFilter').querySelectorAll('button')) {
      other.classList.toggle('is-sel', other === button);
    }
    $('fullFeed').classList.toggle('only-bad', button.dataset.filter === 'bad');
    // Hiding most of the rows changes what "the bottom" is, so re-pin rather than leaving the view parked at an offset that now belongs to a line the filter removed.
    stickToNewest('fullFeed');
  });

  // Agent filter for the Activity panel. Only exists while a swarm is running: with no workers there is nothing to separate, and the plain single view is the one people already know. null means "All".
  let agentFilter: string | null = null;

  function applyAgentFilter(): void {
    for (const row of $('fullFeed').querySelectorAll<HTMLElement>('p')) {
      row.hidden = agentFilter !== null && (row.dataset.agent ?? null) !== agentFilter;
    }
  }

  function paintAgentFilter(swarm: SwarmState): void {
    const box = $('logAgentFilter');
    if (!swarm.running) {
      box.hidden = true;
      box.replaceChildren();
      if (agentFilter !== null) {
        agentFilter = null;
        applyAgentFilter();
      }
      return;
    }
    // Prime first, then workers in creation order — the order the broker reports them.
    const choices: Array<{ id: string | null; label: string }> = [{ id: null, label: t("All") }];
    for (const agent of swarm.agents) choices.push({ id: agent.id, label: agent.label || agent.id });
    if (agentFilter !== null && !swarm.agents.some((agent) => agent.id === agentFilter)) {
      agentFilter = null;
    }
    box.replaceChildren(
      ...choices.map((choice) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = choice.label;
        button.classList.toggle('is-sel', choice.id === agentFilter);
        button.addEventListener('click', () => {
          agentFilter = choice.id;
          paintAgentFilter(swarm);
          applyAgentFilter();
        });
        return button;
      })
    );
    box.hidden = false;
    applyAgentFilter();
  }

  function stickToNewestFeeds(): void {
    for (const id of FEEDS) stickToNewest(id);
  }

  return { addLogLine, paintAgentFilter, stickToNewestFeeds };
}
