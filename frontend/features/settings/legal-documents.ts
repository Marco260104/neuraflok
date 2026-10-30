/** In-app legal copy. PRIVACY.md, TERMS.md, and LICENSE must stay identical. */

export type LegalDocumentId = 'privacy' | 'terms' | 'license';

export interface LegalDocument {
  id: LegalDocumentId;
  title: string;
  markdown: string;
}

export const LEGAL_DOCUMENTS: Record<LegalDocumentId, LegalDocument> = {
  privacy: {
    id: 'privacy',
    title: 'Privacy policy',
    markdown: `# Privacy policy

Effective date: 30 October 2026

## Scope

This policy covers the NEURAFLOK desktop app and its bundled browser companion. The app runs locally and does not require a NEURAFLOK account.

## Data stored on your device

NEURAFLOK does not collect, sell, share, or receive your personal data through its own services. Conversation and project content is sent to a provider only when you choose to use that provider; the provider's own policies then apply.

NEURAFLOK stores conversation history, settings, workspace references, approved folders, task state, and recovery data on your computer. API credentials are stored through the operating system's secure credential storage when it is available. Local diagnostics and recovery files can contain paths, provider status, or conversation-related details; review them before sharing.

The maintainers do not receive local chats, files, credentials, or diagnostics through a NEURAFLOK telemetry or analytics service. Local data remains until you delete it or remove the app's data directory; uninstalling may not remove that directory automatically.

## Information sent to services you choose

When you send a prompt, conversation context, attachment, or project excerpt through a signed-in provider session or API, that provider receives the content needed to answer. If you enable tools or automation, tool results and follow-up instructions may also be sent to the selected model. The provider's own privacy policy, retention settings, terms, and account plan apply.

For API chats, the desktop process sends the stored API credential to the configured API endpoint. Credentials are not placed in the renderer or sent to NEURAFLOK maintainers. A custom endpoint is controlled by whoever operates that endpoint.

## Network requests

The app checks GitHub Releases for updates and downloads a verified update when you request installation. GitHub receives ordinary network request metadata for those requests. The app may also contact providers or services you explicitly configure, such as model APIs, optional plugins, or skill sources.

## Browser companion

The companion reads supported provider pages in the integrated browser so the app can verify a session and deliver the work you submit. The provider page handles the conversation. The companion does not send your browsing history to NEURAFLOK maintainers and does not grant itself local file access.

## Your choices

Use only providers and endpoints you trust. Do not submit confidential, regulated, or third-party information unless your provider account and organization allow it. You can remove saved API credentials in Settings and delete local app data from your computer.

## Children

NEURAFLOK is not designed for children under 13.

## Changes and contact

If this policy changes, the repository copy and the in-app copy in Settings → General → Legal are updated together. Report privacy or security concerns through GitHub's private vulnerability reporting. Do not include credentials, private conversation text, or personal file paths.
`
  },
  terms: {
    id: 'terms',
    title: 'Terms of use',
    markdown: `# Terms of use

Effective date: 30 October 2026

These terms describe use of the NEURAFLOK desktop app. The source code is separately licensed under the MIT License in LICENSE. These terms do not replace the terms of any provider or service you connect.

## Independent software

NEURAFLOK is an independent project created and maintained by Marco Torres with community contributions. It is not affiliated with or endorsed by DeepSeek, Anthropic, OpenAI, OpenRouter, Kimi, Qwen, Z AI, or a browser vendor. Product and company names identify services users may choose to connect.

## Providers, accounts, and costs

NEURAFLOK does not collect your personal data through an account, analytics, or telemetry service. When you send content to a connected provider, that provider processes it under its own terms and privacy policy.

You are responsible for your provider accounts, API keys, model selection, usage, charges, and compliance with each provider's terms. A provider may change availability, prices, limits, or supported models. NEURAFLOK does not control provider services and cannot guarantee that a request will be accepted or completed.

## Projects and local capabilities

The current browser-session and local MCP workflow is designed for small project tasks. It can read or change files and run commands only when the corresponding project, folder, and capability have been made available in the app. These controls reduce accidental actions; they are not an operating-system sandbox or a security boundary against malicious code running as your user.

For large corporate repositories or workloads that require organization-wide access controls, audit, retention, or compliance guarantees, use your organization's approved direct model API or gateway and its enterprise controls. NEURAFLOK does not provide an enterprise control plane, compliance certification, or corporate service-level agreement. A direct API connection does not by itself make a workflow compliant; follow your organization's policies.

You are responsible for backups, reviewing proposed changes and commands, and ensuring that you have the right to share project content with the selected model provider.

## Generated content

Model output is produced by the provider you selected and may be incomplete or incorrect. Review it before relying on it, executing it, or sharing it. It is not professional legal, medical, financial, or security advice.

## Availability and warranty

NEURAFLOK is provided as-is without a paid service, uptime promise, or support contract. The MIT License contains the software warranty disclaimer and limitation applicable to the source distribution. Nothing in these terms creates a provider relationship or guarantees that a model, account, or update service will remain available.

## Updates and changes

The app may check GitHub Releases for updates. These terms may change; the current version is published in this repository and in Settings → General → Legal.

## Contact

Use GitHub issues for product questions and GitHub's private vulnerability reporting for security issues.
`
  },
  license: {
    id: 'license',
    title: 'MIT License',
    markdown: `MIT License

Copyright (c) 2026 Marco Torres and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`
  }
};
