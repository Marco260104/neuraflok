# NEURAFLOK

<p align="center"><img src="brand/Logotipo.png" alt="NEURAFLOK" width="520"></p>

<p align="center">A local coding workspace for signed-in AI sessions, project files, and approved tools.</p>

NEURAFLOK brings browser conversations, local projects, and a terminal into one desktop workspace. Its companion extension verifies supported provider sessions before the app routes work to them. Local tools stay behind explicit folder and capability permissions.

## Providers

NEURAFLOK can connect to signed-in browser sessions for DeepSeek, Kimi, Qwen, and Z AI. OpenAI models use the configured OpenAI API endpoint only. OpenRouter and compatible API endpoints are also supported.

## Features

- Local conversations, project folders, durable history, and queued input.
- A workspace terminal, bounded file access, file editing, and project search.
- Browser and API conversation routes with provider-specific session checks.
- Optional multi-agent workers, task goals, and continuation controls.
- A browser companion for provider observation and authorized delivery.
- Local tools run behind explicit folder and capability checks.

## Architecture

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the backend, frontend, preload boundary, extension, and persistence map. NEURAFLOK uses local durable files for sessions and settings; it does not require a database server.

## Development

Requires Node.js 22 and npm. Install dependencies and start the desktop app:

```powershell
npm ci
npm run dev
```

Build the app and extension bundle with:

```powershell
npm run typecheck
npm run build
```

Run the project checks with `npm test` and `npm run verify:ui`.

## System requirements

- Windows 10 or 11, macOS 13 Ventura or newer, or a current desktop Linux distribution.
- Linux installations need a Secret Service keyring for secure credential storage.
- Use a signed-in DeepSeek, Kimi, Qwen, or Z AI browser session, or configure the OpenAI API or another compatible API endpoint.
- The integrated browser loads the companion automatically; no manual extension installation is required.

## Permissions and privacy

Review approved folders and tool capabilities before using local tools. Conversation history and provider session metadata may be stored locally to support recovery. API request data is sent only to the endpoint configured for that conversation. Browser providers control their own accounts, model availability, limits, and terms.

## License

NEURAFLOK is licensed under the [MIT License](LICENSE) (`SPDX-License-Identifier: MIT`).
Copyright © 2026 NEURAFLOK contributors.

Separately licensed components retain their required notices in [NOTICE](NOTICE) and [third-party notices](THIRD-PARTY-NOTICES.txt).
