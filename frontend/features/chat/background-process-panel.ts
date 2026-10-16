import type { ActiveWorkspaceProcess } from '../../../contracts/workspace/execution/active-process.js';
import { $, el, toast } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';

interface Runtime {
  api: Pick<typeof window.api, 'runningProcesses' | 'stopProcess'>;
  selectedSession: () => string | null;
  selectionGeneration: () => number;
  composerDockVisible: () => boolean;
}

// Owns the live background-process panel and its session-scoped refresh state.
export function createBackgroundProcessPanel(runtime: Runtime) {
  const { api, selectedSession, selectionGeneration, composerDockVisible } = runtime;
  let processes: ActiveWorkspaceProcess[] = [];
  let processesFor: string | null = null;
  let requestGeneration = 0;
  let clock: number | null = null;
  let stopping: string | null = null;
  let focusAfterRefresh: { session: string; selection: number } | null = null;
  const expandedSessions = new Set<string>();

  function processKey(row: ActiveWorkspaceProcess): string {
    return row.processId + ':' + row.incarnation;
  }

  function compactCommand(command: string): string {
    const compact = command.replace(/\s+/g, ' ').trim();
    return compact.length > 120 ? compact.slice(0, 117) + '…' : compact;
  }

  function elapsed(startedAt: number): string {
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }

  function syncClock(visible: boolean): void {
    if (visible && clock === null) {
      clock = window.setInterval(() => paintTimes(), 1_000);
    } else if (!visible && clock !== null) {
      window.clearInterval(clock);
      clock = null;
    }
  }

  function sortedProcesses(): ActiveWorkspaceProcess[] {
    return processesFor === selectedSession() ? [...processes].sort((a, b) => a.startedAt - b.startedAt) : [];
  }

  function paintTimes(): void {
    const rows = sortedProcesses();
    if (!selectedSession() || !rows.length) return;
    const first = rows[0]!;
    const host = $('backgroundExecStatus');
    ui(host.querySelector<HTMLElement>('.background-exec-time')!, 'textContent', () => t('Running for {0}', [elapsed(first.startedAt)]));
    $('backgroundExecList').querySelectorAll<HTMLElement>('.background-exec-process-time').forEach(time => {
      const startedAt = Number(time.dataset.startedAt);
      if (Number.isFinite(startedAt)) ui(time, 'textContent', () => t('Running for {0}', [elapsed(startedAt)]));
    });
  }

  async function stopProcess(row: ActiveWorkspaceProcess, restoreFocus: boolean): Promise<void> {
    const session = selectedSession();
    if (!session || stopping !== null) return;
    if (restoreFocus) focusAfterRefresh = { session, selection: selectionGeneration() };
    stopping = processKey(row);
    paintStops();
    const reply = await api.stopProcess(session, row.processId, row.incarnation);
    if (session !== selectedSession()) {
      if (focusAfterRefresh?.session === session) focusAfterRefresh = null;
      return;
    }
    stopping = null;
    paintStops();
    if (!reply.ok || !reply.data) {
      toast(reply.ok ? t('Background process is no longer running') : reply.error);
      refresh();
      return;
    }
    refresh();
  }

  function stopLabel(row: ActiveWorkspaceProcess): string {
    const command = compactCommand(row.command);
    return t('Stop background process') + ': #' + row.processId + (command ? ' ' + command : '');
  }

  function configureStop(stop: HTMLButtonElement, row: ActiveWorkspaceProcess): void {
    ui(stop, 'title', () => t('Stop background process'));
    ui(stop, 'aria-label', () => stopLabel(row));
    const label = stop.querySelector<HTMLElement>('span');
    if (label) ui(label, 'textContent', () => t('Stop'));
    stop.disabled = stopping !== null;
    stop.onclick = event => {
      event.stopPropagation();
      void stopProcess(row, event.detail === 0);
    };
  }

  function paintStops(): void {
    const disabled = stopping !== null;
    $('backgroundExecStatus').querySelectorAll<HTMLButtonElement>('.background-exec-stop').forEach(stop => { stop.disabled = disabled; });
    $('backgroundExecList').querySelectorAll<HTMLButtonElement>('.background-exec-stop').forEach(stop => { stop.disabled = disabled; });
  }

  function paint(): void {
    const host = $('backgroundExecStatus');
    const liveStatus = $('backgroundExecLiveStatus');
    const list = $('backgroundExecList');
    const rows = sortedProcesses();
    const session = selectedSession();
    if (!session || !rows.length) {
      if (session) expandedSessions.delete(session);
      host.hidden = true;
      host.removeAttribute('title');
      host.removeAttribute('aria-expanded');
      host.removeAttribute('aria-controls');
      host.removeAttribute('tabindex');
      host.setAttribute('role', 'status');
      host.classList.remove('is-expandable', 'is-expanded');
      host.onclick = null;
      host.onkeydown = null;
      list.hidden = true;
      list.replaceChildren();
      liveStatus.textContent = '';
      liveStatus.hidden = true;
      syncClock(false);
      return;
    }
    const first = rows[0]!;
    const multiple = rows.length > 1;
    if (!multiple) expandedSessions.delete(session);
    const expanded = multiple && expandedSessions.has(session);
    const command = compactCommand(first.command) || '#' + first.processId;
    ui(host.querySelector<HTMLElement>('.queue-label')!, 'textContent', () => rows.length === 1
      ? t('Background process running · {0}', [command])
      : t('{0} background processes running', [rows.length]));
    host.title = rows.map(row => '#' + row.processId + ' ' + compactCommand(row.command)).join('\n');
    liveStatus.hidden = !multiple;
    liveStatus.textContent = multiple ? t('{0} background processes running', [rows.length]) : '';
    const stop = host.querySelector<HTMLButtonElement>('.background-exec-stop')!;
    stop.hidden = multiple;
    configureStop(stop, first);
    const chevron = host.querySelector<HTMLElement>('.background-exec-chevron')!;
    chevron.hidden = !multiple;
    host.classList.toggle('is-expandable', multiple);
    host.classList.toggle('is-expanded', expanded);
    if (multiple) {
      host.setAttribute('role', 'button');
      host.setAttribute('aria-expanded', String(expanded));
      host.setAttribute('aria-controls', 'backgroundExecList');
      host.tabIndex = 0;
      const toggle = () => {
        const current = selectedSession();
        if (!current) return;
        if (expandedSessions.has(current)) expandedSessions.delete(current);
        else expandedSessions.add(current);
        paint();
      };
      host.onclick = event => {
        if ((event.target as HTMLElement).closest('button')) return;
        toggle();
      };
      host.onkeydown = event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggle();
      };
    } else {
      host.setAttribute('role', 'status');
      host.removeAttribute('aria-expanded');
      host.removeAttribute('aria-controls');
      host.removeAttribute('tabindex');
      host.onclick = null;
      host.onkeydown = null;
    }
    list.hidden = !expanded;
    list.replaceChildren();
    if (expanded) {
      for (const row of rows) {
        const item = el('div', 'background-exec-process');
        item.setAttribute('role', 'listitem');
        item.dataset.processId = String(row.processId);
        item.dataset.incarnation = String(row.incarnation);
        item.title = row.command;
        const commandText = compactCommand(row.command);
        const itemCommand = el('span', 'background-exec-process-command', '#' + row.processId + (commandText ? ' ' + commandText : ''));
        const itemTime = el('span', 'background-exec-time background-exec-process-time');
        itemTime.dataset.startedAt = String(row.startedAt);
        const itemStop = el('button', 'background-exec-stop') as HTMLButtonElement;
        itemStop.type = 'button';
        const stopIcon = el('i', 'ico ph ph-power');
        stopIcon.setAttribute('aria-hidden', 'true');
        itemStop.append(stopIcon, el('span'));
        configureStop(itemStop, row);
        item.append(itemCommand, itemTime, itemStop);
        list.append(item);
      }
    }
    host.hidden = false;
    paintTimes();
    syncClock(true);
  }

  function refresh(): void {
    const session = selectedSession();
    const request = ++requestGeneration;
    if (!session) {
      processes = [];
      processesFor = null;
      stopping = null;
      paint();
      return;
    }
    void api.runningProcesses(session).then(reply => {
      if (request !== requestGeneration || session !== selectedSession()) return;
      processes = reply.ok && Array.isArray(reply.data) ? reply.data : [];
      processesFor = session;
      if (!processes.some(row => processKey(row) === stopping)) stopping = null;
      paint();
      const focus = focusAfterRefresh;
      if (focus?.session === session) {
        focusAfterRefresh = null;
        if (focus.selection === selectionGeneration() && composerDockVisible()) {
          const rows = sortedProcesses();
          if (rows.length > 1) $('backgroundExecStatus').focus();
          else if (rows.length === 1) $('backgroundExecStatus').querySelector<HTMLButtonElement>('.background-exec-stop')?.focus();
        }
      }
    });
  }

  return { paint, refresh };
}
