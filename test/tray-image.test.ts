import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { packagedRuntime } from '../backend/infrastructure/desktop-shell/runtime-packaging.js';
import { trayGuidArgsForPlatform, trayGuidForPlatform, trayImageSpec, trayMarkPath } from '../backend/infrastructure/desktop-shell/tray-image.js';

const MARK = readFileSync(new URL('../brand/LogotipoSN.png', import.meta.url));

describe('tray image policy', () => {
  it.each(['win32', 'linux'] as const)('paints only the mark on %s, with no status badge', async platform => {
    const connected = await trayImageSpec(platform, true, MARK);
    const disconnected = await trayImageSpec(platform, false, MARK);

    expect(connected.representations[0].png.equals(disconnected.representations[0].png)).toBe(true);
    const { data } = await sharp(connected.representations[0].png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let index = 0; index < data.length; index += 4) {
      expect([data[index], data[index + 1], data[index + 2]]).not.toEqual([34, 160, 90]);
      expect([data[index], data[index + 1], data[index + 2]]).not.toEqual([130, 130, 138]);
    }
    expect(data.some((value, index) => index % 4 === 3 && value > 100)).toBe(true);
  });

  it('uses the macOS template silhouette without a status badge', async () => {
    const connected = await trayImageSpec('darwin', true, MARK);
    const disconnected = await trayImageSpec('darwin', false, MARK);

    expect(connected.template).toBe(true);
    expect(connected.representations[0].png.equals(disconnected.representations[0].png)).toBe(true);
    const { data } = await sharp(connected.representations[0].png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(data.some((value, index) => index % 4 === 3 && value > 100)).toBe(true);
  });

  it.each(['win32', 'darwin', 'linux'] as const)('creates 1x and 2x PNG representations on %s', async platform => {
    const spec = await trayImageSpec(platform, true, MARK);
    const dimensions = await Promise.all(spec.representations.map(async image => {
      const metadata = await sharp(image.png).metadata();
      return [image.scaleFactor, metadata.width, metadata.height];
    }));

    expect(dimensions).toEqual([[1, 16, 16], [2, 32, 32]]);
    expect(spec.template).toBe(platform === 'darwin');
  });

  it('punches LogotipoSN black so the tray mark is not an opaque tile', async () => {
    const spec = await trayImageSpec('win32', false, MARK);
    const { data, info } = await sharp(spec.representations[1].png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let transparent = 0;
    for (let index = 3; index < data.length; index += 4) if (data[index] === 0) transparent += 1;
    expect(transparent).toBeGreaterThan(info.width * info.height * 0.2);
  });

  it('resolves the app mark from development and packaged resource roots', () => {
    expect(trayMarkPath(false, '/app', '/resources')).toBe(path.join('/app', 'brand', 'LogotipoSN.png'));
    expect(trayMarkPath(true, '/app', '/resources')).toBe(path.join('/resources', 'brand', 'LogotipoSN.png'));
    expect(
      trayMarkPath(
        packagedRuntime(true, 'C:/OpenSeek/.dev-electron/NEURAFLOK.exe'),
        '/app',
        'C:/OpenSeek/.dev-electron/resources'
      )
    ).toBe(path.join('/app', 'brand', 'LogotipoSN.png'));
  });

  it('gives only macOS a stable menu-bar autosave identity', () => {
    const macGuid = trayGuidForPlatform('darwin');
    expect(macGuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(trayGuidForPlatform('win32')).toBeUndefined();
    expect(trayGuidForPlatform('linux')).toBeUndefined();
    expect(trayGuidArgsForPlatform('darwin')).toEqual([macGuid]);
    expect(trayGuidArgsForPlatform('win32')).toEqual([]);
    expect(trayGuidArgsForPlatform('linux')).toEqual([]);
  });
});
