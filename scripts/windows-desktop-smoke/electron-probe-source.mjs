import path from 'node:path';

export function buildElectronProbeSource({ repository, directory, fixture }) {
  const nativeIndex = path.join(repository, 'backend/infrastructure/device-control/native/index.ts');
  const windowsApi = path.join(repository, 'backend/infrastructure/device-control/native/windows-api.ts');
  const electronData = path.join(directory, 'electron-data');
  const screenshotPath = path.join(directory, 'electron-capture.png');
  const resultPath = path.join(directory, 'electron-result.json');

  return `
import { app } from 'electron';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { act, activeWindow, getWindowState, listDesktopApps, listWindows, stopComputerHelper } from ${JSON.stringify(nativeIndex)};
import { createWindowsComputerApi } from ${JSON.stringify(windowsApi)};

app.setPath('userData', ${JSON.stringify(electronData)});
const fixtureWindow = ${fixture.target};
const popupWindow = ${fixture.popup};
const resultFile = ${JSON.stringify(resultPath)};
const composedImageFile = ${JSON.stringify(screenshotPath)};
const outputDirectory = ${JSON.stringify(directory)};

async function inspectWindowApi(snapshot) {
  const api = createWindowsComputerApi({
    act,
    listDesktopApps,
    listWindows,
    getWindowState: options => getWindowState({ ...options, maxWidth: 320 })
  });
  const rows = await api.list_windows();
  const target = rows.find(row => row.id === fixtureWindow);
  assert.ok(target?.app, 'Native target is missing from the Windows API');
  assert.deepEqual(await api.get_window({ id: fixtureWindow, app: target.app }), target);

  const popup = await api.get_window({ id: popupWindow });
  assert.equal(popup.app, target.app, 'Owned popup application identity changed');
  const apps = await api.list_apps();
  const owner = apps.find(appInfo => appInfo.id === target.app);
  assert.ok(owner?.isRunning && owner.windows.some(row => row.id === fixtureWindow), 'App membership is missing');
  for (const appInfo of apps) {
    for (const row of appInfo.windows) assert.equal(row.app, appInfo.id);
  }

  const defaultState = await api.get_window_state({ window: target });
  assert.equal(defaultState.accessibility, null, 'Default window state unexpectedly exposes text');
  assert.equal(defaultState.screenshots.length, 1 + snapshot.related.filter(row => row.screenshot).length);
  assert.ok(defaultState.screenshots.every(image => image.url.startsWith('data:image/png;base64,') && image.width > 0 && image.height > 0));
  assert.equal(new Set(defaultState.screenshots.map(image => image.id)).size, defaultState.screenshots.length);

  const popupFrame = snapshot.related.find(row => row.window.id === popup.id)?.screenshot;
  assert.ok(popupFrame, 'Owned popup screenshot is missing');
  assert.ok(defaultState.screenshots.some(image =>
    image.originX === popupFrame.region.x && image.originY === popupFrame.region.y &&
    image.width === popupFrame.width && image.height === popupFrame.height
  ), 'Popup screenshot coordinates do not match the owned window');
  for (const image of defaultState.screenshots) {
    const png = Buffer.from(image.url.split(',')[1], 'base64');
    assert.equal(image.width, png.readUInt32BE(16));
    assert.equal(image.height, png.readUInt32BE(20));
  }

  const textState = await api.get_window_state({ window: target, include_text: true });
  assert.ok(textState.accessibility?.tree, 'Explicit accessibility tree is missing');
  const invokeRow = textState.accessibility.tree.split('\\n')
    .find(row => row.includes('"Smoke Invoke"') && row.includes('[Invoke'));
  assert.ok(invokeRow, 'Owned button is missing from the indexed tree');
  const textOnly = await api.get_window_state({ window: target, include_text: true, include_screenshot: false });
  assert.equal(textOnly.screenshots.length, 0);
  assert.equal(textOnly.accessibility.tree, textState.accessibility.tree);

  const filtered = await api.get_window_state({
    window: target,
    query: 'Smoke Invoke',
    role: 'Button',
    max_elements: 5,
    include_screenshot: false
  });
  const matches = filtered.accessibility.tree.split('\\n').filter(Boolean);
  assert.equal(matches.length, 1, 'Native search returned unexpected controls');
  assert.ok(matches[0].includes('"Smoke Invoke"') && matches[0].includes('[Invoke'));
  const elementIndex = Number(matches[0].trim().split(':')[0]);
  assert.equal(elementIndex, 0, 'Filtered control indexes must start at zero');
  assert.ok(Number.isInteger(Number(invokeRow.trim().split(':')[0])));

  return {
    api,
    target,
    popup,
    elementIndex,
    apps,
    screenshots: defaultState.screenshots.map(({ url, ...image }) => image)
  };
}

async function inspectSnapshot() {
  const foregroundBefore = await activeWindow();
  const snapshot = await getWindowState({ window: fixtureWindow, maxWidth: 320, includeUi: false, includeRelated: true });
  const foregroundAfter = await activeWindow();
  if (!snapshot.screenshot) throw new Error('Composed screenshot is missing');

  await writeFile(composedImageFile, Buffer.from(snapshot.screenshot.data, 'base64'));
  const { data, ...image } = snapshot.screenshot;
  const related = [];
  for (const [index, item] of (snapshot.related ?? []).entries()) {
    if (item.screenshot) {
      await writeFile(outputDirectory + '/related-' + index + '.png', Buffer.from(item.screenshot.data, 'base64'));
    }
    const { data: ignored, ...metadata } = item.screenshot ?? {};
    related.push({ window: item.window.id, screenshot: item.screenshot ? metadata : null, error: item.error });
  }

  const windowApi = await inspectWindowApi({ related });
  assert.equal((await activeWindow()).window?.id, foregroundBefore.window?.id, 'Observation changed the foreground window');
  await windowApi.api.perform_secondary_action({
    window: windowApi.target,
    element_index: windowApi.elementIndex,
    action: 'Invoke'
  });
  await windowApi.api.get_window_state({ window: windowApi.target });
  await windowApi.api.click({
    window: windowApi.target,
    x: (${fixture.invokeX} - snapshot.screenshot.region.x) * snapshot.screenshot.scale,
    y: (${fixture.invokeY} - snapshot.screenshot.region.y) * snapshot.screenshot.scale
  });

  return {
    ok: true,
    before: foregroundBefore.window?.id,
    after: foregroundAfter.window?.id,
    window: snapshot.window.id,
    screenshot: image,
    related,
    windowsApi: {
      app: windowApi.target.app,
      catalogCount: windowApi.apps.length,
      membershipVerified: true,
      defaultTextAbsent: true,
      textIndexesVerified: true,
      semanticInvocationRequested: true,
      popupIdentityVerified: true,
      screenshots: windowApi.screenshots
    }
  };
}

app.whenReady().then(async () => {
  let outcome;
  try {
    const operation = process.argv[2];
    if (operation === 'snapshot') outcome = await inspectSnapshot();
    else if (operation === 'paste') outcome = { ok: true, result: await act([{ type: 'paste', text: 'a\\nb\\r\\nc' }], { window: fixtureWindow }) };
    else throw new Error('Unknown probe operation');
  } catch (error) {
    outcome = { ok: false, error: String(error) };
  }

  await writeFile(resultFile, JSON.stringify(outcome));
  await stopComputerHelper();
  app.exit(outcome.ok ? 0 : 1);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
`;
}
