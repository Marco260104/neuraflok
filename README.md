# NEURAFLOK

<p align="center">
  <img src="brand/Logotipo.png" alt="NEURAFLOK" width="340">
</p>

<p align="center"><strong>One workspace for AI conversations and local projects.</strong></p>
<p align="center">A local-first desktop app for working with AI providers, project files, and approved tools.</p>

<p align="center"><strong>Download NEURAFLOK</strong></p>
<p align="center">
  <a href="https://github.com/Marco260104/neuraflok/releases/latest/download/NEURAFLOK-Setup-x64.exe"><img src="https://img.shields.io/badge/Windows_x64-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Windows x64 installer"></a>
  <a href="https://github.com/Marco260104/neuraflok/releases/latest/download/NEURAFLOK-macOS-arm64.dmg"><img src="https://img.shields.io/badge/macOS_ARM64-000000?style=for-the-badge&logo=apple&logoColor=white" alt="macOS Apple silicon installer"></a>
  <a href="https://github.com/Marco260104/neuraflok/releases/latest/download/NEURAFLOK-Linux-x64.AppImage"><img src="https://img.shields.io/badge/Linux_x64-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux x64 AppImage"></a>
</p>

<p align="center">Each button downloads the latest stable installer. More architectures are listed below.</p>

<p align="center">
  <a href="https://github.com/Marco260104/neuraflok">Source</a> ·
  <a href="https://github.com/Marco260104/neuraflok/releases">All releases</a> ·
  <a href="docs/setup.md">Setup guide</a> ·
  <a href="https://github.com/Marco260104/neuraflok/issues">Report an issue</a>
</p>

<p align="center">
  <a href="https://github.com/Marco260104/neuraflok/stargazers"><img src="https://img.shields.io/github/stars/Marco260104/neuraflok.svg?style=flat-square" alt="GitHub stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2f9e75?style=flat-square" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-59636e?style=flat-square" alt="Windows, macOS, and Linux">
</p>

## Downloads

The platform buttons above download the default installer for Windows x64, macOS Apple silicon, or Linux x64. Every stable release is built and verified by CircleCI before it is published.

