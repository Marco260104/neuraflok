// Adds and verifies the ad-hoc resource seal required by packaged macOS apps.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { assertNoTrustBearingMacCodeSignature } from './macos-audit-utils.mjs';

const UNUSED_MEDIA_PRIVACY_KEYS = [
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
  'NSAudioCaptureUsageDescription'
];

/** Runs a command and returns its combined output, throwing with that output on failure. */
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    throw new Error(`${command} ${args.join(' ')} failed: ${detail || result.error?.message || result.signal || result.status}`);
  }
  return result;
}

export default async function sealMacOsBundle(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const app = path.join(context.appOutDir, appName);
  if (!existsSync(app)) throw new Error(`afterPack could not find ${app} to seal`);

  const plist = path.join(app, 'Contents', 'Info.plist');
  const originalPlist = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', plist]).stdout);
  for (const key of UNUSED_MEDIA_PRIVACY_KEYS) {
    if (Object.hasOwn(originalPlist, key)) run('plutil', ['-remove', key, plist]);
  }

  // Electron's generic app template declares camera/microphone/audio capture even when an app never uses those APIs. NEURAFLOK denies renderer permission requests and has no media-capture feature, so shipping those declarations is misleading and can make macOS surface unrelated privacy prompts. Keep only privacy declarations for capabilities NEURAFLOK actually exposes.
  const cleanedPlist = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', plist]).stdout);
  for (const key of UNUSED_MEDIA_PRIVACY_KEYS) {
    if (Object.hasOwn(cleanedPlist, key)) throw new Error(`afterPack failed to remove unused Info.plist key ${key}`);
  }

  // Electron nests frameworks and helper apps that each need their own signature. Signing only the outer bundle would leave the same self-contradiction one level down. Apple discourages --deep for *distribution* signing, where each nested component wants its own identity and entitlements; for a uniform ad-hoc seal with no entitlements there is nothing to distinguish.
  run('codesign', ['--force', '--deep', '--sign', '-', app]);

  // Verify the sealed app deeply so an invalid nested signature fails before packaging succeeds.
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);

  const shown = run('codesign', ['--display', '--verbose=4', app]);
  // Fail loudly if this ever starts producing a trust-bearing signature. The release notes say unsigned, and an afterPack hook silently turning that into something Gatekeeper vouches for would be a policy change smuggled in as a build step. codesign displays these details on stderr even on success. Use the same stdout+stderr policy as the standalone bundle audit, including TeamIdentifier.
  assertNoTrustBearingMacCodeSignature(app, shown, existsSync(path.join(app, 'Contents', '_CodeSignature', 'CodeResources')));

  process.stdout.write(`Sealed ${appName} ad-hoc and verified its resource envelope.\n`);
}
