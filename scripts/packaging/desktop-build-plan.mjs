import path from 'node:path';
import { PLATFORM_INFO } from './target-platforms.mjs';

export function createDesktopBuildPlan({
  nodeExecutable,
  platform,
  architectures,
  directoryOnly = false,
  environment = process.env
}) {
  const nodeStep = (name, args, stepEnvironment) => ({
    name,
    command: nodeExecutable,
    args,
    ...(stepEnvironment ? { environment: stepEnvironment } : {})
  });
  const plan = [
    nodeStep('load-electron-runtime', ['-e', "require('electron')"]),
    nodeStep('write-dependency-notices', ['scripts/generate-third-party-notices.mjs']),
    nodeStep('create-desktop-icons', ['scripts/make-icon.mjs']),
    nodeStep('fingerprint-browser-extension', ['scripts/packaging/extension-fingerprint.mjs']),
    nodeStep('bundle-desktop-application', [
      path.join('node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
      'build'
    ])
  ];

  for (const architecture of architectures) {
    const targetArgs = ['--platform', platform, '--arch', architecture];
    const builderArgs = [
      path.join('node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
      PLATFORM_INFO[platform].builderFlag,
      `--${architecture}`,
      '--publish',
      'never'
    ];
    if (directoryOnly) builderArgs.push('--dir');

    plan.push(
      nodeStep('stage-ripgrep', ['scripts/fetch-ripgrep.mjs', ...targetArgs]),
      nodeStep('stage-native-runtime', ['scripts/prepare-packaging-native.mjs', ...targetArgs]),
      nodeStep('prepare-platform-helper', ['scripts/prepare-macos-desktop-helper.mjs', ...targetArgs]),
      {
        ...nodeStep('assemble-desktop-package', builderArgs, {
          ...environment,
          NEURAFLOK_PACKAGE_ARCH: architecture
        })
      },
      nodeStep('smoke-test-package', ['scripts/smoke-packaged-runtime.mjs', ...targetArgs])
    );
  }

  return plan;
}
