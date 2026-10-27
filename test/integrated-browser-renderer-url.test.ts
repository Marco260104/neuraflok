import { expect, it } from 'vitest';
import { integratedBrowserRendererUrl } from '../backend/domains/browser/embedded/renderer-url.js';

it('loads the integrated browser toolbar from its nested Vite source path in development', () => {
  expect(integratedBrowserRendererUrl('http://localhost:5173', 'integrated-browser.html'))
    .toBe('http://localhost:5173/features/browser/integrated-browser.html');
});

it('keeps other renderer pages relative to the configured development root', () => {
  expect(integratedBrowserRendererUrl('http://localhost:5173/', 'index.html'))
    .toBe('http://localhost:5173/index.html');
});
