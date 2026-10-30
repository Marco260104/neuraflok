/** Resolve the nested Vite entry used by the integrated browser toolbar. */
export function integratedBrowserRendererPage(file: string): string {
  return file === 'integrated-browser.html' ? 'features/browser/integrated-browser.html' : file;
}

/** Resolve the development-server URL for an app-owned renderer page. */
export function integratedBrowserRendererUrl(rendererUrl: string, file: string): string {
  const page = integratedBrowserRendererPage(file);
  const base = rendererUrl.endsWith('/') ? rendererUrl : `${rendererUrl}/`;
  return new URL(page, base).toString();
}
