// @ts-expect-error The target planner is a plain Node script without type declarations.
import { releaseTargets } from '../scripts/release-targets.mjs';
import { readFileSync } from 'node:fs';
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
    const workflow = readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
    const list = workflow.match(/required_files=\(([\s\S]*?)\n          \)/)?.[1] || '';
    const requiredFiles = [...list.matchAll(/^\s+([^\s#]+)\s*$/gm)].map(match => match[1]!);
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

    expect(requiredFiles).toEqual(expect.arrayContaining(manifestFiles));
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

  it('builds canaries only for the targets most installs use, and releases for all of them', () => {
    expect(releaseTargets('common').include.map((target: { name: string }) => target.name)).toEqual(['Windows x64', 'macOS arm64', 'Linux x64']);
    expect(releaseTargets('common').files).toEqual(['NEURAFLOK-Setup-x64.exe', 'NEURAFLOK-macOS-arm64.dmg',
      'NEURAFLOK-macOS-arm64.zip', 'NEURAFLOK-Linux-x64.AppImage', 'NEURAFLOK-Linux-x64.deb',
      'NEURAFLOK-Provider-Extension.zip', 'NEURAFLOK-Native-Sources.tar.gz']);
    expect(() => releaseTargets('some')).toThrow();
    const canary = yamlFile('.github/workflows/canary.yml');
    expect(canary.jobs.candidate.with).toEqual({ platforms: 'common' });
    // Built after every app-relevant push to main, and a running canary is never cancelled halfway through replacing the previous one.
    expect(canary.on.push).toMatchObject({ branches: ['main'] });
    expect(canary.on.push['paths-ignore']).toEqual(expect.arrayContaining(['docs/**', 'test/**']));
    expect(canary.on).toHaveProperty('workflow_dispatch');
    expect(canary.concurrency).toEqual({ group: 'canary', 'cancel-in-progress': false });
    // A stable release passes nothing, which is `all`.
    expect(yamlFile('.github/workflows/publish.yml').jobs.candidate?.with?.platforms).toBeUndefined();
  });

  it('publishes a canary checksum manifest that names only attached canary assets', () => {
    const canary = yamlFile('.github/workflows/canary.yml');
    const steps = canary.jobs.publish.steps as Array<Record<string, any>>;
    const reverify = steps.find((step) => step.name === 'Re-verify the checksums');
    const narrow = steps.find((step) => step.name === 'Limit checksums to published canary assets');
    const publish = steps.find((step) => step.name === 'Replace the canary prerelease');

    expect(reverify?.run).toContain('sha256sum -c SHA256SUMS.txt');
    expect(narrow?.['working-directory']).toBe('publish');
    expect(narrow?.run).toContain('NEURAFLOK-Native-Sources.tar.gz');
    expect(narrow?.run).toContain('SHA256SUMS.txt');
    expect(narrow?.run).toContain('SHA256SUMS.canary.txt');
    expect(publish?.run).toContain("! -name '*Native-Sources*'");
    expect(steps.indexOf(narrow!)).toBeGreaterThan(steps.indexOf(reverify!));
    expect(steps.indexOf(narrow!)).toBeLessThan(steps.indexOf(publish!));
  });

  it('skips a stale canary run before staging a replacement', () => {
    const canary = yamlFile('.github/workflows/canary.yml');
    const steps = canary.jobs.publish.steps as Array<Record<string, any>>;
    const publish = steps.find((step) => step.name === 'Replace the canary prerelease');
    const script = String(publish?.run ?? '');

    const headCheck = script.indexOf('gh api "repos/${GITHUB_REPOSITORY}/commits/main" --jq .sha');
    const stagingTag = script.indexOf('staging_tag="canary-staging-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"');
    const draftCreate = script.indexOf('gh api --method POST "repos/${GITHUB_REPOSITORY}/releases"');
    expect(headCheck).toBeGreaterThanOrEqual(0);
    expect(stagingTag).toBeGreaterThan(headCheck);
    expect(draftCreate).toBeGreaterThan(stagingTag);
    expect(script).toContain('if [ "$GITHUB_SHA" != "$main_sha" ]; then');
    expect(script).toContain('Skipping stale canary run');
    expect(script).toContain('exit 0');
    expect(script).toContain('-f tag_name="$staging_tag"');
    expect(script).toContain('-F draft=true');
    expect(script).not.toContain('git ls-remote --exit-code origin refs/heads/main');
  });

  it('verifies a temporary draft before swapping the fixed canary tag', () => {
    const canary = yamlFile('.github/workflows/canary.yml');
    const steps = canary.jobs.publish.steps as Array<Record<string, any>>;
    const publish = steps.find((step) => step.name === 'Replace the canary prerelease');
    const script = String(publish?.run ?? '');

    const headChecks = [...script.matchAll(/gh api "repos\/\$\{GITHUB_REPOSITORY\}\/commits\/main" --jq \.sha/g)]
      .map((match) => match.index ?? -1);
    const createDraft = script.indexOf('gh api --method POST "repos/${GITHUB_REPOSITORY}/releases"');
    const verifyAssets = script.indexOf('diff -u expected-canary-assets.txt actual-canary-assets.txt');
    const verifyDigests = script.indexOf('diff -u expected-canary-digests.txt actual-canary-digests.txt');
    const swapStarted = script.indexOf('swap_started=true');
    const deleteOld = script.indexOf('gh release delete canary --yes');
    const repointTag = script.indexOf('git/refs/tags/canary');
    const publishDraft = script.lastIndexOf('gh api --method PATCH "repos/${GITHUB_REPOSITORY}/releases/${draft_id}"');
    const markPromoted = script.indexOf('staging_promoted=true');
    const verifyFixed = script.indexOf('gh release view canary --json');

    expect(headChecks).toHaveLength(2);
    const firstHeadCheck = headChecks[0]!;
    const secondHeadCheck = headChecks[1]!;
    expect(createDraft).toBeGreaterThan(firstHeadCheck);
    expect(verifyAssets).toBeGreaterThan(createDraft);
    expect(verifyDigests).toBeGreaterThan(verifyAssets);
    expect(secondHeadCheck).toBeGreaterThan(verifyDigests);
    expect(swapStarted).toBeGreaterThan(secondHeadCheck);
    expect(deleteOld).toBeGreaterThan(secondHeadCheck);
    expect(deleteOld).toBeGreaterThan(swapStarted);
    expect(repointTag).toBeGreaterThan(deleteOld);
    expect(publishDraft).toBeGreaterThan(repointTag);
    expect(markPromoted).toBeGreaterThan(publishDraft);
    expect(verifyFixed).toBeGreaterThan(markPromoted);
    expect(script).toContain('-F draft=true');
    expect(script).toContain('-f target_commitish="$GITHUB_SHA"');
    expect(script).toContain('-f tag_name=canary');
    expect(script).toContain('-F draft=false');
    expect(script).toContain('-F prerelease=true');
    expect(script).toContain('releases/${draft_id}/assets?name=${name}');
    expect(script).toContain('/releases/download/canary/');
    expect(script).not.toContain('candidate_tag="canary-${GITHUB_SHA}"');
    expect(script).not.toContain('--clobber');
  });

  it('fails closed on canary existence-probe errors and cleans temporary state', () => {
    const canary = yamlFile('.github/workflows/canary.yml');
    const steps = canary.jobs.publish.steps as Array<Record<string, any>>;
    const publish = steps.find((step) => step.name === 'Replace the canary prerelease');
    const script = String(publish?.run ?? '');

    const secondHeadCheck = script.lastIndexOf('gh api "repos/${GITHUB_REPOSITORY}/commits/main" --jq .sha');
    const releaseProbe = script.indexOf('canary_release_status="$(github_get_status', secondHeadCheck);
    const refProbe = script.indexOf('canary_ref_status="$(github_get_status', secondHeadCheck);
    const deleteOld = script.indexOf('gh release delete canary --yes');
    expect(releaseProbe).toBeGreaterThan(secondHeadCheck);
    expect(refProbe).toBeGreaterThan(releaseProbe);
    expect(deleteOld).toBeGreaterThan(refProbe);
    expect(script).toContain("case \"$status\" in");
    expect(script).toContain('200|404) printf');
    expect(script).toContain('Unexpected GitHub API status');
    expect(script).toContain('curl transport failed');
    expect(script).toContain('if [ "$canary_release_status" = "200" ]; then');
    expect(script).toContain('if [ "$canary_ref_status" = "200" ]; then');
    expect(script).toContain('trap cleanup_staging EXIT');
    expect(script).toContain('cleanup_staging_ref');
    expect(script).toContain('gh api --method DELETE "repos/${GITHUB_REPOSITORY}/releases/${draft_id}"');
    expect(script).toContain('[ "$swap_started" != "true" ]');
    expect(script).toContain('gh release delete canary --yes');
    expect(script).not.toContain('gh release delete canary --cleanup-tag');
    expect(script).not.toContain('if gh release view canary');
    expect(script).not.toContain('if gh api "repos/${GITHUB_REPOSITORY}/git/ref/tags/canary"');
  });

  it('keeps every input required by the pinned first-interaction action without restoring PR events', () => {
    const welcome = yamlFile('.github/workflows/welcome.yml');
    const steps = welcome.jobs.welcome.steps as Array<Record<string, any>>;
    const firstInteraction = steps.find((step) => step.uses === 'actions/first-interaction@1c4688942c71f71d4f5502a26ea67c331730fa4d');

    expect(firstInteraction).toBeTruthy();
    expect(String(firstInteraction?.with?.issue_message ?? '').trim()).not.toBe('');
    expect(String(firstInteraction?.with?.pr_message ?? '').trim()).not.toBe('');
    expect(welcome.on).toHaveProperty('issues');
    expect(welcome.on).not.toHaveProperty('pull_request_target');
  });

  it('assembles every platform artifact in the reusable release workflow', () => {
    const workflow = readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    const parsed = yamlFile('.github/workflows/release.yml');
    // The matrix comes from the plan job, which reads .github/release-targets.json.
    expect(parsed.jobs.package.strategy.matrix.include).toBe('${{ fromJSON(needs.plan.outputs.include) }}');
    expect(parsed.jobs.plan.steps.at(-1).run).toBe('node scripts/release-targets.mjs "$PLATFORMS"');
    const matrix = releaseTargets('all').include;
    expect(matrix).toHaveLength(6);
    expect(matrix).toEqual([
      {
        name: 'Windows x64', platform: 'win32', arch: 'x64', runner: 'windows-2025',
        script: 'dist:x64', artifact: 'package-windows-x64', files: 'release/NEURAFLOK-Setup-x64.exe'
      },
      {
        name: 'Windows arm64', platform: 'win32', arch: 'arm64', runner: 'windows-11-arm',
        script: 'dist:arm64', artifact: 'package-windows-arm64', files: 'release/NEURAFLOK-Setup-arm64.exe'
      },
      {
        name: 'macOS x64', platform: 'darwin', arch: 'x64', runner: 'macos-15-intel',
        script: 'dist:mac:x64', artifact: 'package-macos-x64',
        files: 'release/NEURAFLOK-macOS-x64.dmg\nrelease/NEURAFLOK-macOS-x64.zip'
      },
      {
        name: 'macOS arm64', platform: 'darwin', arch: 'arm64', runner: 'macos-15',
        script: 'dist:mac:arm64', artifact: 'package-macos-arm64',
        files: 'release/NEURAFLOK-macOS-arm64.dmg\nrelease/NEURAFLOK-macOS-arm64.zip'
      },
      {
        name: 'Linux x64', platform: 'linux', arch: 'x64', runner: 'ubuntu-24.04',
        script: 'dist:linux:x64', artifact: 'package-linux-x64',
        files: 'release/NEURAFLOK-Linux-x64.AppImage\nrelease/NEURAFLOK-Linux-x64.deb'
      },
      {
        name: 'Linux arm64', platform: 'linux', arch: 'arm64', runner: 'ubuntu-24.04-arm',
        script: 'dist:linux:arm64', artifact: 'package-linux-arm64',
        files: 'release/NEURAFLOK-Linux-arm64.AppImage\nrelease/NEURAFLOK-Linux-arm64.deb'
      }
    ]);
    expect(parsed.jobs.package['runs-on']).toBe('${{ matrix.runner }}');
    expect(workflow).toContain('name: neuraflok-candidate-${{ github.run_id }}');
    expect(workflow).toContain('Install generated DEB on target distro');
    expect(workflow).toContain('Launch installed DEB normally under Xvfb');
    expect(workflow).toContain('NEURAFLOK_DEBUG=1 timeout --signal=TERM --kill-after=5s 12s xvfb-run -a /usr/bin/neuraflok');
    expect(workflow).toContain('Execute generated static-runtime AppImage');
    expect(workflow).toContain('Verify generated macOS archives');
    expect(workflow).toContain('hdiutil verify "$dmg"');
    expect(workflow).toContain('codesign --display --verbose=4 "$dmg" >dmg-codesign.log 2>&1');
    expect(workflow).toContain('dmg_codesign_status=$?');
    expect(workflow).toContain("grep -Eqi 'code object is not signed( at all)?' dmg-codesign.log");
    expect(workflow).toContain('test -L "$mount_dir/Applications"');
    expect(workflow).toContain('test "$(readlink "$mount_dir/Applications")" = /Applications');
    expect(workflow).toContain('ditto -x -k "$zip" "$zip_dir"');
    expect(workflow).toContain("node scripts/smoke-macos-bundle.mjs '${{ matrix.arch }}' \"$mount_dir/NEURAFLOK.app\"");
    expect(workflow).toContain("node scripts/smoke-macos-bundle.mjs '${{ matrix.arch }}' \"$zip_dir/NEURAFLOK.app\"");
    expect(workflow).toContain('Audit packaged macOS bundle metadata and Mach-O payloads');
    expect(workflow).toContain('node scripts/smoke-macos-bundle.mjs ${{ matrix.arch }}');
    expect(workflow).toContain('Launch packaged macOS app normally');
    expect(workflow).toContain('node scripts/smoke-macos-gui.mjs ${{ matrix.arch }}');
    expect(workflow).toContain('architecture: ${{ matrix.arch }}');

    const macGui = workflow.slice(
      workflow.indexOf('      - name: Launch packaged macOS app normally'),
      workflow.indexOf('      - name: Install generated DEB on target distro')
    );
    expect(macGui).toContain('node scripts/smoke-macos-gui.mjs ${{ matrix.arch }}');
    expect(macGui).not.toContain('ELECTRON_RUN_AS_NODE');

    const macGuiScript = readFileSync(path.join(root, 'scripts', 'smoke-macos-gui.mjs'), 'utf8');
    expect(macGuiScript).toContain("NEURAFLOK_DEBUG: '1'");
    expect(macGuiScript).toContain("output.includes('[info] app started')");
    expect(macGuiScript).toContain("output.includes('[info] window loaded')");
    expect(macGuiScript).toContain("output.includes('[info] renderer state ready')");
    expect(macGuiScript).toContain("output.includes('[error] window failed to load')");
    expect(macGuiScript).toContain("output.includes('[error] renderer:')");
    expect(macGuiScript).toContain('minimumSurvivalMs = 10_000');
    expect(macGuiScript).toContain('startupDeadlineMs = 15_000');
    expect(macGuiScript).toContain("child.kill('SIGTERM')");
    expect(macGuiScript).toContain("child.kill('SIGKILL')");
    expect(macGuiScript).not.toContain('ELECTRON_RUN_AS_NODE');

    const debGui = workflow.slice(
      workflow.indexOf('      - name: Launch installed DEB normally under Xvfb'),
      workflow.indexOf('      - name: Execute generated static-runtime AppImage')
    );
    expect(workflow).toContain('sudo apt-get install -y --no-install-recommends xvfb xauth');
    expect(workflow).toContain("grep -Fxq 'Name=NEURAFLOK' \"$desktop\"");
    expect(workflow).toContain("grep -Fxq 'Icon=neuraflok' \"$desktop\"");
    expect(debGui).toContain('deb_smoke_root="$(mktemp -d)"');
    // Same shape the AppImage smoke below is held to: the teardown may retry, and may fail, but it may never decide the step. Only the assertions under it do that.
    expect(debGui).toContain('cleanup_path_with_retries()');
    expect(debGui).toContain("trap 'cleanup_path_with_retries \"$deb_smoke_root\"' EXIT");
    expect(debGui).toContain('rm -rf "$target" 2>/dev/null || true');
    expect(debGui).toContain('HOME="$deb_smoke_root/home"');
    expect(debGui).toContain('XDG_CONFIG_HOME="$deb_smoke_root/config"');
    expect(debGui).toContain('XDG_CACHE_HOME="$deb_smoke_root/cache"');
    expect(debGui).toContain('XDG_DATA_HOME="$deb_smoke_root/data"');
    expect(debGui).toContain('XDG_STATE_HOME="$deb_smoke_root/state"');
    expect(debGui).toContain('xvfb-run -a /usr/bin/neuraflok');
    expect(debGui).toContain('--kill-after=5s 12s');
    expect(debGui).toContain("grep -Fq '[info] app started' deb-gui.log");
    expect(debGui).toContain("grep -Fq '[info] window loaded' deb-gui.log");
    expect(debGui).toContain("grep -Fq '[info] renderer state ready' deb-gui.log");
    expect(debGui).toContain("grep -Fq '[error] window failed to load' deb-gui.log");
    expect(debGui).toContain("grep -Fq '[error] renderer:' deb-gui.log");
    expect(debGui).not.toContain('ELECTRON_RUN_AS_NODE');

    const appImageGui = workflow.slice(
      workflow.indexOf('      - name: Execute generated static-runtime AppImage'),
      workflow.indexOf('      - name: Upload package artifacts')
    );
    expect(appImageGui).toContain('xvfb-run -a "$appimage"');
    expect(appImageGui).toContain('normal_smoke_root="$(mktemp -d)"');
    expect(appImageGui).toContain('fallback_smoke_root="$(mktemp -d)"');
    expect(appImageGui).toContain('rm -rf "$fake_bin" "$normal_smoke_root" "$fallback_smoke_root"');
    expect(appImageGui).toContain('HOME="$smoke_root/home"');
    expect(appImageGui).toContain('XDG_CONFIG_HOME="$smoke_root/config"');
    expect(appImageGui).toContain('XDG_CACHE_HOME="$smoke_root/cache"');
    expect(appImageGui).toContain('XDG_DATA_HOME="$smoke_root/data"');
    expect(appImageGui).toContain('XDG_STATE_HOME="$smoke_root/state"');
    expect(appImageGui).toContain("printf '#!/bin/sh\\nexit 1\\n' > \"$fake_bin/unshare\"");
    expect(appImageGui).toContain('PATH="$launch_path"');
    expect(appImageGui).toContain('NEURAFLOK_DEBUG=1 timeout --signal=TERM --kill-after=5s 12s xvfb-run -a "$appimage" >"$log"');
    expect(appImageGui).toContain("grep -Fq '[info] app started' \"$log\"");
    expect(appImageGui).toContain("grep -Fq '[info] window loaded' \"$log\"");
    expect(appImageGui).toContain("grep -Fq '[info] renderer state ready' \"$log\"");
    expect(appImageGui).toContain("grep -Fq '[error] window failed to load' \"$log\"");
    expect(appImageGui).toContain("grep -Fq '[error] renderer:' \"$log\"");
    expect(appImageGui).toContain('run_appimage_smoke normal "$normal_smoke_root" "$PATH" appimage-normal-gui.log');
    expect(appImageGui).toContain('run_appimage_smoke forced-fallback "$fallback_smoke_root" "$fake_bin:$PATH" appimage-fallback-gui.log');
    expect(appImageGui.replace(/^\s*#.*$/gm, '')).not.toContain('ELECTRON_RUN_AS_NODE');
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
    expect(pkg.author).toBe('NEURAFLOK contributors');
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
    const releaseWorkflow = readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(releaseWorkflow).toContain('HOME="$deb_smoke_root/home"');
    expect(releaseWorkflow).toContain('HOME="$smoke_root/home"');
    expect(releaseWorkflow).toContain('PATH="$launch_path"');
    expect(releaseWorkflow).toContain('run_appimage_smoke normal "$normal_smoke_root" "$PATH" appimage-normal-gui.log');
    expect(releaseWorkflow).toContain('run_appimage_smoke forced-fallback "$fallback_smoke_root" "$fake_bin:$PATH" appimage-fallback-gui.log');
    expect(releaseWorkflow).toContain('NEURAFLOK_DEBUG=1 timeout --signal=TERM --kill-after=5s 12s xvfb-run -a "$appimage" >"$log"');
    expect(releaseWorkflow).toContain('NEURAFLOK_DEBUG=1 timeout --signal=TERM --kill-after=5s 12s xvfb-run -a /usr/bin/neuraflok');
    expect(releaseWorkflow).toContain("grep -Fq '[info] app started' \"$log\"");
    expect(releaseWorkflow).toContain("grep -Fq '[info] window loaded' \"$log\"");
    expect(releaseWorkflow).toContain("test \"$(dpkg-deb --field \"$deb\" Package)\" = neuraflok");
    expect(releaseWorkflow).toContain("test \"$(dpkg-deb --field \"$deb\" Version)\" = \"$(node -p \"require('./package.json').version\")\"");
    expect(releaseWorkflow).toContain('expected_deb_arch=amd64');
    expect(releaseWorkflow).toContain('test -L /usr/bin/neuraflok');
    expect(releaseWorkflow).toContain('installed_executable="$(readlink -f /usr/bin/neuraflok)"');
    expect(releaseWorkflow).toContain('test -x "$installed_executable"');
    expect(releaseWorkflow).toContain('dpkg-query -S "$installed_executable"');
    expect(releaseWorkflow).toContain("node scripts/smoke-packaged-runtime.mjs --platform linux --arch '${{ matrix.arch }}' --root \"$(dirname \"$installed_executable\")\"");
    expect(releaseWorkflow).toContain('node scripts/smoke-macos-gui.mjs ${{ matrix.arch }}');

    const appImageSection = releaseWorkflow.slice(
      releaseWorkflow.indexOf('      - name: Execute generated static-runtime AppImage'),
      releaseWorkflow.indexOf('      - name: Upload package artifacts')
    );
    expect(appImageSection.replace(/^\s*#.*$/gm, '')).not.toContain('ELECTRON_RUN_AS_NODE');

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

  it('rejects invalid publishes before allocating the reusable six-runner build', () => {
    const workflow = readFileSync(path.join(root, '.github', 'workflows', 'publish.yml'), 'utf8');
    const preflight = workflow.indexOf('  preflight:');
    const candidate = workflow.indexOf('  candidate:');
    const publish = workflow.indexOf('  publish:');
    expect(preflight).toBeGreaterThan(-1);
    expect(candidate).toBeGreaterThan(preflight);
    expect(publish).toBeGreaterThan(candidate);
    expect(workflow.slice(preflight, candidate)).toContain('node scripts/check-release-absent.mjs');
    expect(workflow.slice(preflight, candidate)).toContain('Verify release metadata agrees');
    expect(workflow.slice(preflight, candidate)).toContain("APP_VERSION = '([^']+)'");
    expect(workflow.slice(preflight, candidate)).toContain('has no release title');
    expect(workflow.slice(candidate, publish)).toContain('needs: preflight');
    expect(workflow.slice(publish)).toContain('node scripts/check-release-absent.mjs');
    expect(workflow).not.toMatch(/tunnel-client|cloudflared|verify:tunnel-current/i);
    expect(workflow).toContain('name: neuraflok-candidate-${{ github.run_id }}');
  });

  it('keeps version metadata aligned and validates artifacts independently of editorial release notes', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(path.join(root, './browser-extension', 'manifest.json'), 'utf8'));
    const versionSource = readFileSync(path.join(root, 'backend/infrastructure/settings/version.ts'), 'utf8');
    const tag = `v${pkg.version}`;
    const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const notes = readFileSync(path.join(root, 'docs', 'release-notes', `${tag}.md`), 'utf8');
    const publish = readFileSync(path.join(root, '.github', 'workflows', 'publish.yml'), 'utf8');
    const release = readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');

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
      'SHA256SUMS.txt'
    ];
    const checksumStep = release.slice(
      release.indexOf('      - name: Create SHA-256 checksums'),
      release.indexOf('      - name: Upload release candidate')
    );
    const candidateUpload = release.slice(release.indexOf('      - name: Upload release candidate'));
    const publishStep = publish.slice(publish.indexOf('      - name: Publish the release'));
    // A release packages every target: the plan for `all` names each artifact, and the checksum step and the candidate upload take exactly that plan.
    expect(checksumStep).toContain('FILES: ${{ needs.plan.outputs.files }}');
    expect(candidateUpload).toContain('release/NEURAFLOK-*');
    expect(candidateUpload).toContain('release/SHA256SUMS.txt');
    const planned = releaseTargets('all').files;
    for (const artifact of artifacts) {
      expect(publishStep).toContain(artifact);
      if (artifact !== 'SHA256SUMS.txt') expect(planned).toContain(artifact);
    }
  });
});
