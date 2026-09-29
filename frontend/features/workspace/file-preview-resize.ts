const PREVIEW_HEIGHT_KEY = 'neuraflok.file-preview-height';
const PREVIEW_MIN_HEIGHT = 140;

export function attachFilePreviewResize(body: HTMLElement, pane: HTMLElement, preview: HTMLElement, handle: HTMLElement): void {
  let previewHeight: number | null = null;
  try {
    const saved = Number(window.localStorage.getItem(PREVIEW_HEIGHT_KEY));
    if (Number.isFinite(saved) && saved >= PREVIEW_MIN_HEIGHT) previewHeight = saved;
  } catch { /* Layout persistence is optional. */ }

  function previewMaximum(): number {
    const height = body.getBoundingClientRect().height || body.clientHeight || 400;
    return Math.max(PREVIEW_MIN_HEIGHT, height - 36);
  }

  function currentPreviewHeight(): number {
    if (previewHeight !== null) return previewHeight;
    const measured = preview.getBoundingClientRect().height;
    if (measured > 0) return measured;
    const height = body.getBoundingClientRect().height || body.clientHeight || 400;
    return Math.max(PREVIEW_MIN_HEIGHT, height * 0.52);
  }

  function setPreviewHeight(height: number, persist = false): void {
    previewHeight = Math.round(Math.max(PREVIEW_MIN_HEIGHT, Math.min(previewMaximum(), height)));
    preview.style.height = `${previewHeight}px`;
    handle.setAttribute('aria-valuemin', String(PREVIEW_MIN_HEIGHT));
    handle.setAttribute('aria-valuemax', String(Math.round(previewMaximum())));
    handle.setAttribute('aria-valuenow', String(previewHeight));
    if (persist) {
      try { window.localStorage.setItem(PREVIEW_HEIGHT_KEY, String(previewHeight)); } catch { /* optional */ }
    }
  }

  function resetPreviewHeight(): void {
    previewHeight = null;
    preview.style.removeProperty('height');
    try { window.localStorage.removeItem(PREVIEW_HEIGHT_KEY); } catch { /* optional */ }
    const bodyHeight = body.getBoundingClientRect().height || body.clientHeight || 400;
    const fallback = Math.round(Math.max(PREVIEW_MIN_HEIGHT, Math.min(previewMaximum(), bodyHeight * 0.52)));
    handle.setAttribute('aria-valuemin', String(PREVIEW_MIN_HEIGHT));
    handle.setAttribute('aria-valuemax', String(Math.round(previewMaximum())));
    handle.setAttribute('aria-valuenow', String(fallback));
  }

  let previewDrag: { id: number; y: number; height: number } | null = null;
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || previewDrag) return;
    handle.setPointerCapture(event.pointerId);
    previewDrag = { id: event.pointerId, y: event.clientY, height: currentPreviewHeight() };
    pane.classList.add('is-resizing-file-preview');
    event.preventDefault();
  });
  handle.addEventListener('pointermove', event => {
    if (previewDrag?.id !== event.pointerId) return;
    setPreviewHeight(previewDrag.height + previewDrag.y - event.clientY);
  });
  const finishPreviewResize = (event: PointerEvent): void => {
    if (previewDrag?.id !== event.pointerId) return;
    previewDrag = null;
    pane.classList.remove('is-resizing-file-preview');
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    setPreviewHeight(currentPreviewHeight(), true);
  };
  handle.addEventListener('pointerup', finishPreviewResize);
  handle.addEventListener('pointercancel', finishPreviewResize);
  handle.addEventListener('lostpointercapture', finishPreviewResize);
  handle.addEventListener('dblclick', resetPreviewHeight);
  handle.addEventListener('keydown', event => {
    const height = currentPreviewHeight();
    if (event.key === 'ArrowUp') setPreviewHeight(height + 20, true);
    else if (event.key === 'ArrowDown') setPreviewHeight(height - 20, true);
    else if (event.key === 'Home') setPreviewHeight(PREVIEW_MIN_HEIGHT, true);
    else if (event.key === 'End') setPreviewHeight(previewMaximum(), true);
    else return;
    event.preventDefault();
  });
  const clampPreviewHeight = () => { if (previewHeight !== null) setPreviewHeight(previewHeight); };
  if (typeof ResizeObserver === 'function') new ResizeObserver(clampPreviewHeight).observe(body);
  window.addEventListener('resize', clampPreviewHeight);
  resetPreviewHeight();
}
