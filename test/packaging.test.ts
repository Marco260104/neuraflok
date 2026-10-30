// @ts-expect-error The target planner is a plain Node script without type declarations.
import { releaseTargets } from '../scripts/release-targets.mjs';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-ignore js-yaml is a transitive electron-builder dependency; tests only need its runtime parser.
import { load as loadYaml } from 'js-yaml';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import * as packagingVersions from '../scripts/packaging-versions.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import * as targetPlatforms from '../scripts/packaging/target-platforms.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import * as targetOptions from '../scripts/packaging/target-options.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import * as nativeArtifacts from '../scripts/packaging/native-artifacts.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import { assertReleaseAbsent } from '../scripts/check-release-absent.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import { publishStableRelease } from '../scripts/circleci/publish-release.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import { validateRelease } from '../scripts/circleci/validate-release.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import * as macOSAuditUtils from '../scripts/macos-audit-utils.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import * as desktopBuildOptions from '../scripts/packaging/desktop-build-options.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import * as desktopBuildPlan from '../scripts/packaging/desktop-build-plan.mjs';
// @ts-ignore Build scripts are intentionally plain ESM JavaScript.
import * as desktopBuildRunner from '../scripts/packaging/desktop-build-runner.mjs';
const { RIPGREP } = packagingVersions;
const {
  assertCompatibleMacOSDeploymentTargets,
  assertNoTrustBearingMacCodeSignature,
  macOSDeploymentTargetsFromOtool,
  withOtoolSafePath
} = macOSAuditUtils;
const { parseDesktopBuildOptions } = desktopBuildOptions;
const { createDesktopBuildPlan } = desktopBuildPlan;
const { executeDesktopBuildPlan } = desktopBuildRunner;
const {
  normalizeArch,
  normalizePlatform,
  parseTarget,
  PLATFORM_INFO,
  sharpPackagesFor,
  SUPPORTED_ARCHES,
  SUPPORTED_PLATFORMS,
  tarExecutableForPlatform,
  unpackedDirectoryPattern
} = { ...targetPlatforms, ...targetOptions, ...nativeArtifacts };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function yamlFile(relative: string): any {
  return loadYaml(readFileSync(path.join(root, ...relative.split('/')), 'utf8'));
}

