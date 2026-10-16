import { el, toast } from '../../../shared/dom.js';
import { t } from '../../../shared/i18n.js';
import type { LocalProject } from '../../../../contracts/workspace/projects.js';
import type { TerminalSessionCallbacks, TerminalTab } from './contracts.js';

export function createTerminalSession(
  id: string,
  title: string,
  body: HTMLElement
): TerminalTab {
  const node = el('div', 'terminal-screen');
  node.append(el('span', 'terminal-load-status', () => t('Loading…')));
  body.append(node);
  return { id, title, node, term: null, fit: null, ready: false, exited: false, queued: 0, writes: Promise.resolve() };
}

export async function startTerminalSession(
  tab: TerminalTab,
  project: LocalProject | null,
  callbacks: TerminalSessionCallbacks,
  getTheme: () => ReturnType<typeof import('./theme.js').readTerminalTheme>,
  onToggleBottom: () => void
): Promise<void> {
  try {
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/xterm/css/xterm.css')
    ]);
    if (!callbacks.isRetained()) return;
    const term = new Terminal({
      theme: getTheme(),
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Cascadia Code, Consolas, monospace',
      scrollback: 5000,
      allowProposedApi: false
    });
    const fit = new FitAddon();
    tab.term = term;
    tab.fit = fit;
    term.loadAddon(fit);
    tab.node.replaceChildren();
    term.open(tab.node);
    term.onData(data => {
      if (tab.exited || !tab.ready) return;
      if (tab.queued + data.length > 262_144) {
        toast(t('Terminal input is busy. Try a smaller paste.'));
        return;
      }
      tab.queued += data.length;
      for (let at = 0; at < data.length; at += 16_384) {
        const chunk = data.slice(at, at + 16_384);
        tab.writes = tab.writes.then(async () => {
          if (!callbacks.isRetained() || tab.exited) return;
          const result = await window.api.terminalWrite(tab.id, chunk);
          if (!result.ok) toast(result.error);
        }).catch(error => toast(String(error))).finally(() => { tab.queued -= chunk.length; });
      }
    });
    term.attachCustomKeyEventHandler(event => {
      if (event.type === 'keydown' && event.ctrlKey && event.key === '`') {
        onToggleBottom();
        return false;
      }
      if (event.type === 'keydown' && event.ctrlKey && event.code === 'KeyC' && (event.shiftKey || term.hasSelection())) {
        void window.api.writeClipboard(term.getSelection());
        return false;
      }
      return true;
    });
    const result = await window.api.terminalCreate(
      tab.id,
      project?.id ?? null,
      Math.min(500, term.cols),
      Math.min(200, term.rows)
    );
    if (!callbacks.isRetained()) {
      term.dispose();
      void window.api.terminalClose(tab.id);
      return;
    }
    if (!result.ok) {
      tab.exited = true;
      term.writeln(`\r\n${result.error}`);
    } else {
      tab.ready = true;
      tab.title = project ? `${project.name} · ${result.data.shell}` : result.data.shell;
      tab.node.title = result.data.cwd;
    }
    callbacks.refresh();
    callbacks.fit();
    callbacks.onTabsChanged();
    if (callbacks.isOpen() && callbacks.isSelected()) term.focus();
  } catch (error) {
    if (!callbacks.isRetained()) return;
    const message = error instanceof Error ? error.message : String(error);
    tab.exited = true;
    if (tab.term) void window.api.terminalClose(tab.id);
    tab.term?.dispose();
    tab.term = null;
    tab.fit = null;
    toast(message);
    tab.node.replaceChildren(el('p', 'terminal-load-error', message));
    callbacks.refresh();
    callbacks.onTabsChanged();
  }
}
