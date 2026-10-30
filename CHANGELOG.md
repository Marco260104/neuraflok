# Changelog

All notable NEURAFLOK changes are documented here.

NEURAFLOK is licensed under the MIT License. See [LICENSE](LICENSE).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.13] - 2026-10-29

### Fixed

- Bound macOS Keychain startup checks and back off retries when the native credential prompt does not respond, so a stalled Keychain no longer holds the app's initial state indefinitely.
- Keep macOS startup smoke-test diagnostics available through debug-only startup phase markers.

## [0.1.12] - 2026-10-29

### Fixed

- Add debug-only startup phase markers to the macOS packaged-app smoke test so an incomplete initial renderer state can be traced to its exact startup dependency.

## [0.1.11] - 2026-10-29

### Fixed

- Load the integrated browser toolbar from its nested renderer output path in packaged builds, fixing the missing-page error that prevented the macOS Intel startup smoke test from reaching its ready state.
- Keep the macOS Intel launch smoke test enabled under Rosetta so the release pipeline verifies the actual packaged app, not just its bundle metadata.

## [0.1.10] - 2026-10-29

### Fixed

- Verify the macOS Intel DMG, ZIP, bundle metadata, executable permissions, and thin Intel binaries on Apple Silicon CI without relying on a flaky Rosetta GUI launch. Native macOS GUI startup remains smoke-tested on ARM64 and on Intel hosts.

## [0.1.9] - 2026-10-29

### Fixed

- Use CircleCI's preinstalled supported Node.js runtime on Windows instead of downloading an MSI during the release build.
- Allow additional startup time for the macOS Intel app smoke test when it runs under Rosetta on Apple Silicon.

## [0.1.8] - 2026-10-29

### Fixed

- Included PDF.js in the app package for main-process PDF text extraction and added a packaged-runtime check for it.

## [0.1.7] - 2026-10-29

### Fixed

- Matched the Linux installer smoke test to the desktop-entry filename generated from the app's configured desktop name.

## [0.1.6] - 2026-10-29

### Fixed

- Prevented CircleCI's internal build number from changing the version embedded in Windows, macOS, and Linux installer packages.

## [0.1.5] - 2026-10-29

### Fixed

- Kept macOS bundle build versions aligned with the public release version in CircleCI.
- Added explicit Linux installer smoke-test diagnostics so a failed package or app launch includes its captured output.

## [0.1.4] - 2026-10-29

### Fixed

- Made the macOS UI snapshot type accessible to the helper files that store and read snapshots.
- Included the Linux maintainer metadata fix in the next full installer build.

## [0.1.3] - 2026-10-29

### Fixed

- Added non-personal maintainer metadata required to package Linux DEB installers.

## [0.1.2] - 2026-10-29

### Added

- CircleCI release automation for Windows, macOS, and Linux installers across supported processor architectures.
- Direct links to the latest stable installers and SHA-256 checksums.

### Changed

- Prepared the first public installer release with aligned desktop, extension, and package versions.

## [0.1.1] - 2026-10-29

### Added

- Installers for Windows, macOS, and Linux, with SHA-256 checksums in the GitHub release.
- Direct platform download links in the README.

### Changed

- Improved project-chat context recovery, attachment handling, and Markdown rendering.
- Refined plan-mode feedback and project-chat loading states.

## [0.1.0] - 2026-10-12

### Added

- Desktop workspace with signed-in browser sessions for DeepSeek, Kimi, Qwen, and Z AI.
- Integrated browser companion that is bundled and refreshed by the app.
- Local projects, terminal, bounded file operations, and durable conversation history.
- Provider and API conversation routes with delivery receipts.
- Optional workers, Goal, Loop, plans, plugins, and desktop capabilities.
- Domain-oriented backend modules with explicit renderer and preload boundaries.