describe('cross-platform packaging targets', () => {
  it('packages every extension entry from the current manifest in the release archive', () => {
    const manifest = JSON.parse(readFileSync(path.join(root, 'browser-extension/manifest.json'), 'utf8')) as {
      background: { service_worker: string };
      action: { default_popup: string };
      icons: Record<string, string>;
      content_scripts: Array<{ js: string[]; css?: string[] }>;
    };
    const assembly = readFileSync(path.join(root, 'scripts/circleci/assemble-release.mjs'), 'utf8');
    const manifestFiles = [
      'manifest.json',
      'build-stamp.txt',
      manifest.background.service_worker,
      manifest.action.default_popup,
      ...Object.values(manifest.icons),
      ...manifest.content_scripts.flatMap(script => [...script.js, ...(script.css || [])]),
      '_locales/en/messages.json',
      'LICENSE',
      'NOTICE'
    ];

    expect(assembly).toContain("path.join(root, 'browser-extension')");
    expect(assembly).toContain("'-x', '*.map', '**/*.map'");
    expect(manifestFiles).toEqual(expect.arrayContaining([
      'manifest.json', 'build-stamp.txt', '_locales/en/messages.json', 'LICENSE', 'NOTICE'
    ]));
  });

  it('normalizes supported OS spellings and rejects unsupported targets', () => {
    expect(normalizePlatform('windows')).toBe('win32');
    expect(normalizePlatform('macos')).toBe('darwin');
    expect(normalizePlatform('linux')).toBe('linux');
    expect(normalizeArch('x64')).toBe('x64');
    expect(normalizeArch('arm64')).toBe('arm64');
    expect(() => normalizePlatform('freebsd')).toThrow(/Unsupported packaging platform/);
    expect(() => normalizeArch('ia32')).toThrow(/Unsupported packaging architecture/);
  });

  it('parses separated and inline target options and rejects missing values', () => {
    expect(parseTarget(['--platform', 'macos', '--arch', 'arm64'])).toEqual({ platform: 'darwin', arch: 'arm64' });
    expect(parseTarget(['--platform=windows', '--arch=x64'])).toEqual({ platform: 'win32', arch: 'x64' });
    expect(() => parseTarget(['--platform'])).toThrow(/requires a value/);
  });

  it('pins ripgrep for every release OS/CPU pair', () => {
    for (const platform of SUPPORTED_PLATFORMS) {
      for (const arch of SUPPORTED_ARCHES) {
        expect(RIPGREP.targets[platform][arch].sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(PLATFORM_INFO[platform].builderFlag).toMatch(/^--(?:win|mac|linux)$/);
      }
    }
    expect(RIPGREP.targets.linux.x64.triple).toBe('unknown-linux-musl');
    expect(RIPGREP.targets.linux.arm64.triple).toBe('unknown-linux-musl');
  });

  it('selects only target Sharp packages and unpacked directory families', () => {
    expect(sharpPackagesFor('win32', 'x64')).toEqual(['@img/sharp-win32-x64']);
    expect(sharpPackagesFor('darwin', 'arm64')).toEqual([
      '@img/sharp-darwin-arm64',
      '@img/sharp-libvips-darwin-arm64'
    ]);
    expect(sharpPackagesFor('linux', 'x64')).toEqual([
      '@img/sharp-linux-x64',
      '@img/sharp-libvips-linux-x64'
    ]);
    expect(unpackedDirectoryPattern('win32').test('win-arm64-unpacked')).toBe(true);
    expect(unpackedDirectoryPattern('darwin').test('mac-arm64')).toBe(true);
    expect(unpackedDirectoryPattern('linux').test('linux-unpacked')).toBe(true);
    expect(unpackedDirectoryPattern('linux').test('mac-arm64')).toBe(false);
  });

  it('uses the host archive command spelling on every CI operating system', () => {
    expect(tarExecutableForPlatform('win32')).toBe('tar.exe');
    expect(tarExecutableForPlatform('darwin')).toBe('tar');
    expect(tarExecutableForPlatform('linux')).toBe('tar');
  });

  it('keeps scripts for all six release targets and legacy Windows aliases', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const script of [
      'dist', 'dist:x64', 'dist:arm64',
      'dist:mac:x64', 'dist:mac:arm64',
      'dist:linux:x64', 'dist:linux:arm64'
    ]) expect(pkg.scripts[script]).toBeTypeOf('string');
  });

  it('pins Electron 44.3.0 exactly and proves packaged runners use those runtime bytes', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const smoke = readFileSync(path.join(root, 'scripts', 'smoke-packaged-runtime.mjs'), 'utf8');

    expect(pkg.devDependencies.electron).toBe('44.3.0');
    expect(lock.packages?.['']?.devDependencies?.electron).toBe('44.3.0');
    expect(lock.packages?.['node_modules/electron']?.version).toBe('44.3.0');
    expect(smoke).toContain('const expectedElectronVersion = sourcePackage.devDependencies?.electron;');
    expect(smoke).toContain('electron: process.versions.electron');
    expect(smoke).toContain('runtime.electron !== expectedElectronVersion');
    expect(smoke).not.toContain('@modelcontextprotocol/');
    expect(smoke).not.toContain('runtime.mcp');
  });

  it('grants sandbox read access only to the Windows install tree and fails on ACL errors', () => {
    const config = yamlFile('electron-builder.yml');
    const installer = readFileSync(path.join(root, 'scripts/windows-installer-acl.nsh'), 'utf8');
    expect(config.nsis.license).toBe('LICENSE');
    expect(config.nsis.include).toBe('scripts/windows-installer-acl.nsh');
    expect(installer).toContain('!macro customInit');
    expect(installer).toContain('!macro customInstall');
    expect(installer).toContain('${FileExists} "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"');
    expect(installer).toContain('ExecWait');
    expect(installer).toContain('"$SYSDIR\\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-2:(OI)(CI)(RX)"');
    expect(installer).toContain('${If} ${Errors}');
    expect(installer).toContain('${If} $0 != 0');
    expect(installer).toContain('SetErrorLevel 2');
    expect(installer).toContain('Abort "Windows could not set the folder access needed');
    expect(installer).not.toMatch(/\/(?:reset|remove|T)\b/i);
    expect(installer).not.toMatch(/(?:no-sandbox|disable-gpu-sandbox)/i);
  });

  it('keeps common and stable release targets defined independently of CI', () => {
    expect(releaseTargets('common').include.map((target: { name: string }) => target.name)).toEqual(['Windows x64', 'macOS arm64', 'Linux x64']);
    expect(releaseTargets('common').files).toEqual(['NEURAFLOK-Setup-x64.exe', 'NEURAFLOK-macOS-arm64.dmg',
      'NEURAFLOK-macOS-arm64.zip', 'NEURAFLOK-Linux-x64.AppImage', 'NEURAFLOK-Linux-x64.deb',
      'NEURAFLOK-Provider-Extension.zip', 'NEURAFLOK-Native-Sources.tar.gz']);
    expect(releaseTargets('all').include).toHaveLength(6);
    expect(() => releaseTargets('some')).toThrow();
  });

  it('runs verification and all installer builds through CircleCI with tag-gated publishing', () => {
    const circle = yamlFile('.circleci/config.yml');
    const workflow = circle.workflows['stable-release'];
    const jobs = workflow.jobs as Array<string | Record<string, any>>;
    const names = jobs.map(job => {
      if (typeof job === 'string') return job;
      const name = Object.keys(job)[0]!;
      return job[name]?.name || name;
    });
    const source = readFileSync(path.join(root, 'scripts/circleci/assemble-release.mjs'), 'utf8');
    const publisher = readFileSync(path.join(root, 'scripts/circleci/publish-release.mjs'), 'utf8');

    expect(circle.jobs.verify.docker[0].image).toBe('cimg/node:22');
    expect(JSON.stringify(circle.jobs.verify.steps)).toContain('npm run verify:ci');
    expect(circle.jobs['build-windows'].executor.name).toBe('win/server-2022');
    expect(JSON.stringify(circle.jobs['build-windows'].steps).match(/Remove-Item Env:CIRCLE_BUILD_NUM/g)).toHaveLength(2);
    expect(circle.jobs['build-macos'].resource_class).toBe('m4pro.medium');
    expect(JSON.stringify(circle.jobs['build-macos'].steps)).toContain('unset CIRCLE_BUILD_NUM');
    expect(JSON.stringify(circle.jobs['build-linux-x64'].steps)).toContain('unset CIRCLE_BUILD_NUM');
    expect(JSON.stringify(circle.jobs['build-linux-arm64'].steps)).toContain('unset CIRCLE_BUILD_NUM');
    expect(circle.jobs['build-linux-arm64'].resource_class).toBe('arm.medium');
    expect(names).toEqual(expect.arrayContaining([
      'validate-release', 'build-windows-all', 'build-macos-all', 'build-linux-x64',
      'build-linux-arm64', 'assemble-release', 'publish-release'
    ]));
    const validateJob = jobs.find(job => typeof job !== 'string' && Object.hasOwn(job, 'validate-release')) as Record<string, any>;
    expect(String(validateJob['validate-release'].filters.tags.only)).toMatch(/v\\d\+\\\./);
    expect(JSON.stringify(workflow)).toContain('neuraflok-release');
    expect(source).toContain('releaseTargets(scope)');
    expect(source).toContain('verifyReleaseAssets');
    expect(publisher).toContain('refusing to replace it');
    expect(publisher).toContain('draft: true');
    expect(publisher).toContain('draft: false');
    expect(existsSync(path.join(root, '.github', 'workflows'))).toBe(false);
  });

  it('packages the whole browser extension directory while excluding source maps', () => {
    const assemble = readFileSync(path.join(root, 'scripts/circleci/assemble-release.mjs'), 'utf8');
    expect(assemble).toContain("path.join(root, 'browser-extension')");
    expect(assemble).toContain("'-x', '*.map', '**/*.map'");
    expect(assemble).toContain('NEURAFLOK-Provider-Extension.zip');
  });
  it('only reports renderer readiness after the initial state snapshot has completed', () => {
    const ipc = readFileSync(path.join(root, 'backend/application/ipc', 'system.ts'), 'utf8');
    const handler = ipc.indexOf("handle('state:get', async () => {");
    const state = ipc.indexOf('const state = await buildState();', handler);
    const ready = ipc.indexOf("logInfo('renderer state ready');", state);
    const returned = ipc.indexOf('return state;', ready);

    expect(handler).toBeGreaterThan(-1);
    expect(state).toBeGreaterThan(handler);
    expect(ready).toBeGreaterThan(state);
    expect(returned).toBeGreaterThan(ready);
  });

  it('keeps a losing second instance out of the async primary bootstrap', () => {
    const main = readFileSync(path.join(root, 'backend/application', 'startup.ts'), 'utf8');
    const lock = main.indexOf('const hasSingleInstanceLock = app.requestSingleInstanceLock();');
    const losingBranch = main.indexOf('if (!hasSingleInstanceLock) {', lock);
    const markQuitting = main.indexOf('quitting = true;', losingBranch);
    const ready = main.indexOf('void app.whenReady().then(async () => {', losingBranch);
    const readyGuard = main.indexOf('if (!shouldBeginAppBootstrap(hasSingleInstanceLock, quitting)) return;', ready);
    const firstSharedStateRead = main.indexOf("const userData = app.getPath('userData');", ready);

    expect(lock).toBeGreaterThan(-1);
    expect(losingBranch).toBeGreaterThan(lock);
    expect(markQuitting).toBeGreaterThan(losingBranch);
    expect(markQuitting).toBeLessThan(ready);
    expect(readyGuard).toBeGreaterThan(ready);
    expect(readyGuard).toBeLessThan(firstSharedStateRead);

    const beforeQuit = main.indexOf("app.on('before-quit', () => {");
    const beforeQuitOwner = main.indexOf('if (!ownsAppRuntime(hasSingleInstanceLock)) return;', beforeQuit);
    const beforeQuitMutation = main.indexOf('quitting = true;', beforeQuit);
    const windowAllClosed = main.indexOf("app.on('window-all-closed', () => {");
    const windowAllOwner = main.indexOf('if (!ownsAppRuntime(hasSingleInstanceLock)) return;', windowAllClosed);
    const windowAllConfig = main.indexOf('getConfig().ui.minimizeToTray', windowAllClosed);
    const willQuit = main.indexOf("app.on('will-quit', (event) => {");
    const willQuitOwner = main.indexOf('if (!ownsAppRuntime(hasSingleInstanceLock)) return;', willQuit);
    const preventDefault = main.indexOf('event.preventDefault();', willQuit);

    expect(beforeQuitOwner).toBeGreaterThan(beforeQuit);
    expect(beforeQuitOwner).toBeLessThan(beforeQuitMutation);
    expect(windowAllOwner).toBeGreaterThan(windowAllClosed);
    expect(windowAllOwner).toBeLessThan(windowAllConfig);
    expect(willQuitOwner).toBeGreaterThan(willQuit);
    expect(willQuitOwner).toBeLessThan(preventDefault);
  });

  it('applies the persisted native theme before the first packaged BrowserWindow can be created', () => {
    const main = readFileSync(path.join(root, 'backend/application', 'startup.ts'), 'utf8');
    const ready = main.indexOf('void app.whenReady().then(async () => {');
    const loadConfig = main.indexOf('await loadConfig();', ready);
    const theme = main.indexOf('nativeTheme.themeSource = getConfig().ui.theme;', loadConfig);
    const enableActivation = main.indexOf('windowActivation.enable();', theme);
    const firstWindowRequest = main.indexOf('windowActivation.request();', enableActivation);

    expect(ready).toBeGreaterThan(-1);
    expect(loadConfig).toBeGreaterThan(ready);
    expect(theme).toBeGreaterThan(loadConfig);
    expect(enableActivation).toBeGreaterThan(theme);
    expect(firstWindowRequest).toBeGreaterThan(enableActivation);

    const ipc = readFileSync(path.join(root, 'backend/application/ipc', 'settings.ts'), 'utf8');
    const save = ipc.indexOf("handle('settings:save', async (payload) => {");
    const liveTheme = ipc.indexOf('nativeTheme.themeSource = next.ui.theme;', save);
    const background = ipc.indexOf('getWindow()?.setBackgroundColor(windowBackgroundForTheme(next.ui.theme, next.ui.appearance));', liveTheme);
    expect(save).toBeGreaterThan(-1);
    expect(liveTheme).toBeGreaterThan(save);
    expect(background).toBeGreaterThan(liveTheme);
  });

  it('uses Noble-compatible Linux packages and a FUSE-independent AppImage runtime', () => {
    const builder = yamlFile('electron-builder.yml');
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const iconScript = readFileSync(path.join(root, 'scripts', 'make-icon.mjs'), 'utf8');
    expect(builder.toolsets.appimage).toBe('1.0.3');
    expect(builder.linux.artifactName).toBe('NEURAFLOK-Linux-${env.NEURAFLOK_PACKAGE_ARCH}.${ext}');
    expect(builder.deb.depends).toContain('libgtk-3-0 | libgtk-3-0t64');
    expect(builder.deb.depends).toContain('libatspi2.0-0 | libatspi2.0-0t64');
    expect(builder.linux.syncDesktopName).toBe(true);
    expect(pkg.license).toBe('MIT');
    expect(pkg.author).toEqual({
      name: 'NEURAFLOK contributors',
      email: 'noreply@github.com',
    });
    expect(pkg.desktopName).toBe('com.neuraflok.desktop');
    expect(pkg.homepage).toBeUndefined();
    expect(iconScript).toContain("build', 'icon.png'), pngFor(1024)");
    expect(iconScript).toContain('colourType !== 2 && colourType !== 6');
    expect(iconScript).toContain("brand', 'LogotipoSN.png'");
    expect(iconScript).toContain('function encodeBmpIcon');
    expect(pkg.scripts.dev).toContain('stamp-dev-icon.mjs');
    const stampScript = readFileSync(path.join(root, 'scripts', 'stamp-dev-icon.mjs'), 'utf8');
    expect(stampScript).toContain('process.env.ELECTRON_EXEC_PATH = brandedExe');
    expect(stampScript).toContain('replaceIconsForResource');
    expect(stampScript).toContain("brandedDist, 'NEURAFLOK.exe'");
    expect(iconScript).toContain("size >= 256 ? pngFor(size) : encodeBmpIcon(size, pixelsFor(size))");
    expect(builder.nsis.installerIcon).toBe('build/icon.ico');
    expect(builder.nsis.uninstallerIcon).toBe('build/icon.ico');
    expect(builder.nsis.installerHeaderIcon).toBe('build/icon.ico');

    expect(parseDesktopBuildOptions([
      '--platform', 'macos', '--arch=x64,arm64', '--dir'
    ])).toEqual({ platform: 'darwin', architectures: ['x64', 'arm64'], directoryOnly: true });
    const plan = createDesktopBuildPlan({
      nodeExecutable: process.execPath,
      platform: 'darwin',
      architectures: ['arm64'],
      directoryOnly: true,
      environment: { PATH: 'release-path' }
    }) as Array<{ name: string; command: string; args: string[]; environment?: Record<string, string | undefined> }>;
    expect(plan[0]?.args).toEqual(['-e', "require('electron')"]);
    expect(plan.map(step => step.name)).toEqual([
      'load-electron-runtime', 'write-dependency-notices', 'create-desktop-icons',
      'fingerprint-browser-extension', 'bundle-desktop-application', 'stage-ripgrep',
      'stage-native-runtime', 'prepare-platform-helper', 'assemble-desktop-package',
      'smoke-test-package'
    ]);
    const builderStep = plan.find(step => step.name === 'assemble-desktop-package');
    if (!builderStep) throw new Error('The desktop package step is missing from the plan.');
    expect(builderStep.args).toEqual([
      path.join('node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
      '--mac', '--arm64', '--publish', 'never', '--dir'
    ]);
    expect(builderStep.environment).toMatchObject({ PATH: 'release-path', NEURAFLOK_PACKAGE_ARCH: 'arm64' });
    expect(plan.at(-1)?.args).toEqual([
      'scripts/smoke-packaged-runtime.mjs', '--platform', 'darwin', '--arch', 'arm64'
    ]);
    const linuxSmoke = readFileSync(path.join(root, 'scripts/circleci/smoke-linux-release.sh'), 'utf8');
    const macSmoke = readFileSync(path.join(root, 'scripts/circleci/smoke-macos-release.sh'), 'utf8');
    expect(linuxSmoke).toContain('XDG_CONFIG_HOME="$smoke_root/config"');
    expect(linuxSmoke).toContain('xvfb-run -a /usr/bin/neuraflok');
    expect(linuxSmoke).toContain('dpkg-deb --field "$deb" Architecture');
    expect(linuxSmoke).toContain('dpkg-query -S "$installed_executable"');
    expect(linuxSmoke).toContain('assert_gui_stays_ready');
    expect(linuxSmoke).toContain('Captured output:');
    expect(linuxSmoke).toContain('fake_bin/unshare');
    expect(linuxSmoke).not.toContain('ELECTRON_RUN_AS_NODE');
    expect(macSmoke).toContain('hdiutil verify "$dmg"');
    expect(macSmoke).toContain('codesign --display --verbose=4 "$dmg"');
    expect(macSmoke).toContain('test "$(readlink "$mount_dir/Applications")" = /Applications');
    expect(macSmoke).toContain('ditto -x -k "$zip" "$zip_dir"');
    expect(macSmoke).toContain('node scripts/smoke-macos-gui.mjs "$arch"');

    const security = readFileSync(path.join(root, 'SECURITY.md'), 'utf8');
    expect(security).toContain('--no-sandbox');
    expect(security).toMatch(/unprivileged user namespaces/i);
  });

  it('stops packaging after the first failed command and preserves its exit code', () => {
    const launched: string[] = [];
    let failure: any;
    try {
      executeDesktopBuildPlan([
        { name: 'prepare', command: process.execPath, args: [] },
        { name: 'assemble', command: process.execPath, args: [] }
      ], {
        root,
        environment: {},
        spawn: (command: string) => {
          launched.push(command);
          return { error: null, status: 7 };
        }
      });
    } catch (error) {
      failure = error;
    }

    expect(launched).toEqual([process.execPath]);
    expect(failure).toMatchObject({ exitCode: 7, message: 'Packaging step prepare failed.' });
  });

  it('keeps the static AppImage sandbox fallback conditional and duplicate-safe', () => {
    // Read the shipped template rather than requiring app-builder-lib to render it. The assertions below are on the template's own text, so loading that dependency graph buys no coverage and is the reason this case could hit the global 30s timeout under full-suite contention while passing in about 1.5s alone.
    const source = readFileSync(
      path.join(root, 'node_modules', 'app-builder-lib', 'out', 'targets', 'appimage', 'appImageUtil.js'),
      'utf8'
    );

    expect(source).toContain('HAVE_NO_SANDBOX=0');
    expect(source).toContain('if [ "$arg" = --no-sandbox ] ; then');
    expect(source).toContain('if [ $HAVE_NO_SANDBOX -eq 0 ] && ! unshare -Ur true 2>/dev/null ; then');
    expect(source).toContain('NO_SANDBOX=(--no-sandbox)');
    expect(source).toContain('exec "$BIN" "\\${NO_SANDBOX[@]}" "\\${args[@]}"');
  });

  it('pins the current macOS release to unsigned thin native bundles with explicit metadata checks', () => {
    const builder = yamlFile('electron-builder.yml');
    const macSmoke = readFileSync(path.join(root, 'scripts', 'smoke-macos-bundle.mjs'), 'utf8');
    expect(builder.mac.identity).toBeNull();
    expect(builder.mac.notarize).toBe(false);
    expect(builder.mac.category).toBe('public.app-category.developer-tools');
    expect(builder.mac.minimumSystemVersion).toBe('13.0');
    expect(builder.mac.artifactName).toBe('NEURAFLOK-macOS-${arch}.${ext}');
    expect(builder.mac.extendInfo.NSUserNotificationAlertStyle).toBe('alert');
    const nativePrep = readFileSync(path.join(root, 'scripts', 'prepare-packaging-native.mjs'), 'utf8');
    expect(nativePrep).toContain("await chmod(path.join(payloadRoot, 'node-pty', 'prebuilds', prebuildDir, 'spawn-helper'), 0o755)");
    for (const marker of [
      "CFBundleIdentifier: 'com.neuraflok.desktop'",
      "CFBundleExecutable: 'NEURAFLOK'",
      "CFBundleName: 'NEURAFLOK'",
      "CFBundleDisplayName: 'NEURAFLOK'",
      "CFBundleIconFile: 'icon.icns'",
      'CFBundleShortVersionString: packageVersion',
      'CFBundleVersion: packageVersion',
      "LSApplicationCategoryType: 'public.app-category.developer-tools'",
      "LSMinimumSystemVersion: '13.0'",
      'NSScreenCaptureUsageDescription:',
      "path.join(resources, 'desktop', 'macos-desktop-addon.node')",
      "path.join(resources, 'desktop', 'libneuraflok-desktop.dylib')",
      "path.join(ptyDir, 'spawn-helper')",
      "run('lipo', ['-archs', file])",
      "withOtoolSafePath(file, (otoolPath) => run('otool', ['-l', otoolPath]).stdout)",
      'walkFiles(contents)',
      "normalized.includes('.app/Contents/MacOS/')",
      "path.basename(file) === 'chrome_crashpad_handler'",
      "path.basename(file) === 'macos-desktop-addon.node'",
      'requireThinMachO(desktopAddon, true)',
      'requireThinMachO(desktopLibrary, true)',
      'requireThinMachO(file, launched)',
      'launchedMachOCount < 6',
      "run('plutil', ['-extract', key, 'raw', plist])",
      "run('codesign', ['--display', '--verbose=4', app]",
      "run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])",
      'assertNoTrustBearingMacCodeSignature(',
      "path.join(contents, '_CodeSignature', 'CodeResources')"
    ]) expect(macSmoke).toContain(marker);
    expect(macSmoke).not.toContain('tree-sitter');
    expect(macSmoke).not.toContain("'12.3'");
    expect(macSmoke).toContain("requireFile(path.join(resources, 'icon.icns'))");
    expect(macSmoke).toContain("iconBytes.toString('ascii', 0, 4) !== 'icns'");
    const packagedRuntime = readFileSync(path.join(root, 'scripts', 'smoke-packaged-runtime.mjs'), 'utf8');
    expect(packagedRuntime).toContain("for (const dependency of ['node-pty'])");
    expect(packagedRuntime).not.toContain('tree-sitter');
    expect(packagedRuntime).toContain('directories.length !== 1 || directories[0] !== nativeDir');
    expect(packagedRuntime).toContain("required('desktop/macos-desktop-addon.node')");
    expect(packagedRuntime).toContain("required('desktop/libneuraflok-desktop.dylib')");
    expect(packagedRuntime).toContain("addon.handle('{\"op\":\"warm\"}')");

    const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
    expect(readme).toContain('macOS 13 Ventura or newer');
  });

  it('hides Electron helper parentheses from otool-classic without changing the inspected file', () => {
    const file = '/Applications/NEURAFLOK.app/Contents/Frameworks/NEURAFLOK Helper (GPU).app/Contents/MacOS/NEURAFLOK Helper (GPU)';
    const calls: Array<{ kind: string; args: unknown[] }> = [];
    const result = withOtoolSafePath(
      file,
      (safePath: string) => {
        calls.push({ kind: 'inspect', args: [safePath] });
        expect(path.basename(safePath)).toBe('payload');
        expect(safePath).not.toMatch(/[()]/);
        return 'otool-output';
      },
      {
        tmpdir: '/tmp',
        mkdtempSync: (prefix: string) => {
          calls.push({ kind: 'mkdtemp', args: [prefix] });
          return '/tmp/neuraflok-otool-safe';
        },
        symlinkSync: (target: string, alias: string) => {
          calls.push({ kind: 'symlink', args: [target, alias] });
        },
        rmSync: (target: string, options: unknown) => {
          calls.push({ kind: 'remove', args: [target, options] });
        }
      }
    );

    expect(result).toBe('otool-output');
    const safePrefix = path.join('/tmp', 'neuraflok-otool-');
    const safeDirectory = '/tmp/neuraflok-otool-safe';
    const safePayload = path.join(safeDirectory, 'payload');
    expect(calls).toEqual([
      { kind: 'mkdtemp', args: [safePrefix] },
      { kind: 'symlink', args: [file, safePayload] },
      { kind: 'inspect', args: [safePayload] },
      { kind: 'remove', args: [safeDirectory, { recursive: true, force: true }] }
    ]);
  });

  it('rejects Mach-O payloads whose deployment target exceeds the declared macOS floor', () => {
    const modern = `
Load command 10
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform 1
    minos 11.0
      sdk 15.0
Load command 11
      cmd LC_VERSION_MIN_MACOSX
  cmdsize 16
  version 10.15
      sdk 11.0
`;
    expect(macOSDeploymentTargetsFromOtool(modern)).toEqual(['11.0', '10.15']);
    expect(() => assertCompatibleMacOSDeploymentTargets('good.node', modern, '12.0')).not.toThrow();

    const tooNew = modern.replace('minos 11.0', 'minos 13.0');
    expect(() => assertCompatibleMacOSDeploymentTargets('desktop.node', tooNew, '13.0')).not.toThrow();
    expect(() => assertCompatibleMacOSDeploymentTargets('desktop.node', tooNew.replace('minos 13.0', 'minos 14.0'), '13.0')).toThrow(
      /requires macOS 14\.0, newer than Info\.plist LSMinimumSystemVersion 13\.0/
    );
    expect(() => assertCompatibleMacOSDeploymentTargets('bad.node', tooNew, '12.0')).toThrow(
      /requires macOS 13\.0, newer than Info\.plist LSMinimumSystemVersion 12\.0/
    );
    expect(() => assertCompatibleMacOSDeploymentTargets('missing.node', 'Load command 1\n cmd LC_SEGMENT_64', '12.0')).toThrow(
      /no macOS deployment target load command/
    );
  });

  it('allows Apple-Silicon ad-hoc signatures but rejects publisher-bearing macOS signatures', () => {
    // The sealed ad-hoc bundle, which is what ships: no Authority, no TeamIdentifier, and the resource envelope its own executables imply.
    expect(() => assertNoTrustBearingMacCodeSignature('adhoc.app', {
      status: 0,
      stdout: '',
      stderr: 'Identifier=com.example\nSignature=adhoc\nTeamIdentifier=not set\n'
    }, true)).not.toThrow();

    expect(() => assertNoTrustBearingMacCodeSignature('developer-id.app', {
      status: 0,
      stdout: '',
      stderr: 'Signature size=9000\nAuthority=Developer ID Application: Example Corp (TEAM123456)\nTeamIdentifier=TEAM123456\n'
    }, true)).toThrow(/trust-bearing code signature/);
    expect(() => assertNoTrustBearingMacCodeSignature('unknown-success.app', {
      status: 0,
      stdout: '',
      stderr: 'Identifier=com.example\n'
    }, true)).toThrow(/trust-bearing code signature/);
    expect(() => assertNoTrustBearingMacCodeSignature('inspection-failed.app', {
      status: null,
      stdout: '',
      stderr: 'codesign was terminated unexpectedly'
    }, true)).toThrow(/inspection failed unexpectedly/);
  });

  /** Issue #66: the shape that shipped twice and would not launch. arm64 Mach-Os are ad-hoc signed by the linker whether anyone asks or not, so a bundle with no CodeResources is one whose executables claim a resource seal the bundle does not have. macOS reads that contradiction as damage — with Gatekeeper assessment already disabled, and no crash report to show for it. This assertion used to *demand* that state, which is why two releases shipped it and nothing caught them. */
  it('rejects a bundle whose executables are signed but which has no resource seal', () => {
    expect(() => assertNoTrustBearingMacCodeSignature('linker-signed.app', {
      status: 0,
      stdout: '',
      stderr: 'Identifier=com.example\nSignature=adhoc\nTeamIdentifier=not set\n'
    }, false)).toThrow(/no bundle CodeResources envelope/);

    // "Never signed at all" earns the same refusal. The seal is what macOS needs, and a packaged arm64 app cannot reach that state anyway — the linker signs it regardless.
    expect(() => assertNoTrustBearingMacCodeSignature('unsigned.app', {
      status: 1,
      stdout: '',
      stderr: 'code object is not signed at all'
    }, false)).toThrow(/no bundle CodeResources envelope/);
  });

  it('fails release-existence preflight closed on API errors instead of spending packaging runners', async () => {
    const options = {
      repository: 'owner/repo',
      tag: 'v2.0.2',
      token: 'test-token'
    };
    let observedRequest: { url: string; headers?: Record<string, string> } | null = null;
    await expect(assertReleaseAbsent({
      ...options,
      tag: 'release/2',
      apiBase: 'https://github.test/api/',
      fetchImpl: async (url: string, init: { headers?: Record<string, string> }) => {
        observedRequest = { url, headers: init.headers };
        return new Response('', { status: 404 });
      }
    })).resolves.toBeUndefined();
    expect(observedRequest).toEqual({
      url: 'https://github.test/api/repos/owner/repo/releases/tags/release%2F2',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer test-token',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'neuraflok-release-preflight'
      }
    });
    await expect(assertReleaseAbsent({
      ...options,
      fetchImpl: async () => new Response('{}', { status: 200 })
    })).rejects.toThrow(/already exists/);
    await expect(assertReleaseAbsent({
      ...options,
      fetchImpl: async () => new Response('{"message":"rate limited"}', { status: 403 })
    })).rejects.toThrow(/refusing to assume the release is absent/);
  });

  it('validates a version tag before allocating CircleCI release runners', () => {
    const circle = yamlFile('.circleci/config.yml');
    const workflow = circle.workflows['stable-release'];
    const jobs = workflow.jobs as Array<string | Record<string, any>>;
    const names = jobs.map(job => {
      if (typeof job === 'string') return job;
      const name = Object.keys(job)[0]!;
      return job[name]?.name || name;
    });
    const validateIndex = names.indexOf('validate-release');
    const buildIndex = names.indexOf('build-windows-all');
    const validateScript = readFileSync(path.join(root, 'scripts/circleci/validate-release.mjs'), 'utf8');

    expect(validateIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThan(validateIndex);
    const validateJob = jobs.find(job => typeof job !== 'string' && Object.hasOwn(job, 'validate-release')) as Record<string, any>;
    expect(String(validateJob['validate-release'].filters.tags.only)).toMatch(/v\\d\+\\\./);
    expect(validateScript).toContain('assertReleaseAbsent');
    expect(validateScript).toContain('docs/release-notes');
    expect(validateScript).toContain('extensionVersion');
  });

  it('keeps the macOS UI snapshot type visible to the helper files that share it', () => {
    const windowSystem = readFileSync(path.join(root, 'backend/native/macos-desktop-helper/WindowSystem.swift'), 'utf8');
    const interaction = readFileSync(path.join(root, 'backend/native/macos-desktop-helper/Interaction.swift'), 'utf8');

    expect(windowSystem).toContain('final class UISnapshot {');
    expect(windowSystem).not.toContain('private final class UISnapshot {');
    expect(interaction).toContain('var snapshots: [Int: UISnapshot]');
  });

  it('validates release versions and notes without contacting GitHub during local checks', async () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
    let lookup: Record<string, string | undefined> | null = null;
    await expect(validateRelease({
      root,
      environment: { CIRCLE_TAG: `v${pkg.version}`, NEURAFLOK_REPOSITORY: 'owner/repo', GH_TOKEN: 'test-token' },
      checkReleaseAbsent: async (request: Record<string, string | undefined>) => { lookup = request; }
    })).resolves.toMatchObject({ tag: `v${pkg.version}`, version: pkg.version });
    expect(lookup).toEqual({ repository: 'owner/repo', tag: `v${pkg.version}`, token: 'test-token' });
    await expect(validateRelease({ root, environment: { CIRCLE_TAG: 'v99.0.0' } })).rejects.toThrow(/versions do not match/);
  });

  it('publishes only verified stable assets and never overwrites an existing release', async () => {
    const releaseDir = mkdtempSync(path.join(tmpdir(), 'neuraflok-circleci-release-'));
    const assetNames = [...releaseTargets('all').files, 'SHA256SUMS.txt'];
    try {
      for (const name of assetNames) writeFileSync(path.join(releaseDir, name), `fixture:${name}`);
      const calls: Array<{ url: string; method: string }> = [];
      const uploaded: string[] = [];
      const fetchJson = async (url: string, options: { method?: string } = {}) => {
        const method = options.method || 'GET';
        calls.push({ url, method });
        if (url.endsWith('/releases/tags/v0.1.1')) return { status: 404, data: null, text: '' };
        if (url.endsWith('/releases') && method === 'POST') {
          return { status: 201, data: { id: 123, upload_url: 'https://uploads.example/assets{?name,label}' }, text: '' };
        }
        if (url.endsWith('/releases/123/assets?per_page=100')) {
          return { status: 200, data: assetNames.map(name => ({ name, size: statSync(path.join(releaseDir, name)).size })), text: '' };
        }
        if (url.endsWith('/releases/123') && method === 'PATCH') {
          return { status: 200, data: { html_url: 'https://github.com/owner/repo/releases/tag/v0.1.1' }, text: '' };
        }
        throw new Error(`Unexpected release API request: ${method} ${url}`);
      };
      const published = await publishStableRelease({
        repository: 'owner/repo', tag: 'v0.1.1', token: 'test-token', releaseDir, projectRoot: root,
        apiBase: 'https://api.example', fetchJson,
        upload: async (_url: string, options: { file: string }) => { uploaded.push(path.basename(options.file)); },
        verifyAssets: async () => []
      });

      expect(published.html_url).toContain('/releases/tag/v0.1.1');
      expect(uploaded).toEqual(assetNames);
      expect(calls.some(call => call.method === 'PATCH')).toBe(true);

      await expect(publishStableRelease({
        repository: 'owner/repo', tag: 'v0.1.1', token: 'test-token', releaseDir,
        fetchJson: async () => ({ status: 200, data: {}, text: '' }),
        verifyAssets: async () => []
      })).rejects.toThrow(/already exists/);
    } finally {
      rmSync(releaseDir, { recursive: true, force: true });
    }
  });

  it('keeps version metadata aligned and validates artifacts independently of editorial release notes', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(path.join(root, './browser-extension', 'manifest.json'), 'utf8'));
    const versionSource = readFileSync(path.join(root, 'backend/infrastructure/settings/version.ts'), 'utf8');
    const tag = `v${pkg.version}`;
    const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const notes = readFileSync(path.join(root, 'docs', 'release-notes', `${tag}.md`), 'utf8');
    const publish = readFileSync(path.join(root, 'scripts/circleci/publish-release.mjs'), 'utf8');
    const release = readFileSync(path.join(root, '.circleci', 'config.yml'), 'utf8');

    expect(lock.version).toBe(pkg.version);
    expect(lock.packages?.['']?.version).toBe(pkg.version);
    expect(manifest.version).toBe(pkg.version);
    expect(versionSource.match(/APP_VERSION = '([^']+)'/)?.[1]).toBe(pkg.version);
    expect(changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1]).toBe(pkg.version);
    expect(notes).toMatch(/^## .+$/m);

    const artifacts = [
      'NEURAFLOK-Setup-x64.exe',
      'NEURAFLOK-Setup-arm64.exe',
      'NEURAFLOK-macOS-x64.dmg',
      'NEURAFLOK-macOS-x64.zip',
      'NEURAFLOK-macOS-arm64.dmg',
      'NEURAFLOK-macOS-arm64.zip',
      'NEURAFLOK-Linux-x64.AppImage',
      'NEURAFLOK-Linux-x64.deb',
      'NEURAFLOK-Linux-arm64.AppImage',
      'NEURAFLOK-Linux-arm64.deb',
      'NEURAFLOK-Provider-Extension.zip',
      'NEURAFLOK-Native-Sources.tar.gz',
      'SHA256SUMS.txt'
    ];
    // A stable release contains all six platform targets, the provider extension, source archive and checksum manifest.
    const planned = releaseTargets('all').files;
    for (const artifact of artifacts) {
      if (artifact !== 'SHA256SUMS.txt') expect(planned).toContain(artifact);
    }
    expect(publish).toContain("releaseTargets('all').files");
    expect(publish).toContain('verifyReleaseAssets');
    expect(release).toContain("node scripts/circleci/publish-release.mjs");
    expect(release).toContain('neuraflok-release');
  });
});
