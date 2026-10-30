import { ATTRIBUTION_LABELS, toolCallSummary, type ActivitySummary, type SessionEvent } from '../../../contracts/session.js';
import { compactNumber, el, icon, run } from '../../shared/dom.js';
import { ui, t } from '../../shared/i18n.js';
import { localizeActivityTitle } from './activity-title.js';
import { toolResultText } from './tool-results/presentation.js';
import { renderEditCards } from './tool-artifacts.js';
import { textBlock } from './markdown-renderer.js';
import type { LocalProject } from '../../../contracts/workspace/projects.js';

export interface ToolCallContext { id: string; current: () => boolean; }

export interface ToolCallRendererRuntime {
  el: typeof el;
  icon: typeof icon;
  run: typeof run;
  toast: typeof import('../../shared/dom.js').toast;
  t: typeof t;
  ui: typeof ui;
  api: typeof window.api;
  selectedLocalProject: () => LocalProject | null;
  readonly selectedId: string | null;
  readonly selectionGeneration: number;
  openTools: Set<string>;
  openReview: (projectId: string, sessionId: string, callId: string, indices: number[]) => Promise<boolean>;
}
// Sprite id per tool-call family. Deliberately reuses the existing icon set.
export const KIND_ICON: Record<ActivitySummary['kind'], string> = {
  edit: 'i-pencil',
  create: 'i-plus',
  delete: 'i-trash',
  move: 'i-out',
  read: 'i-eye',
  search: 'i-search',
  browse: 'i-folder',
  run: 'i-terminal',
  process: 'i-terminal',
  screen: 'i-monitor',
  input: 'i-monitor',
  clipboard: 'i-copy',
  session: 'i-steps',
  agent: 'i-bolt',
  other: 'i-bolt'
};

