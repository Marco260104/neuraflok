import type { ToolCallRecord } from '../../../../contracts/session.js';
import { disclosureChevron, el, icon, run } from '../../../shared/dom.js';
import { t, ui } from '../../../shared/i18n.js';

type ToolChange = NonNullable<ToolCallRecord['changes']>[number];

export function renderEditCard(call: ToolCallRecord, sessionId: string, index: number, change: ToolChange, current: () => boolean): HTMLDetailsElement {
  const card = document.createElement('details');
  card.className = 'edit-card';
  const header = el('summary', 'edit-card-header');
  const verb = call.summary.kind === 'create' ? 'Created' : call.summary.kind === 'delete' ? 'Deleted' : 'Edited';
  const filename = change.path.split(/[\\/]/).pop();
  header.append(icon('i-file-text'), el('b', '', () => `${t(verb)} ${filename}`),
    el('span', 'metric-added', `+${change.added}`), el('span', 'metric-removed', `−${change.removed}`), disclosureChevron('edit-chevron'));
  if (change.approximate) header.append(el('span', 'meta', () => t(' (approx.)')));

  const path = el('div', 'edit-card-path', change.path);
  const controls = el('div', 'edit-card-controls');
  const copy = el('button', 'tool-copy', () => t('Copy file')) as HTMLButtonElement;
  copy.type = 'button';
  copy.disabled = true;
  const expand = el('button', 'tool-copy', () => t('Expand')) as HTMLButtonElement;
  expand.type = 'button';
  expand.onclick = () => {
    const expanded = card.classList.toggle('is-expanded');
    expand.setAttribute('aria-pressed', String(expanded));
  };
  expand.setAttribute('aria-pressed', 'false');
  controls.append(copy, expand);

  const viewport = el('div', 'unified-diff');
  viewport.tabIndex = 0;
  ui(viewport, 'aria-label', () => t('Diff for {0}', [change.path]));
  const body = el('div', 'edit-card-body');
  body.append(path, controls, viewport);
  card.append(header, body);

  let loaded = false;
  const showUnavailable = (message: string): void => {
    loaded = false;
    copy.disabled = true;
    viewport.replaceChildren(el('p', 'meta', () => t(message)));
  };
  card.addEventListener('toggle', async () => {
    if (!card.open || loaded || !card.isConnected || !current()) return;
    loaded = true;
    viewport.replaceChildren(el('p', 'meta', () => t('Loading edit…')));
    if (!change.reviewAssetId) {
      showUnavailable(change.reviewUnavailable === 'too-large'
        ? 'Diff unavailable: this edit was too large to keep' : 'Diff unavailable: this edit was not kept');
      return;
    }

    const reply = await run(window.api.getToolEditReview(sessionId, call.callId, index));
    if (!current() || !card.isConnected) return;
    if (!reply || reply.callId !== call.callId || reply.changeIndex !== index || reply.path !== change.path) {
      showUnavailable('Recorded edit is unavailable.');
      return;
    }
    if (reply.baseText.length + reply.currentText.length > 512 * 1024) {
      showUnavailable('Recorded edit is unavailable.');
      return;
    }

    copy.disabled = false;
    copy.onclick = () => {
      if (current() && card.isConnected) void run(window.api.writeClipboard(reply.currentText));
    };
    const diff = await import('../unified-diff.js');
    if (!current() || !card.isConnected) return;
    await diff.renderUnifiedDiff(viewport, change.path, reply.baseText, reply.currentText, () => current() && card.isConnected);
  });
  return card;
}
