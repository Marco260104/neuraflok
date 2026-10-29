# Repository governance and privacy

This guide separates controls already defined in the repository from settings that an administrator must enable on GitHub. The repository is public: documenting a rule here does not enforce it until an administrator activates it in GitHub.

## Who can approve changes

The [`.github/CODEOWNERS`](../.github/CODEOWNERS) file assigns all files to `@MARCO260104` and explicitly protects the owners file itself. This identifies who should review code, but does not by itself prevent a pull request from being merged.

To require your approval before changes are merged into `main` or `develop`:

1. Open **Settings → Rules → Rulesets → New branch ruleset** on GitHub.
2. Create an active ruleset that targets the `main` and `develop` branches.
3. Enable **Require a pull request before merging** and require **1 approval**.
4. Enable **Require review from Code Owners**, **Dismiss stale pull request approvals when new commits are pushed**, **Require approval of the most recent reviewable push**, and **Require conversation resolution**.
5. Require the **Verify** CI status check. GitHub shows its exact name after it has run on a pull request.
6. Block force pushes and branch deletion.
7. In **Bypass list**, allow **Repository admins** to bypass rules only for pull requests. Keep your account as the only administrator; any other admin can also approve or bypass these rules.

Keep only your account in `CODEOWNERS` if you want to retain exclusive code-owner approval. GitHub needs your account to have repository write access so it can require your review; the repository owner already has that access. Other contributors can propose changes through branches and pull requests without receiving repository administration.

GitHub does not approve an isolated push. These controls apply when someone tries to merge changes into a protected branch. Contributors can create branches or forks and open pull requests; `main` and `develop` change only through the rules above.

## Additional recommendations

- **GitHub Actions:** In **Settings → Actions → General**, set the default `GITHUB_TOKEN` permission to read-only and let each workflow request only the permissions it needs. Release workflows already limit `contents: write` to the job that creates a release; other jobs use read access.
- **Releases:** Review release notes and assets before publishing. Stable releases use `vX.Y.Z` tags; consider adding a ruleset to prevent those tags from being moved or deleted. Releases include `SHA256SUMS.txt` to verify installers.
- **Private security reports:** In **Settings → Advanced Security**, enable **Private vulnerability reporting**. This lets people report vulnerabilities without first publishing them in an issue. The reporting channel should match [SECURITY.md](../SECURITY.md).
- **Secrets:** GitHub provides secret scanning for public repositories. Check **Settings → Advanced Security** and enable push protection if available. Revoke and rotate any secret that has entered repository history; deleting it in a later commit does not invalidate an exposed credential.
- **Contributors:** Keep repository administrator access limited to your account. Give others only the permissions they need; occasional contributors can open pull requests from forks. Review permissions for connected apps and automations.
- **Public content:** Issues, pull requests, reviews, conversations, and releases are visible. Do not attach chats, user documents, personal paths, tokens, session dumps, or unredacted logs. Keep private data out of Git and use the private reporting channel in the security policy.
- **Community features:** Keep Issues enabled for bug reports and suggestions. Disable Discussions, Wiki, or Projects if you do not plan to moderate them. Existing issue templates request the app version, operating system, and minimal reproduction steps, and ask reporters to remove personal data.
- **Dependencies:** Dependabot checks npm dependencies and GitHub Actions weekly. Review its pull requests like any other change; do not auto-approve them.

## Controls already in this repository

- `CODEOWNERS` designates the maintainer's account as code owner.
- `SECURITY.md`, `PRIVACY.md`, `TERMS.md`, and `CODE_OF_CONDUCT.md` cover security, privacy, terms, and community conduct.
- `.gitignore` excludes common environment files, certificates, and local data.
- The CI workflow uses read-only permissions and checks history privacy, dependencies, types, and tests.
- `CONTRIBUTING.md` directs pull requests to `develop` and documents review and CI requirements.

GitHub's official documentation confirms that branch rules and Code Owner reviews must be configured in repository settings; a `CODEOWNERS` file alone does not require approval. See [available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets), [creating rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository), [about code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners), [private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository), and [secret scanning](https://docs.github.com/en/code-security/how-tos/secure-your-secrets/detect-secret-leaks/enable-secret-scanning).
