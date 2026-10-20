import { readRendererMarkup } from '../scripts/read-renderer-markup.cjs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dismissBootSplash, _resetSplashDismissForTesting } from '../frontend/brand-assets.js';

describe('Initial Boot Splash and NF Loader', () => {
  let dom: JSDOM;

  beforeEach(() => {
    vi.useFakeTimers();
    dom = new JSDOM(readRendererMarkup(process.cwd()), { url: 'https://local.test' });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
  });

  afterEach(() => {
    vi.useRealTimers();
    dom?.window.close();
    vi.unstubAllGlobals();
  });

  it('renders the complete NF Vector Loader markup and svg paths', () => {
    const doc = dom.window.document;
    const splash = doc.getElementById('bootSplash');
    expect(splash).not.toBeNull();
    expect(splash?.classList.contains('boot-splash')).toBe(true);

    const loaderWrapper = splash?.querySelector('.nf-loader-wrapper');
    expect(loaderWrapper).not.toBeNull();

    const svg = loaderWrapper?.querySelector('.nf-loader-svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('viewBox')).toBe('0 0 1000 1000');

    // 3 vector logo paths: N, F-top, F-mid
    const pathN = svg?.querySelector('.nf-path.nf-path-n');
    const pathFtop = svg?.querySelector('.nf-path.nf-path-ftop');
    const pathFmid = svg?.querySelector('.nf-path.nf-path-fmid');
    expect(pathN).not.toBeNull();
    expect(pathFtop).not.toBeNull();
    expect(pathFmid).not.toBeNull();

    // Bar and text
    const bar = loaderWrapper?.querySelector('.nf-loader-bar .nf-loader-bar-fill');
    expect(bar).not.toBeNull();

    const text = loaderWrapper?.querySelector('.nf-loader-text');
    expect(text?.textContent?.trim()).toBe('CARGANDO...');
  });

  it('keeps the loader visible until minimum 2.5s duration has elapsed', () => {
    const doc = dom.window.document;
    const splash = doc.getElementById('bootSplash')!;
    expect(splash).not.toBeNull();

    // Mock start time to right now
    _resetSplashDismissForTesting(1000);
    vi.spyOn(performance, 'now').mockReturnValue(1500); // 500ms elapsed

    dismissBootSplash();

    // At 500ms (remaining 2000ms), splash must still NOT be done
    expect(splash.classList.contains('is-done')).toBe(false);

    // Advance 1999ms (total 2499ms elapsed from start)
    vi.advanceTimersByTime(1999);
    expect(splash.classList.contains('is-done')).toBe(false);

    // Advance 1ms more to reach 2000ms delay (2500ms total elapsed)
    vi.advanceTimersByTime(1);
    expect(splash.classList.contains('is-done')).toBe(true);

    // Advance 450ms transition to verify DOM cleanup
    vi.advanceTimersByTime(450);
    expect(doc.getElementById('bootSplash')).toBeNull();
  });

  it('dismisses immediately when called after 2.5s have already passed', () => {
    const doc = dom.window.document;
    const splash = doc.getElementById('bootSplash')!;

    // 3000ms elapsed since startup
    _resetSplashDismissForTesting(1000);
    vi.spyOn(performance, 'now').mockReturnValue(4000);

    dismissBootSplash();

    expect(splash.classList.contains('is-done')).toBe(true);

    vi.advanceTimersByTime(450);
    expect(doc.getElementById('bootSplash')).toBeNull();
  });

  it('dismisses without delay if reduced-motion is requested', () => {
    const doc = dom.window.document;
    const splash = doc.getElementById('bootSplash')!;

    _resetSplashDismissForTesting(1000);
    vi.spyOn(performance, 'now').mockReturnValue(1100); // only 100ms elapsed

    dom.window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as any;

    dismissBootSplash();

    expect(splash.classList.contains('is-done')).toBe(true);
    expect(doc.getElementById('bootSplash')).toBeNull();
  });
});
