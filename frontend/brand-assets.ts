const APP_MARK = new URL('../brand/LogotipoSN.png', import.meta.url).href;
const WORDMARK = new URL('../brand/Logotipo.png', import.meta.url).href;

export function mountBrandAssets(): void {
  const mark = document.querySelector<HTMLImageElement>('[data-brand-mark]');
  const wordmark = document.querySelector<HTMLImageElement>('[data-brand-wordmark]');
  if (mark) mark.src = APP_MARK;
  if (wordmark) wordmark.src = WORDMARK;
}

export function dismissBootSplash(): void {
  const splash = document.getElementById('bootSplash');
  if (!splash) return;
  const href = window.location.href;
  const harness = new URL(href).searchParams.has('reset') || new URL(href).searchParams.has('theme');
  const reduce = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : true;
  const hide = (): void => {
    splash.classList.add('is-done');
    window.setTimeout(() => splash.remove(), reduce || harness ? 0 : 380);
  };
  if (reduce || harness) {
    hide();
    return;
  }
  window.setTimeout(hide, 420);
}
