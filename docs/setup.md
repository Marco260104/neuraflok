# Setup and help

[Back to NEURAFLOK](../README.md)

## Quick start

1. Install NEURAFLOK for your operating system and launch it.
2. Open **Setup**, choose DeepSeek, Kimi, Qwen, or Z AI, and select **Connect**. NEURAFLOK opens its integrated browser and loads the browser extension automatically.
3. Sign in with the provider in that browser. Setup reports the session only after the extension verifies the provider page.
4. Approve a project folder in **Workspace** and review the local tool permissions.
5. Choose the verified provider session, write a task, and send it.

The browser extension is bundled with NEURAFLOK. There is no separate download or manual extension installation step.

## Provider sessions

Provider accounts and model availability remain controlled by each provider. NEURAFLOK does not ask for provider passwords. Use **Connect** to open the selected provider in the integrated browser, then sign in there. Use **Disconnect** to clear that provider session from the built-in browser.

The provider picker distinguishes a saved preference from a verified signed-in session. A provider without a verified session cannot receive browser work. Browser conversations stay bound to the provider where they were started.

## API model connections

Open **Settings → Manage models** to configure an API provider, credential, and model:

- **OpenAI** connects directly to GPT models using your OpenAI API key.
- **OpenRouter** exposes its live catalog, including Claude, GPT, and DeepSeek models.
- **Custom API** connects to OpenAI Chat Completions-compatible services and directly to the Anthropic Messages API. Configure its name, base URL, protocol, chat path, optional models path, model ID, authentication header and prefix, API key, and optional extra headers. For DeepSeek, use `https://api.deepseek.com`; its model catalog can change over time.

Custom APIs must implement the protocol selected in settings: OpenAI Chat Completions or Anthropic Messages. Extra headers and API keys are kept in the operating system's secure credential storage and are sent by the desktop process only to the endpoint you selected. APIs that expose neither protocol need a compatible gateway or a dedicated adapter; changing routes and headers cannot translate a proprietary request/response format.

The browser-session/MCP workflow is designed for small project tasks. For a large corporate codebase or workloads with organization-wide governance, audit, or compliance requirements, use your organization's approved direct API or gateway and apply its controls. NEURAFLOK does not provide enterprise governance or compliance certification.

For an API conversation, configure the endpoint, key, and model in **Settings → Models**. Credentials are held by the desktop process. Each API conversation keeps the endpoint and model selected when it was created.

## Projects and local tools

Add a project folder from the workspace sidebar. A project groups conversations and supplies their working directory; it does not grant filesystem permission by itself. Approve the containing folder in **Settings → Workspace**, then enable only the capabilities the project needs.

The desktop process owns local files, terminal commands, tool permissions, and saved history. The renderer and browser companion cannot bypass those checks. Review tool results in the conversation before relying on their outcome.

## Continuity

NEURAFLOK saves local conversations and accepted messages so queued work and history can survive an app restart. Delivery status distinguishes a queued message from one placed in the provider composer and one accepted by the provider page.

Task plans, workers, Goal, Loop, and continuation controls depend on the selected executor and provider support. Browser sessions expose the tools verified for that provider; these controls do not increase provider limits or account access.

## Troubleshooting

- **A provider is not available:** open it through **Connect** in NEURAFLOK's integrated browser and complete sign-in there.
- **The companion is missing:** restart NEURAFLOK so it can refresh the bundled companion in its browser profile.
- **A message remains queued:** inspect its delivery notice and the Activity log before retrying; a queue state does not prove that the provider received it.
- **A local tool is refused:** review the approved workspace roots and the named capability in Settings.
- **Credential storage is unavailable on Linux:** unlock the desktop keyring and restart NEURAFLOK.

## Build and contribute

```sh
npm ci
npm run dev
npm run typecheck
npm test
```

Use `npm run verify:ui` for the UI checks. Build installers on the target operating system with the matching `npm run dist:*` command from `package.json`.

NEURAFLOK is licensed under the MIT License.

[Architecture](../ARCHITECTURE.md) · [Security](../SECURITY.md) · [License](../LICENSE)
