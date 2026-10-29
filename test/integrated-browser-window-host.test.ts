import { expect, it, vi } from 'vitest';
import { createIntegratedBrowserWindowHost } from '../backend/domains/browser/embedded/window-host.js';

it('keeps background tabs laid out but paints only the selected provider tab', () => {
  const inactiveView = { setBounds: vi.fn(), setVisible: vi.fn() };
  const activeView = { setBounds: vi.fn(), setVisible: vi.fn() };
  const base = {
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 1180, height: 820 }),
    contentView: { addChildView: vi.fn() }
  };
  const id = 17;
  const host = createIntegratedBrowserWindowHost({
    assets: {} as never,
    model: { activeTab: () => 22, tabsOf: () => [11, 22] } as never,
    frames: new Map([[id, { base, toolbar: { setBounds: vi.fn() } } as never]]),
    views: new Map([[11, inactiveView], [22, activeView]]) as never,
    getControl: () => ({} as never),
    extensionId: () => '',
    session: () => null,
    appConnected: () => null,
    companionIcon: () => null,
    favicon: () => null,
    isStopping: () => false,
    isQuitting: () => false,
    loadPage: () => undefined,
    notify: () => undefined
  });

  host.layout(id);

  const bounds = { x: 0, y: 40, width: 1180, height: 780 };
  expect(inactiveView.setBounds).toHaveBeenCalledWith(bounds);
  expect(inactiveView.setVisible).toHaveBeenCalledWith(false);
  expect(activeView.setBounds).toHaveBeenCalledWith(bounds);
  expect(activeView.setVisible).toHaveBeenCalledWith(true);
  expect(base.contentView.addChildView).toHaveBeenCalledWith(activeView);
});
