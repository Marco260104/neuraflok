const APP_MARK = new URL('../brand/LogotipoSN.png', import.meta.url).href;
const WORDMARK = new URL('../brand/Logotipo.png', import.meta.url).href;

export function mountBrandAssets(): void {
  const mark = document.querySelector<HTMLImageElement>('[data-brand-mark]');
  const wordmark = document.querySelector<HTMLImageElement>('[data-brand-wordmark]');
  if (mark) mark.src = APP_MARK;
  if (wordmark) wordmark.src = WORDMARK;
}

export const SPLASH_MIN_DURATION_MS = 2500;
let splashStartTime = (typeof performance !== 'undefined' && typeof performance.now === 'function')
  ? performance.now()
  : Date.now();

let dismissScheduled = false;

export function _resetSplashDismissForTesting(newStartTime?: number): void {
  dismissScheduled = false;
  if (newStartTime !== undefined) {
    splashStartTime = newStartTime;
  }
}

export function dismissBootSplash(): void {
  const splash = document.getElementById('bootSplash');
  if (!splash) return;
  if (dismissScheduled) return;
  dismissScheduled = true;

  const href = typeof window !== 'undefined' && window.location ? window.location.href : '';
  const harness = href ? (new URL(href).searchParams.has('reset') || new URL(href).searchParams.has('theme')) : false;
  const reduce = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

  const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? performance.now()
    : Date.now();
  const elapsed = now - splashStartTime;
  const remaining = (reduce || harness) ? 0 : Math.max(0, SPLASH_MIN_DURATION_MS - elapsed);

  const hide = (): void => {
    splash.classList.add('is-done');
    if (reduce || harness) {
      splash.remove();
    } else {
      window.setTimeout(() => splash.remove(), 450);
    }
  };

  if (remaining <= 0) {
    hide();
  } else {
    window.setTimeout(hide, remaining);
  }
}
