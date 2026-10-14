# Product

register: product

## License

NEURAFLOK application source is licensed under the MIT License. See [LICENSE](LICENSE), [NOTICE](NOTICE), and [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).

## Users

Developers and technically curious people who want a desktop workspace for coding with web-based AI assistants. They use their own signed-in provider accounts and need the app to show which provider is actually available before sending work.

## Product Purpose

NEURAFLOK is a local-first coding workspace that connects signed-in browser sessions for DeepSeek, Kimi, Qwen, and Z AI to approved local tools. OpenAI models are reached through the configured API endpoint. The app keeps conversations, project files, and the terminal together, makes provider and delivery state visible, and enables only sessions verified by its browser companion.

## Brand Personality

Clear, calm, and lively. The app should feel dependable during long coding tasks, with motion used to explain state and provide feedback rather than to decorate empty space.

## Anti-references

Avoid imitating any model provider's chat page, using a generic AI dashboard template, or making a connection look successful before a real browser-session check.

## Design Principles

- Show which account and browser tab own a send before work begins.
- Distinguish queued, submitted, responding, and completed states.
- Keep the conversation, project context, and terminal close enough to work across them.
- Let the extension report provider-specific evidence through one shared, bounded protocol.
- Make motion brief, useful, and optional through reduced-motion preferences.

## Accessibility & Inclusion

Keep keyboard navigation, visible focus, screen-reader status announcements, and high-contrast state labels. Respect the operating system's reduced-motion preference and do not use color alone to communicate connection or task state.
