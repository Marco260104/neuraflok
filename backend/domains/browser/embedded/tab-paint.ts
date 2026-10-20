export const INTEGRATED_BROWSER_TOOLBAR_HEIGHT = 40;
export const INTEGRATED_BROWSER_FALLBACK_SIZE = { width: 1180, height: 820 } as const;

/** Background provider tabs stay at a real size. Virtualized chats unmount replies when the view is 0×0. */
export function paintedTabBounds(
  contentWidth: number,
  contentHeight: number,
  toolbarHeight = INTEGRATED_BROWSER_TOOLBAR_HEIGHT
) {
  const width = contentWidth > 0 ? contentWidth : INTEGRATED_BROWSER_FALLBACK_SIZE.width;
  const height = contentHeight > toolbarHeight
    ? contentHeight - toolbarHeight
    : INTEGRATED_BROWSER_FALLBACK_SIZE.height - toolbarHeight;
  return { x: 0, y: toolbarHeight, width, height };
}
