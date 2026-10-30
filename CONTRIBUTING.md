# Contributing to NEURAFLOK

NEURAFLOK is a desktop workspace for verified DeepSeek, Kimi, Qwen, and Z AI browser sessions and approved local tools. Focus changes on a clear user need and preserve the existing security and delivery boundaries.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development

Requires Node.js 22 and npm. Install dependencies and start the desktop app:

```sh
npm ci
npm run hooks:install
npm run dev
```

Before submitting a change, run the closest focused checks and the project type check:

```sh
npm run typecheck
npm test
```

Use `npm run verify:ui` for interface changes. Build installers on the target operating system with the matching `npm run dist:*` script in `package.json`.

## Pull requests

Open a pull request against `develop`. Keep one topic per PR. Turn on **Allow edits by maintainers**. Do not push directly to `main` or `develop`; those branches are intended to accept reviewed pull requests. The repository owner is the code owner for all files, so the recommended GitHub rules require the owner's approval before a pull request can merge. The owner configures those remote rules in [repository governance](docs/repository-governance.md).

Fill in the pull request template so reviewers have the context they need:

- **Why** — the root cause or the user problem, in a few sentences.
- **What changed** — the behavior change, not a file list.
- **Test** — add or update a test for the behavior change, and list the checks you ran. Write `No test: <reason>` when a test does not apply.
- **Screenshots** — before and after images for interface changes, or `No visual change: <reason>`.

When a shared contract changes (preload, IPC, or `contracts/`), update [ARCHITECTURE.md](ARCHITECTURE.md) in the same PR, or write `No contract change: <reason>`.

Keep a change under 600 lines outside tests and translations, or add `Large change: <reason>`. Split unrelated work.

CircleCI runs the project verification workflow on configured pushes and pull requests. Stable installer releases run when a `vX.Y.Z` tag is pushed; maintainers update version metadata and release notes, while CircleCI builds, verifies, and uploads the installers. See the [CircleCI release guide](docs/circleci.md).

## Change guidelines

- Keep each change focused and preserve approved-folder and capability checks.
- Add a regression test when changing observable behavior or a trust boundary.
- Keep comments concise, single-line, and in English.
- Do not include credentials, private conversations, personal paths, generated binaries, or unrelated worklogs in a change.
- Update the user and architecture documentation when a public workflow or module boundary changes.
- Preserve applicable third-party attribution and license texts; see [LICENSE](LICENSE), [NOTICE](NOTICE), and [third-party notices](THIRD-PARTY-NOTICES.txt).

## Security reports

Report vulnerabilities privately using the contact method in [SECURITY.md](SECURITY.md). Do not publish credentials, private session data, or unredacted diagnostics in an issue.

## License

Contributions to NEURAFLOK are distributed under the MIT License (`SPDX-License-Identifier: MIT`) in [LICENSE](LICENSE).
