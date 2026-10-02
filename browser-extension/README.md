# NEURAFLOK Browser Companion

The companion connects NEURAFLOK to authenticated DeepSeek, Kimi, Qwen, and Z AI pages. Provider websites retain model execution and account state. NEURAFLOK retains local sessions, tool authorization, and delivery records.

## Design boundaries

- `src/background/connectivity/` owns loopback discovery, pairing, authenticated requests, wake notifications, language sync, and safe updates.
- `src/background/browser/` owns exact tab and document custody, debugger operations, browser permissions, and bounded page inspection.
- `src/background/providers/` owns provider discovery, session binding, send claims, and response delivery.
- `src/provider-pages/` contains isolated provider DOM adapters and a shared, bounded delivery engine. These scripts never receive the bridge credential or direct local-tool access.
- `src/popup/` owns connection status, provider navigation, and companion localization.
- `_locales/` and `assets/icons/` provide browser-managed translations and NEURAFLOK artwork.

## Message and delivery flow

1. The popup requests status and provider navigation through the service worker.
2. The service worker discovers the loopback bridge, pairs the browser identity, stores the credential locally, and authenticates bridge requests.
3. Isolated page controllers report provider state and accept only bounded operations from the service worker.
4. A provider send is claimed for one conversation and tab before the page inserts text. Results and progress return with that same ownership proof.
5. Browser-control calls use a separate permission, tab lease, and receipt flow. An uncertain operation is not replayed automatically.

## Source map

| Path | Responsibility |
| --- | --- |
| `manifest.json` | MV3 permissions, supported hosts, service worker, popup, and page scripts. |
| `src/background/service-worker.js` | Runtime composition, message routing, alarms, and lifecycle registration. |
| `src/background/connectivity/bridge-client.js` | Port discovery, pairing epochs, authenticated HTTP, and wake socket. |
| `src/background/connectivity/bridge-store.js` | Stable browser identity, pairing credential, and bridge preference storage. |
| `src/background/browser/control/controller.js` | Browser-control leases, debugger lifecycle, live policy checks, and result receipts. |
| `src/background/browser/control/page-runtime.js` | Bounded frame access, page evaluation, screenshots, and DOM-only inspection. |
| `src/background/browser/control/input/actions.js` | Browser input dispatch for dialogs, text, selection, pointer, and keyboard operations. |
| `src/background/browser/control/input/coordinates.js` | Screenshot validation and frame-aware coordinate translation. |
| `src/background/browser/control/input/keyboard.js` | Named-key, alias, and modifier normalization for Chrome input events. |
| `src/background/browser/control/diagnostics.js` | Bounded console and network event capture, projections, sensitive-header redaction, and response-body reads. |
| `src/background/providers/session-runtime.js` | Popup status, provider-page restoration, and execution coordination. |
| `src/background/providers/session-observer.js` | Current-tab proof for open and signed-in provider state. |
| `src/background/providers/execution/` | Provider-specific send and response handling. |
| `src/provider-pages/shared/delivery-agent.js` | Provider-neutral message validation, session binding, send claims, and response polling. |
| `src/provider-pages/deepseek/` | DeepSeek DOM adapter, delivery configuration, and companion mark. |
| `src/provider-pages/web/` | Kimi, Qwen, and Z AI DOM adapter and delivery configuration. |

## Provider changes

The provider catalog in `src/background/providers/provider-catalog.js` is the extension's host and URL authority. Keep it aligned with `contracts/web-providers.ts`, the manifest, conversation prefixes, and provider tests. A URL alone never proves that the user is signed in; a response from the matching isolated page adapter is required.

## Validation

The provider, pairing, popup, browser-control, and packaged-extension checks live in `test/` and `scripts/`. The build stamp covers all loaded extension files, so packaging refreshes it after source or manifest changes.

## License

The NEURAFLOK browser companion is licensed under the MIT License (`SPDX-License-Identifier: MIT`). See [LICENSE](LICENSE) and [NOTICE](NOTICE).
