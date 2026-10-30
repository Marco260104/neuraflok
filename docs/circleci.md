# CircleCI builds and releases

NEURAFLOK uses CircleCI for verification and installer builds. GitHub remains the source repository and the place where public release notes and installer downloads are hosted; CI/CD runs in CircleCI rather than GitHub Actions.

## One-time setup

1. Install CircleCI's GitHub App, connect `Marco260104/neuraflok`, and select the trigger **PR opened or pushed to, default branch and tag pushes**. CircleCI reads the configuration from `.circleci/config.yml`.
2. Create a GitHub fine-grained personal access token scoped only to this repository, with **Contents: Read and write** permission. The token is only used to create a release and upload its assets.
3. In CircleCI, create the `neuraflok-release` context and add the token as `GH_TOKEN`. Restrict that context to the maintainer account. The publish job is the only job that uses it.
4. Run a normal branch pipeline and confirm its verification status appears on pull requests. The stable release workflow only accepts tags matching `vX.Y.Z`.

The release token is not needed for local development or ordinary verification. Do not put it in repository files, project-wide environment variables, or a public build artifact.

CircleCI's GitHub App does not start pipelines for pull requests from forks. For those PRs, review the changes and arrange a trusted verification run before merging; same-repository PRs and version-tag pushes are covered by the configured trigger.

## Publishing a future version

Maintainers update the version metadata and editorial notes once per release. Keep these values aligned:

- `package.json` and `package-lock.json`
- `browser-extension/manifest.json`
- `APP_VERSION` in `backend/infrastructure/settings/version.ts`
- the newest version heading in `CHANGELOG.md`
- `docs/release-notes/vX.Y.Z.md`

After the version change is reviewed and merged, push the matching tag, for example `v0.2.0`. CircleCI validates the tag and release notes before starting platform builds, then builds and smoke-tests Windows x64/ARM64, macOS x64/ARM64, and Linux x64/ARM64. It assembles the browser extension and native source archive, verifies every SHA-256 checksum, uploads the complete set to a draft GitHub Release, checks the uploaded asset names and sizes, and publishes it only after those checks pass.

No one needs to build or upload the installers manually. If a pipeline fails, fix the cause and rerun it before publishing. A published stable tag is immutable for this workflow; use a new version and tag for a corrected release.

## CircleCI limits

CircleCI account setup, available executors, and monthly credits are controlled by CircleCI. macOS, Windows, and ARM builds consume runner credits. Check the project's CircleCI plan before running repeated release builds. The repository config avoids scheduled release builds; installer jobs run only for version tags.