export function createToolCallRenderer(runtime: ToolCallRendererRuntime) {
  const { el, icon, run, toast, t, ui, api, selectedLocalProject } = runtime;
  const openTools = runtime.openTools;
  const reviewPanel = { openReview: runtime.openReview };
  // Line deltas split so removed lines read in red; any other metric stays one text node.
  function toolMetric(value: string, className = 'metric'): HTMLElement {
    const metric = el('span', className);
    const delta = /^(~?)(\+\d+)?(?:\s+)?([−-]\d+)?$/.exec(value);
    if (!delta || (!delta[2] && !delta[3])) {
      metric.textContent = value;
      return metric;
    }
    if (delta[1]) metric.append(delta[1]);
    if (delta[2]) metric.append(el('span', 'metric-added', delta[2]));
    if (delta[3]) {
      if (delta[2]) metric.append(' ');
      metric.append(el('span', 'metric-removed', delta[3]));
    }
    return metric;
  }
  function toolBody(event: Extract<SessionEvent, { kind: 'tool_call' }>, context?: ToolCallContext): HTMLElement {
    const { call } = event;
    const summary = toolCallSummary(call);
    const box = document.createElement('details');
    box.className = `tool tone-${call.summary.tone}`;
    box.dataset.outcome = call.outcome;
    if (call.changes?.length || ['exec_command', 'write_stdin', 'apply_patch'].includes(call.tool)) box.classList.add('is-artifact');
    box.open = openTools.has(call.callId);
    box.addEventListener('toggle', () => {
      if (box.open) openTools.add(call.callId);
      else openTools.delete(call.callId);
    });

    const head = document.createElement('summary');
    head.append(icon(KIND_ICON[call.summary.kind] ?? 'i-bolt', 'ico tool-ico'));
    if (call.tool === 'exec_command' || call.tool === 'write_stdin') head.append(el('span', 'tool-tag is-shell', 'shell'));
    else if (call.changes?.length || call.tool === 'apply_patch') head.append(el('span', 'tool-tag is-diff', 'diff'));
    head.append(el('b', '', () => localizeActivityTitle(call.summary.title, t)));
    if (call.summary.detail) head.append(el('em', '', call.summary.detail));
    if (call.changes?.length) {
      const added = call.changes.reduce((total, change) => total + change.added, 0);
      const removed = call.changes.reduce((total, change) => total + change.removed, 0);
      const approximate = call.changes.some(change => change.approximate);
      const count = toolMetric(`+${added} −${removed}`, 'tool-change-count');
      if (approximate) count.append(el('span', '', () => t(' (approx.)')));
      // When the outcome metric on the right is already a line delta ("+39", "+2 −13", "~−7"), a second count beside the title only repeats it, whatever its exact formatting.
      const deltaMetric = /^~?(?:\+\d+)?\s*(?:[−-]\d+)?$/.test(summary.metric ?? '') && /\d/.test(summary.metric ?? '');
      if (!deltaMetric) head.append(count);
    }
    if (summary.metric) head.append(toolMetric(summary.metric));
    const project = selectedLocalProject();
    const sessionId = context?.id ?? runtime.selectedId;
    const reviewIndices = call.outcome === 'ok' ? (call.changes ?? []).flatMap((change, index) =>
      change.reviewAssetId ? [index] : []).slice(0, 32) : [];
    const unavailable = call.outcome === 'ok' ? (call.changes ?? []).filter(change => change.reviewUnavailable) : [];
    if (project && sessionId && !reviewIndices.length && unavailable.length) {
      // Say why there is nothing to review instead of leaving the row without an action.
      const missing = el('button', 'tool-open-diff is-unavailable') as HTMLButtonElement;
      missing.type = 'button'; missing.setAttribute('aria-disabled', 'true');
      missing.addEventListener('click', click => { click.preventDefault(); click.stopPropagation(); });
      missing.append(icon('i-git-diff'));
      const reason = () => unavailable.some(change => change.reviewUnavailable === 'too-large')
        ? t('Diff unavailable: this edit was too large to keep') : t('Diff unavailable: this edit was not kept');
      ui(missing, 'title', reason);
      ui(missing, 'aria-label', reason);
      head.append(missing);
    }
    if (project && sessionId && reviewIndices.length) {
      const review = el('button', 'tool-open-diff') as HTMLButtonElement;
      review.type = 'button';
      review.append(icon('i-git-diff'));
      const total = reviewIndices.length + unavailable.length;
      const label = () => unavailable.length ? t('Review this edit ({0} of {1} files)', [reviewIndices.length, total]) : t('Review this edit');
      ui(review, 'title', label);
      ui(review, 'aria-label', label);
      review.addEventListener('click', click => {
        click.preventDefault();
        click.stopPropagation();
        if (runtime.selectedId !== sessionId || selectedLocalProject()?.id !== project.id) return;
        void reviewPanel?.openReview(project.id, sessionId, call.callId, reviewIndices).then(opened => {
          if (!opened) toast(t('Recorded edit is unavailable.'));
        });
      });
      head.append(review);
    }
    box.append(head);

    // Collapsed calls only need their headline. Large recorded results must not consume layout/DOM work, or evict surrounding prose, before they are opened.
    let populated = false;
    const populate = () => {
      if (populated || !box.open) return;
      populated = true;
      appendToolOutput(box, event, context);
    };
    box.addEventListener('toggle', populate);
    populate();
    return box;
  }
  function appendToolOutput(box: HTMLDetailsElement, { call }: Extract<SessionEvent, { kind: 'tool_call' }>,
    context?: ToolCallContext): void {
    const raw = el('div', 'raw');
    const appendText = (label: () => string, value: string, truncated: boolean, chars: number) => {
      const panel = el('div', 'tool-output');
      const header = el('div', 'tool-output-header');
      header.append(icon(KIND_ICON[call.summary.kind] ?? 'i-terminal', 'ico'), el('strong', '', label));
      const copy = el('button', 'tool-copy', () => t('Copy')) as HTMLButtonElement;
      copy.type = 'button';
      copy.addEventListener('click', () => void (async () => {
        if (await run(api.writeClipboard(value))) ui(copy, 'textContent', () => t('Copied'));
        else toast(t('Could not copy text.'));
      })());
      header.append(copy);
      panel.append(header, textBlock('pre', value, truncated, chars));
      raw.append(panel);
    };
    const facts = el('p', 'raw-facts');
    ui(facts, 'textContent', () => `${call.tool} · ${call.outcome} · ${Math.round(call.durationMs)} ms · ` +
      t("placed by {0}", [ATTRIBUTION_LABELS[call.attribution] ?? call.attribution]));
    raw.append(facts);

    const ownerId = context?.id ?? runtime.selectedId, generation = runtime.selectionGeneration;
    const current = () => context ? context.current() : ownerId === runtime.selectedId && generation === runtime.selectionGeneration;
    if (call.outcome === 'ok' && call.changes?.length && ownerId) {
      raw.append(renderEditCards(call, ownerId, current));
    } else if (call.changes && call.changes.length > 0) {
      const changes = el('ul', 'changes');
      for (const change of call.changes) {
        const li = el('li');
        li.append(el('code', '', change.path));
        const counts = toolMetric(`+${change.added} −${change.removed}`);
        if (change.approximate) counts.append(t(" (approx.)"));
        li.append(counts);
        changes.append(li);
      }
      raw.append(changes);
    }

    appendText(() => `${t('Arguments')} · ${call.tool}`, call.args.text, call.args.truncated, call.args.chars);
    const images = call.assets?.filter(asset => ['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType)) ?? [];
    const readable = toolResultText(call.result.text, call.result.truncated, images.length > 0);
    if (readable) appendText(() => `${t('Result')} · ${call.tool} · ${Math.round(call.durationMs)} ms`, readable, call.result.truncated && images.length === 0, call.result.chars);
    // Older recordings did not retain the reason an image asset was omitted. Explain the missing local preview without inferring a historical provider receipt.
    if (call.tool === 'view_image' && call.outcome === 'ok' && images.length === 0) {
      raw.append(el('p', 'meta', () => t("No image preview was retained in this recording.")));
    }
    if (images.length && (context?.id || runtime.selectedId)) {
      const id = context?.id ?? runtime.selectedId!, generation = runtime.selectionGeneration;
      const attachments = el('div', 'tool-images');
      let loaded = false;
      const load = async () => {
        if (!box.open || loaded) return;
        loaded = true;
        for (const asset of images) {
          const data = await run(api.getSessionImage(id, asset.id));
          if (context ? !context.current() : id !== runtime.selectedId || generation !== runtime.selectionGeneration) return;
          if (!data) { attachments.append(el('p', 'meta', () => t("Image unavailable"))); continue; }
          const image = document.createElement('img');
          image.src = data; image.alt = t("{0} result", [call.tool]); image.loading = 'lazy';
          image.style.cssText = 'display:block;max-width:100%;max-height:600px;object-fit:contain;margin:8px 0';
          attachments.append(image);
        }
      };
      box.addEventListener('toggle', () => void load());
      raw.append(attachments);
      void load();
    }
    if (call.result.assetId) raw.append(el('p', 'raw-facts', () => t("Full recorded response: {0}", [call.result.assetId])));

    for (const asset of call.assets ?? []) {
      raw.append(el('p', 'raw-facts', () => t("asset {0} · {1} · {2} bytes", [asset.id, asset.mimeType, compactNumber(asset.bytes)])));
    }

    box.append(raw);
  }
  return { toolBody };
}
