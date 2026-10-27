/** Resolve the development-server URL for the integrated browser toolbar page. */
export function integratedBrowserRendererUrl(rendererUrl: string, file: string): string {
  const page = file === 'integrated-browser.html' ? 'features/browser/integrated-browser.html' : file;
  const base = rendererUrl.endsWith('/') ? rendererUrl : `${rendererUrl}/`;
  return new URL(page, base).toString();
}
