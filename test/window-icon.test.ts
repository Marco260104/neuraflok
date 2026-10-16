import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { packagedRuntime, runningFromDevElectron } from '../backend/infrastructure/desktop-shell/runtime-packaging.js';
import { browserWindowIconPath, unpackagedIconRoot } from '../backend/infrastructure/desktop-shell/window-icon.js';

const require = createRequire(import.meta.url);

describe('native BrowserWindow icon policy', () => {
  it('uses the packaged branded runtime PNG on Linux', () => {
    expect(browserWindowIconPath('linux', true, '/opt/neuraflok/resources')).toBe(
      path.join('/opt/neuraflok/resources', 'runtime-icon.png')
    );
  });

  it.each(['win32', 'darwin'] as const)('preserves native executable/bundle icon semantics on %s', (platform) => {
    expect(browserWindowIconPath(platform, true, '/irrelevant/resources')).toBeUndefined();
  });

  it('does not impose a generated packaging path on Linux development runs', () => {
    expect(browserWindowIconPath('linux', false, '/electron/resources')).toBeUndefined();
  });

  it.each(['win32', 'darwin', 'linux'] as const)('uses the authored LogotipoSN mark for unpackaged %s windows', (platform) => {
    expect(browserWindowIconPath(platform, false, '/electron/resources', '/app')).toBe(
      path.join('/app', 'brand', 'LogotipoSN.png')
    );
  });

  it('prefers the app root that actually contains LogotipoSN', () => {
    const projectRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
    expect(unpackagedIconRoot('/missing', '/compiled')).toBe('/compiled');
    expect(unpackagedIconRoot(projectRoot, '/compiled')).toBe(projectRoot);
  });

  it('treats stamped .dev-electron as unpackaged so Alt-Tab still uses LogotipoSN', () => {
    const stamped = 'C:\\Users\\example\\Desktop\\project\\.dev-electron\\NEURAFLOK.exe';
    expect(runningFromDevElectron(stamped)).toBe(true);
    expect(packagedRuntime(true, stamped)).toBe(false);
    expect(packagedRuntime(true, 'C:/Program Files/NEURAFLOK/NEURAFLOK.exe')).toBe(true);
    expect(packagedRuntime(false, 'C:/electron/electron.exe')).toBe(false);
    expect(
      browserWindowIconPath('win32', packagedRuntime(true, stamped), 'C:/project/.dev-electron/resources', '/app')
    ).toBe(path.join('/app', 'brand', 'LogotipoSN.png'));
  });
});

describe('Windows ICO for Explorer shortcuts', () => {
  it('embeds BMP frames for 16–128 and PNG for 256', () => {
    const ico = readFileSync(new URL('../build/icon.ico', import.meta.url));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const sizes: number[] = [];
    for (let index = 0; index < count; index++) {
      const at = 6 + index * 16;
      const size = ico[at] === 0 ? 256 : ico[at]!;
      const offset = ico.readUInt32LE(at + 12);
      sizes.push(size);
      if (size >= 256) expect(ico.subarray(offset, offset + 4).equals(pngMagic)).toBe(true);
      else {
        expect(ico.readUInt32LE(offset)).toBe(40);
        expect(ico.readInt32LE(offset + 4)).toBe(size);
        expect(ico.readUInt16LE(offset + 14)).toBe(32);
      }
    }
    expect(sizes).toEqual([256, 128, 64, 48, 32, 16]);
  });

  it('keeps BMP frames that resedit can embed into the unpackaged Windows exe', () => {
    const ResEdit = require('resedit') as { Data: { IconFile: { from: (bin: Buffer) => { icons: Array<{ height: number; data: { isIcon: () => boolean } }> } } } };
    const iconFile = ResEdit.Data.IconFile.from(readFileSync(new URL('../build/icon.ico', import.meta.url)));
    expect(iconFile.icons.filter((item) => item.data.isIcon()).map((item) => item.height)).toEqual(
      expect.arrayContaining([16, 32, 48, 64, 128])
    );
  });
});

describe('Windows unpackaged identity', () => {
  it('pins the AppUserModelId before the startup graph', () => {
    const main = readFileSync(new URL('../backend/main.ts', import.meta.url), 'utf8');
    const identity = main.indexOf("import './infrastructure/desktop-shell/windows-app-id.js';");
    const startup = main.indexOf("import './application/startup.js';");
    expect(identity).toBeGreaterThan(-1);
    expect(startup).toBeGreaterThan(identity);
  });

  it('points electron-vite at a resedit-stamped NEURAFLOK.exe and a unique unpackaged AppUserModelId', () => {
    const stamp = readFileSync(new URL('../scripts/stamp-dev-icon.mjs', import.meta.url), 'utf8');
    const identity = readFileSync(new URL('../backend/infrastructure/desktop-shell/windows-app-id.ts', import.meta.url), 'utf8');
    const window = readFileSync(new URL('../backend/application/window-controller.ts', import.meta.url), 'utf8');
    expect(stamp).toContain("brandedDist, 'NEURAFLOK.exe'");
    expect(stamp).toContain('replaceIconsForResource');
    expect(stamp).toContain('process.env.ELECTRON_EXEC_PATH = brandedExe');
    expect(stamp).not.toContain('--app-user-model-id=');
    expect(identity).toContain('com.neuraflok.desktop.dev');
    expect(identity).toContain('writeShortcutLink');
    expect(identity).toContain('setAppDetails');
    expect(window).toContain('applyUnpackagedWindowsTaskbar');
    expect(window).toContain('packagedRuntime');
    expect(identity).toContain('packagedRuntime');
    const tray = readFileSync(new URL('../backend/application/tray-controller.ts', import.meta.url), 'utf8');
    const extension = readFileSync(new URL('../backend/domains/browser/extension-path.ts', import.meta.url), 'utf8');
    expect(tray).toContain('packagedRuntime');
    expect(extension).toContain('packagedRuntime');
    expect(identity).toContain('runningFromDevElectron');
  });
});

describe('input recorder cycle', () => {
  it('does not read noteChatOrigin while the input module initializes', () => {
    const source = readFileSync(new URL('../backend/domains/sessions/input/input.ts', import.meta.url), 'utf8');
    expect(source).toContain('function bindChatOrigin(');
    expect(source).toContain('noteChatOrigin: bindChatOrigin');
    expect(source.split('\n').filter((line) => /^\s*noteChatOrigin,?\s*$/.test(line))).toEqual([]);
  });
});
