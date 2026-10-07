import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

async function readPixel(imagePath, horizontalRatio, verticalRatio, rounding = Math.round) {
  const pixels = await sharp(imagePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const x = rounding(pixels.info.width * horizontalRatio);
  const y = rounding(pixels.info.height * verticalRatio);
  const offset = (y * pixels.info.width + x) * 4;
  return { pixel: Array.from(pixels.data.subarray(offset, offset + 4)), info: pixels.info };
}

function assertGreenMarker(pixel, message) {
  assert.ok(pixel[0] < 10 && pixel[1] > 240 && pixel[2] < 10, message);
}

export async function verifyComposedCapture({
  runElectron,
  fixture,
  foregroundFixture,
  windows,
  directory,
  repository
}) {
  const result = await runElectron('snapshot');
  assert.equal(result.ok, true, JSON.stringify(result));

  const invocationReport = await fixture.request('report');
  assert.equal(invocationReport.invocations, 2, 'Semantic and coordinate clicks must reach the fixture');
  await foregroundFixture.request('quit');
  await fixture.request('occlude');

  assert.equal(result.window, windows.target);
  assert.equal(result.before, result.after);
  assert.equal(result.screenshot.captureMode, 'window');
  assert.equal(result.screenshot.width, 320);
  assert.ok(result.screenshot.frameId > 0);
  assert.ok(windows.popup > 0);
  assert.ok(!result.related.some(item => item.window === windows.occluder), 'An unrelated window was captured');

  const popupIndex = result.related.findIndex(item => item.window === windows.popup);
  assert.ok(popupIndex >= 0, 'The owned popup is missing from related windows');
  const popupImage = result.related[popupIndex];
  assert.ok(popupImage.screenshot, JSON.stringify(popupImage));
  assert.notEqual(popupImage.screenshot.frameId, result.screenshot.frameId);

  const popupSample = await readPixel(path.join(directory, `related-${popupIndex}.png`), 0.5, 0.5, Math.floor);
  assert.ok(
    popupSample.pixel[0] > 240 && popupSample.pixel[1] < 10 && popupSample.pixel[2] > 240,
    'Popup capture contains the wrong pixels'
  );

  const composedPath = path.join(directory, 'electron-capture.png');
  const marker = await readPixel(composedPath, 0.125, 0.25);
  if (!(marker.pixel[0] < 10 && marker.pixel[1] > 240 && marker.pixel[2] < 10)) {
    const diagnostics = path.join(repository, 'outputs', 'windows-capture-validation');
    await mkdir(diagnostics, { recursive: true });
    await writeFile(path.join(diagnostics, 'failed-owned-fixture.png'), await readFile(composedPath));
    throw new Error(`Owned marker mismatch: ${JSON.stringify({ pixel: marker.pixel, image: marker.info, screenshot: result.screenshot })}`);
  }

  return { result, popupImage, invocationReport };
}

export async function verifyNativeWindowCapture({ supervisor, helperScript, fixture, windows, directory }) {
  const helper = supervisor.launchJsonProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', helperScript]);
  const request = value => helper.request(JSON.stringify(value));
  const foregroundBefore = await request({ op: 'active' });
  const imagePath = path.join(directory, 'capture.png');
  const start = performance.now();
  const snapshot = await request({
    op: 'snapshot',
    id: windows.target,
    includeScreenshot: true,
    includeUi: false,
    maxWidth: 320,
    file: imagePath
  });
  const foregroundAfter = await request({ op: 'active' });

  assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  assert.equal(snapshot.captureMode, 'window');
  assert.equal(snapshot.focused, false);
  assert.equal(foregroundAfter.window.id, foregroundBefore.window.id);
  assert.equal(snapshot.image.width, 320);
  assert.ok(snapshot.region.width <= snapshot.windowGeometry.width);

  const sample = await readPixel(imagePath, 0.125, 0.25);
  assertGreenMarker(sample.pixel, 'Native capture contains pixels from an occluding window');

  return {
    request,
    image: snapshot.image,
    region: snapshot.region,
    windowGeometry: snapshot.windowGeometry,
    captureMs: Math.round(performance.now() - start),
    imagePath
  };
}

export async function verifyMinimizedCaptureFailure({ request, fixture, target, imagePath }) {
  await fixture.request('minimize');
  const response = await request({ op: 'capture', id: target, maxWidth: 320, file: imagePath });
  assert.equal(response.ok, false);
  assert.equal(response.error_code, 'CAPTURE_FAILED', JSON.stringify(response));
  return response;
}
