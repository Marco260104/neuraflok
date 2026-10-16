# Security policy

## Reporting a vulnerability

Report security issues privately through GitHub's vulnerability reporting for this repository. Include the app version, operating system, and a minimal reproduction. Remove account details, personal paths, conversation text, credentials, and unredacted diagnostics.

## Security boundaries

- The renderer uses a fixed preload API with context isolation and sandboxing. It has no direct filesystem, process, or credential access.
- The desktop process validates filesystem operations against approved roots and checks current capabilities before each local tool call. Approved roots constrain the app's file tools; they are not an operating-system sandbox.
- Terminal commands run with the logged-in user's normal operating-system permissions. Command policies can restrict which commands start, but do not sandbox an allowed process or its child processes.
- The companion extension observes supported provider pages and sends bounded browser events to the local bridge. It cannot execute local tools or grant itself filesystem access.
- Browser sessions establish that a supported provider page is signed in. They do not establish provider approval, account entitlement, or available model limits.
- API credentials are held by the desktop process and stored through Electron `safeStorage`. Conversation history and session metadata are stored locally and may contain sensitive user content.
- Optional plugin servers and the local control API have their own endpoints and credentials. Enable them only when needed and protect their tokens as access to the data or actions they expose.

## Limitations

Release packages may be unsigned or unnotarized. Verify published checksums before installing. Local path checks and capability controls reduce accidental access but do not protect against malware or another process running as the same user.

The Linux AppImage may add `--no-sandbox` when the host disables unprivileged user namespaces. On restrictive Debian or Ubuntu systems, use the DEB package if you do not want that fallback.

Review provider terms and usage rules before connecting. Stop a workflow when a provider refuses an action or restricts an account; local permissions do not override those decisions.

See [Setup and help](docs/setup.md) for account, permissions, and recovery guidance.

Community conduct is described in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

NEURAFLOK application source is licensed under the [MIT License](LICENSE).