| Platform | Architecture | Direct download |
| --- | --- | --- |
| Windows 10/11 | x64 | [Installer](https://github.com/Marco260104/neuraflok/releases/latest/download/NEURAFLOK-Setup-x64.exe) |
| Windows 10/11 | ARM64 | [Installer](https://github.com/Marco260104/neuraflok/releases/latest/download/NEURAFLOK-Setup-arm64.exe) |
| macOS 13 Ventura or newer | Apple silicon (ARM64) | [DMG](https://github.com/Marco260104/neuraflok/releases/latest/download/NEURAFLOK-macOS-arm64.dmg) · [ZIP](https://github.com/Marco260104/neuraflok/releases/latest/download/NEURAFLOK-macOS-arm64.zip) |
| macOS 13 Ventura or newer | Intel (x64) | [DMG](https://github.com/Marco260104/neuraflok/releases/latest/download/NEURAFLOK-macOS-x64.dmg) · [ZIP](https://github.com/Marco260104/neuraflok/releases/latest/download/NEURAFLOK-macOS-x64.zip) |
| Linux | x64 | [AppImage](https://github.com/Marco260104/neuraflok/releases/latest/download/NEURAFLOK-Linux-x64.AppImage) · [DEB](https://github.com/Marco260104/neuraflok/releases/latest/download/NEURAFLOK-Linux-x64.deb) |
| Linux | ARM64 | [AppImage](https://github.com/Marco260104/neuraflok/releases/latest/download/NEURAFLOK-Linux-arm64.AppImage) · [DEB](https://github.com/Marco260104/neuraflok/releases/latest/download/NEURAFLOK-Linux-arm64.deb) |

Every stable release includes [SHA256SUMS.txt](https://github.com/Marco260104/neuraflok/releases/latest/download/SHA256SUMS.txt) so you can verify downloaded files. You can also download the [provider extension](https://github.com/Marco260104/neuraflok/releases/latest/download/NEURAFLOK-Provider-Extension.zip) and [native source archive](https://github.com/Marco260104/neuraflok/releases/latest/download/NEURAFLOK-Native-Sources.tar.gz). Some macOS packages may not be signed or notarized; see [SECURITY.md](SECURITY.md) before installing.

## What NEURAFLOK does

- **Chat naturally:** keep conversations and their history on your computer, then continue them later.
- **Work with projects:** give a project chat its selected project context and access only to approved folders and capabilities.
- **Keep chat types separate:** a normal chat receives your instructions and relevant conversation history, not a project file tree. A project chat can use project files when you select and authorize that project.
- **Choose a provider:** connect supported browser sessions or configure an API-compatible endpoint in the app.
- **Use local tools deliberately:** file operations and terminal commands are checked against the current workspace permissions.
- **Stay in control:** review tool results, delivery status, and provider availability in the conversation.

## Get started

1. Download the installer for your operating system and processor architecture.
2. Install and open NEURAFLOK.
3. In **Settings**, connect a provider or configure an API endpoint.
4. Start a normal chat, or open a project and approve the folders and capabilities it needs.

Linux may require a Secret Service keyring for secure credential storage. See the [setup and troubleshooting guide](docs/setup.md) for details.

## Privacy and security

NEURAFLOK runs locally and does not operate a user-account service, analytics backend, or telemetry service. Conversations, settings, recovery data, and credentials are stored on your computer; credentials use the operating system's secure storage. When you send a message, file, or activity to a connected provider, that provider receives the content through the session or API you chose and its own terms apply.

Local tools run with your operating-system user permissions. Review approved folders and enabled capabilities before using them. The repository is public, so its code, issues, pull requests, discussions, and releases can be viewed or copied by others. Never publish credentials, private conversations, user files, personal paths, or unredacted logs.

Read the [privacy policy](PRIVACY.md), [security policy](SECURITY.md), and [terms of use](TERMS.md). To report a vulnerability privately, follow [SECURITY.md](SECURITY.md).

## Development

Requires Node.js 22 and npm.

```sh
npm ci
npm run dev
```

Run the checks locally:

```sh
npm run typecheck
npm test
npm run verify:ui
```

CircleCI runs verification for configured pushes and pull requests. To publish installers for a future version, update the version metadata and release notes, then push a `vX.Y.Z` tag; CircleCI builds and verifies the installers before publishing them to GitHub Releases. See the [CircleCI release guide](docs/circleci.md).

For release builds, use the `dist:*` scripts in [package.json](package.json) on their target operating systems. See [CONTRIBUTING.md](CONTRIBUTING.md) for pull request requirements and [ARCHITECTURE.md](ARCHITECTURE.md) for the module map and security boundaries.

## Contributing

Contributions are welcome through pull requests targeting `develop`. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and follow the [Code of Conduct](CODE_OF_CONDUCT.md). The repository uses CI, code-owner reviews, and branch rules; see the [repository governance guide](docs/repository-governance.md).

- [Open an issue](https://github.com/Marco260104/neuraflok/issues)
- [Browse pull requests](https://github.com/Marco260104/neuraflok/pulls)
- [View GitHub contributors](https://github.com/Marco260104/neuraflok/graphs/contributors)

## Credits

**Creator and maintainer:** [Marco Torres (@Marco260104)](https://github.com/Marco260104).

People who contribute code are listed in the [GitHub contributors graph](https://github.com/Marco260104/neuraflok/graphs/contributors). Third-party components retain their original licenses and notices; see [NOTICE](NOTICE) and [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).

## License

NEURAFLOK application source is distributed under the [MIT License](LICENSE). Copyright © 2026 Marco Torres and contributors.
