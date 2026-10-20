# NEURAFLOK architecture

NEURAFLOK is a local-first desktop workspace for browser-based AI sessions, approved local tools, and project files. The code is organized into application, domain, infrastructure, and persistence layers.

## Repository map

```text
backend/
  application/                 Startup and fixed renderer-facing routes
  domains/                      Product capabilities and their state owners
    automation/                 Goals, plans, and worker conversations
    browser/                    Browser sessions and integrated browser
      command-broker/            Typed browser-command policy, queue, delivery, and restoration
    connectors/                 Optional external tool integrations
    providers/                  Browser and API execution, models, and usage
    sessions/                   History, input, and continuity
      input/attachments/         Staging, membership checks, and provider content adapters
    skills/                     Skill catalog, import, and prompt selection
    workspace/                  Projects, files, search, terminal, and process execution
      execution/                Environment policy, command preparation, process control, and output
  native/                       Native screen, input, and helper sources
  persistence/                  Durable local-file publication
  infrastructure/               Electron, OS, network, and tool adapters
    binaries/                    Bundled command discovery and runtime selection
    connectivity/               Browser bridge health and provider presence
    desktop-shell/              Window, tray, update, and shutdown lifecycle
    device-control/             OS-backed screen and input adapters
    local-api/                  Opt-in loopback control surface
    settings/                   Configuration, secrets, logging, and diagnostics
      config.ts                 Stable public settings API
      config/                   Defaults, validation, upgrades, and atomic settings storage
      logger.ts                 Stable logging API and in-memory activity stream
      logger-redaction.ts       Credential masking and bounded text
      logger-format.ts          Clipboard and JSON diagnostic formats
      logger-file-mirror.ts     Bounded asynchronous log persistence and crash snapshots
    tool-gateway/               Permission-checked local tool protocol
  preload/                      Electron preload facade
    api/                        Desktop, skills, attachments, browser, project, session, and event APIs
  main.ts                       Electron entry point
frontend/                       Renderer UI, grouped by product capability
  features/browser/toolbar/     Integrated browser tab strip, state rendering, and actions
  features/settings/skill-library/  Managed skill cards, GitHub checks, dialogs, and composition
  features/setup/               Setup step navigation, progress, and Ready state
  styles/                       Ordered CSS modules for base, permissions, setup, chat, and workspace
    chat/                       Chat shell, session list, timeline, tool activity, compaction, and agent styles
  styles.css                    Stylesheet entry that imports the modules in cascade order
contracts/                      Validated types and policies shared across process boundaries
  sessions/                     Session events, summaries, agents, activity, and search contracts
  messaging/                    Versioned provider-message envelopes and transcript projection
  browser/                      Browser-site admission and cross-window policies
  usage/                        Usage DTOs, calendar aggregation, and cost estimation
  workspace/                    Projects, Git changes, terminals, and local processes
brand/                          NEURAFLOK identity assets
browser-extension/
  src/background/connectivity/  Pairing, authenticated transport, wake channel, language sync, and safe updates
  src/background/browser/       Exact tab custody and permission-checked browser tools
  src/background/providers/     Provider presence, session binding, and delivery execution
  src/provider-pages/           Isolated adapters for DeepSeek, Kimi, Qwen, and Z AI
  src/popup/                    Companion status, localization, and provider navigation
  assets/icons/                 Extension brand assets
  _locales/                     Browser-managed localization catalogs
  build-stamp.txt               Release identity used by safe companion updates
resources/                      Platform packaging inputs
test/                           Unit, integration, and workflow coverage
scripts/                        Build, packaging, and verification tools
docs/                           Product, release, and license records
```

`brand/Logotipo.png` is the sidebar wordmark; `brand/LogotipoSN.png` is the app mark used for desktop, browser-extension, and tray icons. The tray renderer keeps platform-specific connection badges and macOS template behavior, and the packager places the unmodified mark in application resources.

The scheduled GitHub digest lives under `scripts/weekly-digest/`: the API client, pull-request and issue collectors, Markdown renderer, and publisher have separate owners. `scripts/weekly-digest.mjs` is the environment-aware entry point and exposes only the pure policy and rendering helpers to tests.

The opt-in Windows desktop smoke keeps `scripts/smoke-windows-desktop.mjs` as its entry point. `scripts/windows-desktop-smoke/` separates process supervision, fixture preparation, generated Electron probe source, capture assertions, input checks, artifact assembly, and orchestration.

The real-Electron dense-history regression keeps `scripts/verify-history-scroll.cjs` as its entry point. `scripts/verify-history-scroll/` separates renderer fixture assembly, paging behavior, refresh behavior, pending-input anchoring, revised-history checks, and optional recording replay.

## Ownership boundaries

`backend/domains/sessions/input/request-plans/service.ts` owns request-scoped plan updates, exact-correlation attachment, and startup reconciliation. `request-plans/ledger.ts` owns serialized durable snapshots, validation, expiry, bounded retention, and rollback when persistence fails.

`backend/domains/sessions/history/prepare-markdown-export.ts` selects and reads exportable history, including overflow text. `backend/infrastructure/desktop-shell/session-markdown-export.ts` owns Electron clipboard, save dialogs, and file writes.

`contracts/automation/worker-overview-health.ts` projects exact broker and session evidence into worker health and activity for the agent panel. It owns no worker lifecycle state and does not perform recovery.

`backend/domains/automation/task-requests/errors.ts` owns classified request failures; `retry.ts` owns abortable retry timing and publication; `registry.ts` owns request identity, deduplication, cancellation, and the bounded in-flight registry.

`backend/domains/browser/preferences/handshake.ts` owns the single pending extension preference request, its bounded expiry, nonce validation, and promise settlement.

`frontend/features/settings/search/` separates the settings entry model, visible-page indexing, language-aware result ranking, and keyboard-accessible search controller.

`frontend/features/settings/view-menu.ts` owns the title-bar menu lifecycle and keyboard entry; `view-menu-items.ts` builds the search, integrated-browser, and zoom actions.

`frontend/features/settings/usage.ts` owns usage refresh, reporting-period preferences, and rate editing. `usage/cost-view.ts` owns the annual context heatmap, model estimates, and daily cost views.

`contracts/usage/` separates shared usage DTOs, calendar-period aggregation, and cost estimation. `contracts/usage.ts` remains the stable import barrel for existing consumers.

`contracts/workspace/` groups renderer and backend contracts for local projects, Git snapshots and diffs, workspace terminals, and app-managed execution processes. Workspace consumers import these contracts from this domain folder.

`contracts/workspace/project-files.ts` owns the typed directory, preview, mutation, save, and watcher payloads used by the project Files surface.

`contracts/sessions/continuity-brief.ts` owns the editable continuation format and its thorough, standard, and short length policy.
`contracts/chronology/` separates event and turn types, position lookup, request-to-turn identity, display-boundary projection, and deterministic event ordering. `contracts/chronology.ts` remains the stable public contract entry point.

`contracts/messaging/provider-message-envelope.ts` adds hidden workspace guidance to provider messages and restores authored text for transcript readers. It emits the current versioned envelope and recognizes stored formats needed by existing conversations.

`contracts/browser/integrated-site-policy.ts` derives supported provider hosts from the shared provider catalog and adds only the approved sign-in hosts for integrated browser navigation.

`contracts/appearance-validation.ts` owns the shared appearance schema used by settings storage and IPC. `contracts/appearance-settings.ts` owns saved values and defaults, `appearance-color.ts` owns color math, and `appearance-tokens.ts` derives the renderer palette. Settings, desktop chrome, browser chrome, and tests import these owners directly.

`contracts/command-allowlist/` owns the local command policy: `types.ts` defines its contracts and limits, `invocation-parser.ts` tokenizes supported shell commands, `rules.ts` validates saved rules, and `policy.ts` evaluates allow/deny decisions. Consumers import directly from the owning module.

`contracts/windows-computer/operation-policy.ts` owns the Windows Desktop method catalog and derives read, input, and fresh-observation permissions from each operation's policy. Consumers import this owner directly.

`contracts/skills/invocation.ts` parses leading skill commands and returns the selected IDs with the untouched authored text. Backend, frontend, and tests import the contract from this owner directly.

`contracts/automation/completion-policy.ts` centralizes model and mode eligibility for finish automation and supplies the shared completion reminder used by browser and local tool delivery.

`contracts/session.ts` remains the public session-contract entry point. `contracts/sessions/events.ts` owns recorded event and tool-call shapes, `summary.ts` owns durable session and continuation metadata, `agents.ts` owns broker contracts and reasoning levels, `activity.ts` owns timeline folding and context estimates, and `search.ts` owns search replies.

`contracts/sessions/continuation-marker.ts` owns handoff and resume marker creation, parsing, and legacy compatibility. Session events re-export its parser, and provider-message framing uses the same identity reader so stored continuation markers survive prompt wrapping.

`backend/preload/index.ts` is the stable Electron entry and exposes the renderer API through `contextBridge`. `backend/preload/api/` owns the typed IPC helper, preload response contracts, and APIs grouped by capability; renderer imports continue to use the `AppApi` facade.

`frontend/features/workspace/file-panel.ts` coordinates workspace selection, previews, and Git review. `file-panel-layout.ts` owns the file-panel DOM shell, while sibling modules own tree rendering, actions, editing, Git presentation, resizing, and file watching.

`backend/infrastructure/settings/logger.ts` keeps the logging API and bounded in-memory activity stream. `logger-redaction.ts` owns credential masking and message limits, `logger-format.ts` owns clipboard and JSON projections, and `logger-file-mirror.ts` owns bounded asynchronous writes, rotation, shutdown flushing, and crash snapshots.

`backend/infrastructure/settings/config.ts` remains the public settings API. `config/defaults.ts` owns first-launch and recovery defaults, `schema.ts` validates settings, `migrations.ts` upgrades stored versions and applies default changes, and `store.ts` owns file reads, recovery, serialized updates, and atomic persistence.

`backend/domains/automation/agents-types.ts` owns the worker, run, staged-transition, and caller-status contracts. `agents-state-policy.ts` owns the shared worker terminal, slot, stop, and context-ceiling predicates; `agents-errors.ts` owns public worker-domain errors, `agents-limits.ts` owns bounded runtime policy values, and `agents-runtime-state.ts` owns process-local maps and lifecycle state. `agents-persistence-codec.ts` serializes and restores worker snapshots through explicit state and validation callbacks; `agents-persistence.ts` owns durable persistence coordination. `agents-reset.ts` owns the ordered reset of process-local worker state for tests. `agents.ts` keeps the existing public exports and coordinates the domain modules.

`agents-identity.ts` also owns caller-scoped resolution and status. `agents-run-registry.ts` reactivates parked histories as fresh run incarnations. `agents-spawning.ts` creates prime records, lists pending worker bootstraps, and filters browser-open requests; `agents-bridge-registration.ts` owns pending worker-spawn registration and local-delivery activation; `agents-messaging.ts` coordinates routed delivery and inbox acknowledgement, while `agents-messaging/staging.ts` owns bounded worker-message validation, durable staging, commit, and rollback; `agents-messaging/prime-message-staging.ts` owns cross-family prime messages and destination ownership checks.

`backend/application/` starts the app and composes the fixed renderer API. `startup.ts` preserves initialization order; `window-controller.ts` owns main-window creation, native policy, and persisted geometry; `tray-controller.ts` owns tray creation, refresh subscriptions, and teardown. Each domain in `backend/domains/` owns a product capability and its durable decisions. Domains use one another through exported APIs so a fact has one authoritative owner.

Chat action, automation, composer-input, composer-delivery, detail-renderer, input-queue, project-control, progress, session-list, session-row, settings, task-plan, timeline-history, and queue-display modules define owner-level runtime contracts. These modules no longer import runtime types from the chat coordinator, keeping the composition root out of their dependency graphs.

`queued-task-list.ts` defines `QueuedTaskListRuntime` for queue-row projection instead of reaching into the chat coordinator for its type. The outbox controller remains responsible for supplying queue state and callbacks.

`backend/domains/skills/skill-identifiers.ts` owns safe Skill IDs, slugs, and Markdown import IDs. `skill-summary-metadata.ts` extracts bounded display metadata and safe legacy Markdown fallbacks. `storage/` separates catalog reads, local files, package lifecycle, and shared filesystem checks. `skill-library.ts` composes managed and external Skill discovery; `skill-library-access.ts` owns approved reads and package interface checks; `skill-library-sources.ts` resolves discovery roots and Claude plugin sources; `skill-library-instructions.ts` builds the bounded skill index, while `skill-library-types.ts` holds its internal contracts. `user-skills.ts` limits external Skill files to read-only virtual paths, including active `.agents` and Claude folders; these are user content sources, not repository instruction files. `index.ts` exposes the domain API.

`backend/domains/skills/access/` separates three trust decisions: `managed-roots.ts` inserts the canonical library and chooses the task root, `path-policy.ts` classifies managed and virtual Skill paths, and `linked-package.ts` resolves package links only through approved roots and rechecks them after resolution.

`backend/domains/sessions/input/` owns durable outbox state and the companion's `/input/*` routes. `input-browser-claims.ts` owns pending provider-page offers, exclusive browser claims, and the frozen delivery payload; `input-browser-decisions.ts` owns process-local decision waiters and decision receipts; `input-pickup-recovery.ts` owns source-turn pickup budgets and durable attempts; `input-recovery-operations.ts` owns silence and unfinished-response ticket operations; `input-policy.ts` owns eligibility projections; `input-tool-delivery.ts` owns bounded MCP tool-input offers and exact call-receipt evidence; `input-turn-queries.ts` owns after-turn eligibility, pickup projections, Goal ordering, and completed-turn boundaries; `input-queue-controls.ts` owns queue cancellation, reordering, editing, finish-task cleanup, automation changes, and startup error updates. `input-delivery-receipts.ts` owns browser and local-executor acknowledgments, provider binding, and delivery-failure recovery. `input-startup-recovery.ts` owns durable outbox reconciliation, opening repair, origin restoration, and stale decision cleanup. `input.ts` composes these around the serialized outbox and its durable state transitions. The browser bridge supplies authenticated request context and browser-specific custody checks without deciding input delivery state.

`backend/domains/automation/goal.ts` coordinates Goal draft lifecycle and public behavior. `goal-request-drafts.ts` owns request creation, `goal-reply-recovery.ts` owns accepted-reply obligations, bounded pickups, source-turn validation, and input consumption, and `goal-reply-ledger.ts` owns durable reply state.

`backend/domains/sessions/history/` owns session event detail projection and binary-safe previews, shared by the bridge activity routes and the session read model. `session-event-reader.ts` owns bounded journal scans, canonical message merging, and timeline ordering; `session-event-queries.ts` owns semantic turn completion, recovery-boundary, handoff, and browser-activity queries through the durable session queue. `session-metadata.ts` validates summary checkpoints and recovery from backup metadata; `session-summary-projection.ts` owns the initial and event-derived session summary state; `session-history-rebuild.ts` reconstructs a summary from canonical message shards and journal history when a checkpoint is stale; `summary-format.ts` and the `summary-*-tools.ts` modules format bounded tool summaries by result type; `summary-types.ts` defines their shared contracts; `summarize.ts` preserves the public summary API. `session-documents.ts` owns serialized agent plans and bounded turn-trace documents; `session-canonical-messages.ts` owns canonical message types, shard reads and writes, and alias collapse; `session-journal-recovery.ts` owns durable sequence recovery and torn-line sealing; `session-store-paths.ts` owns session root and per-session storage paths; `store.ts` initializes those paths and composes the durable history owners with the session queue; `session-message-writes.ts` owns canonical provider message revisions and native image updates using the store queue and asset policy; `session-process-calls.ts` owns canonical process-launch receipts and their completion revisions; `session-compaction-policy.ts` owns compaction eligibility and durable refusal; `unattributed-bucket-rewrite.ts` owns the scoped migration of tool calls from the legacy Unattributed bucket; `session-lifecycle.ts` handles session metadata, provider binding, handoffs, and deletion through that store runtime. `session-assets.ts` composes content-addressed binary files, quotas, bounded reads, binary writes, and overflow-text storage; `session-asset-reference-ledger.ts` owns write and cleanup epochs plus asset-reference admission and retirement; `session-image-reference-retirement.ts` owns the policy for retiring canonical event references before deleting images. `session-catalog.ts` owns the rebuildable session summary index, conversation lookup and lineage checks, and bounded session paging; it reads durable metadata and the live overlay through an explicit store runtime. `event-redaction.ts` owns safe serialization and sensitive tool-event redaction; `attribution-repair.ts` owns exact-correlation repair of unattributed tool events; `recorder-images.ts` owns bounded decoding and persistence of recorded image bytes and native preview assets; `recorder-observation-lifecycle.ts` owns idempotent durable turn starts, turn ends, and their live recovery projection; `recorder-observations.ts` owns provider-page observation contracts, serialized transcript processing, and superseded-message writes through an explicit runtime; `recorder-request-evidence.ts` owns bounded request-ID waits, exact provider-page proof, and the shutdown-flushed late-attribution repair queue; `recorder-app-events.ts` owns app notes, progress, agent-message and handoff events through injected recorder dependencies; `recorder-tool-writer.ts` owns tool-call redaction, media and review assets, durable event writes, and attribution callbacks; `recorder-session-lifecycle.ts` owns first-sight session initialization, stored-turn replay, title and origin promotion, and unattributed-session state; `recorder.ts` coordinates attribution admission while preserving the public recorder API.

`session-asset-filesystem.ts` owns verified asset-directory and file checks, physical quota inventory, and atomic image quarantine/deletion. `session-image-reference-retirement.ts` owns the policy for retiring canonical event references before deleting images; `session-assets.ts` composes that policy and filesystem boundary with per-session quota caches, binary writes, and overflow-text storage.

`backend/domains/browser/session-activity.ts` owns transient browser activity grants and their read-time deadline projection. The session read model imports this narrow owner instead of loading the browser bridge.

`backend/domains/browser/companion-payload.ts` validates extension conversation IDs, call evidence, and transcript observations before the bridge can pass them to session history.

`backend/domains/browser/bridge-http-boundary.ts` owns extension-origin checks, bearer and protocol validation, bounded JSON parsing, CORS responses, and the shared request limit. The bridge composes it with the authenticated route handlers.

`backend/domains/browser/command-broker/admission.ts` owns command identity, deduplicated queue admission, worker and continuation commands, and pending-command projections. `bridge.ts` supplies the durable queue, deadline, delivery, and lifecycle owners through an injected runtime.

`backend/domains/browser/bridge-browser-opening.ts` owns provider-bound chat URLs, command URL construction, browser-open attempts, and opener custody. API conversations are refused at this boundary and continue through the API executor.

`backend/domains/browser/bridge-browser-credentials.ts` owns serialized browser credential updates and explicit unpairing, including the durable disconnected marker and credential epoch.

`backend/domains/browser/bridge-status.ts` owns the read-only aggregation of bridge health, extension presence, pairing, and page-verified provider presence. It projects the existing bridge and provider owners without taking ownership of their state.

`backend/domains/browser/bridge-status-runtime.ts` composes presence, browser credentials, extension health, and status queries. It owns bridge-change subscriptions and provider-presence updates; `bridge.ts` supplies the live socket, port, error, wake, and companion-client references.

`backend/domains/browser/bridge-listener.ts` owns the loopback HTTP socket, candidate-port binding, canceled-start cleanup, and bounded connection draining. `bridge-server-lifecycle.ts` owns server startup recovery, event subscriptions, maintenance scheduling, shutdown cleanup, and settings-driven port publication; `bridge.ts` composes these owners with browser wake and command state.

`backend/domains/browser/command-broker/model.ts` owns browser command specifications, leases, receipts, wire records, and acknowledgements. `command-broker/policy.ts` owns command timing, queue limits, recovery windows, and progress-stage policy; `command-broker/deadlines.ts` applies that policy to live commands. The command ledger, deadline, lifecycle, and projection modules define their injected runtime contracts beside their behavior, so those implementation modules do not import their types from the bridge composition root. `command-broker/runtime.ts` wires the four owners while preserving lazy runtime getters. The command admission, restoration, listener, bridge lifecycle, and worker finish modules now also own their injected runtime contracts; the bridge composes those owners with process-local state.

`backend/domains/browser/command-broker/routes.ts`, `bridge-activity-routes.ts`, `bridge-continuation-routes.ts`, `bridge-automation-routes.ts`, `bridge-status-route.ts`, `bridge-session-routes.ts`, `bridge-pairing-routes.ts`, and `bridge-companion-routes.ts` own focused authenticated HTTP behavior. `bridge-http-router.ts` owns preflight handling, request admission order, and route dispatch. The companion route module handles browser-control RPCs, preference acknowledgements, diagnostics, and safe extension updates. `bridge-stop-controls.ts` owns validated session Stop requests and command persistence; `bridge-session-controls.ts` composes Goal, Loop, and compaction actions; `bridge-session-controls-runtime.ts` supplies their lazy live dependencies from the bridge facade. `command-broker/deadlines.ts` owns command deadlines and expiry; `command-broker/lifecycle.ts` owns queued command retirement, stale-command reconciliation, lease checks, and delivery selection; `command-broker/delivery.ts` owns companion placement, cold-launch grace, and delivery-fallback scheduling; `command-broker/projection.ts` owns browser bootstrap text and command wire/source projections; `command-broker/ledger.ts` owns durable command snapshots, leases, revival arbitration, and final receipts. `bridge-repair-feedback.ts` owns browser repair feedback copy, deduplicated hold logs, and progress persistence. `bridge-worker-sweep.ts` owns durable idle-worker checks, worker retirement, and queued revival after a worker stops; `bridge-worker-finish.ts` owns current-final verification, staged worker completion, and its durable publish boundary. `bridge-recovery-policy.ts` owns incident and browser-repair eligibility checks; `bridge-recovery-incident-state.ts` owns repair and incident registries and their lifecycle reset; `bridge-recovery-control.ts` composes those checks with incident scheduling and browser repair decisions; `bridge-pending-repairs.ts` owns repair-authority rechecks and bounded browser handouts; `bridge-silence-monitor.ts` owns inactivity evaluation and retirement of completed silence repairs; `bridge-silence-schedule.ts` owns activity deadlines and resumed-page reactivation; `bridge-silence-tickets.ts` owns post-silence input and Goal ticket filing; `bridge-assistant-recovery.ts` owns exact-turn assistant-error identity and cancellation; `bridge-unclaimed-input-recovery.ts` retries only browser inputs that timed out before authorization. `bridge-attribution-recovery.ts` owns exact candidate identity checks and attribution proof; `bridge-call-attribution.ts` owns call-specific attribution notifications; `bridge-recovery-types.ts` defines shared repair and incident records. `bridge-pickup-recovery.ts` owns durable input/Goal and continuation pickup schedules. `bridge-tab-policy.ts` projects safe idle-tab reuse and closure. `bridge-recovery-observations.ts` handles validated recovery observations. `bridge-companion-clients.ts` owns process-local companion sightings, conversation-holder snapshots, opening custody, extension-build freshness, and pending reveal requests. `bridge.ts` composes these modules through explicit runtime objects.

`command-broker/worker-lease.ts` binds a claimed bootstrap command to its exact worker and active run before the conversation is attached.

`bridge-worker-finish.ts` also joins a claimed wake to its exact post-sleep `turn_start` only while the command lease and worker incarnation remain unchanged.

`backend/domains/browser/bridge-tab-recovery.ts` owns exact-session eligibility for reopening closed tabs, reloading stalled pages, and reopening a sleeping worker's missing page after a wake; repair creation still goes through the shared bridge recovery ledger.

`backend/domains/browser/embedded/chrome-api/` groups the integrated browser's tab, window, and debugger handlers, shared argument validation, and browser-control types. Its index translates extension worker calls into these API handlers; `embedded/host.ts` composes `window-host.ts` for Electron window and view effects with `provider-pages.ts` for provider-page readiness and session restoration. Inactive tabs keep a real painted size so virtualized provider chats still render replies the watcher can read. `embedded/session-setup.ts` owns the Chromium user agent, allowed session permissions, worker preload, and worker-status subscriptions; the host retains the persistent session identity and window lifecycle. `web-model-connect.ts` opens the selected web provider in the background when the app starts so chats do not wait on a manual Connect click.

`backend/preload/integrated-browser-worker.ts` establishes the isolated extension-worker bridge. Its serializable Chrome API shim lives in `backend/preload/integrated-browser/chrome-api-shim.ts`, separate from Electron IPC setup so Electron can execute the shim in the worker's world without module-scope dependencies.

`backend/domains/browser/embedded/tabs/url-query-filter.ts` parses and applies the bounded URL-pattern grammar accepted by the tab query API. Malformed URLs and patterns return no match.

`contracts/sessions/activity-state.ts` resolves projected browser deadlines, recent unfinished session work, and worker finish reports for the UI and bridge.

`bridge-resume-types.ts` owns the public resume-job contract. `bridge-resume-controls.ts` owns the process-local continuation-token index, derived resume-job view, and manual or automatic resume cancellation. `sessions/continuity/continuation.ts` coordinates continuation flows and recovery; `continuation-state.ts` owns durable records, snapshots, and write-before-publish transitions; `continuation-lifecycle-policy.ts` owns handoff eligibility, waiting budgets, expiration, and open-state policy. `replacement-chat-gate.ts` tracks replacement-chat openings until commit or expiry; `continuation-commit.ts` owns the rebind transaction, idempotent projections, and per-token commit lock; `continuation-send-checkpoints.ts` owns source and destination send fences and exact message receipts. Browser-command persistence remains in the bridge command ledger.

`bridge-lifecycle.ts` owns serialized bridge start, stop, shutdown, and lifecycle epochs; `bridge-server-lifecycle.ts` performs the serialized server lifecycle operations behind that boundary.

`bridge-extension-health.ts` owns extension version publication, build announcements, protocol mismatch warnings, and deduplicated update-hold explanations; the bridge supplies request evidence and live presence callbacks.

`bridge-handoff-capture.ts` owns bounded continuation-brief validation, recorder-backed capture, and refusal handling; the bridge supplies durable continuation, delivery, and browser-placement operations.

`backend/domains/browser/bridge-activity-policy.ts` owns browser activity grants, exact provider/API turn projection, and bounded unknown-call holds. `bridge-chat-activity.ts` owns live-turn freshness and the working-chat projections used by recovery and tab reopening. `backend/domains/browser/bridge-goal-recovery.ts` owns exact-turn Goal/Loop reply eligibility, wait-state projection, outbox priority, and failed-turn verification. The silence monitor, schedule, ticket, and assistant recovery modules own their corresponding recovery details; `bridge-automatic-compaction.ts` owns automatic compaction admission and its per-conversation filing lock; `bridge-recovery-control.ts` composes these with incident handling and browser repair decisions.

`bridge-recovery-notices.ts` owns bounded duplicate suppression for page-helper health, silence, refusal, and replacement diagnostics; these notices never grant or change recovery authority.

`bridge-recovery-read-model.ts` projects recovery countdowns from session, outbox, and browser evidence. It has no authority to create, extend, or spend a recovery action.

`command-broker/restore.ts` validates durable browser commands and builds a side-effect-free recovery plan. `command-broker/restoration.ts` settles expired worker revivals, persists the recovery snapshot, and publishes it into live command state. `command-broker/ledger.ts` owns serialized command snapshots, browser leases, revival arbitration, and final receipts.

`backend/domains/workspace/execution/` owns subprocess environment filtering, platform executable lookup, shell-safe command preparation, process-tree termination, and bounded command output. `process-control.ts` validates positive process identifiers, runs bounded Windows tree termination, and falls back to platform signals. `process-environment.ts` owns child environment policy and terminal defaults. `process-launch.ts` owns pipe and PTY creation plus platform signal operations; `process-state.ts` owns process identity and lifecycle state; `output/bounded-buffer.ts` owns capped prefix retention, a lazily grown circular suffix, and omission accounting; `output-bounds.ts` owns UTF-8-safe byte/token budgets and truncation previews; `process-errors.ts` owns the public execution error contract. `process-synchronization.ts` owns versioned process signals and FIFO interaction locking. `exec-command-output.ts` owns model-facing text and structured projections with shared truncation limits; `unified-exec-delivery.ts` owns lock-protected output-page offers and acknowledgements while the process manager retains process and output custody. `unified-exec-output-wait.ts` owns bounded output draining, yield deadlines, post-exit close grace, and timeout racing. `unified-exec-process.ts` and `unified-exec.ts` preserve stable exports while delegating process and delivery responsibilities. `backend/domains/workspace/exec.ts` temporarily re-exports that runtime while existing domain and infrastructure consumers move to the focused modules.

`backend/domains/workspace/workspace-terminal.ts` owns renderer-bound PTYs, project and command-permission checks, output backpressure, and active or retiring shell custody. `workspace-terminal-ipc.ts` serializes renderer ownership changes and waits for terminal disposal before allowing app shutdown.

`backend/domains/workspace/fsops.ts` is the stable workspace file API. `file-ops/limits.ts` owns size limits and shared errors; `text-files.ts` handles encodings, binary detection, and bounded reads or writes; `images.ts` identifies and validates image data; `directory.ts` produces file metadata and bounded listings; and `text-edits.ts` prepares, stages, commits, and rolls back exact-text edits.

`backend/domains/workspace/file-ops/search/` owns search contracts, glob matching, ripgrep execution, bounded filesystem traversal, and backend selection for the find and read tools.

`backend/domains/workspace/execution/apply-patch/` owns patch parsing, path policy, hunk verification, mutation reporting, and rollback behavior. `streaming-parser.ts` incrementally parses patch lines while returning detached snapshots; `seek-sequence.ts` finds context with linear-time prefix matching; `text-file.ts` records each line ending and applies explicit line edits; `file-update.ts` resolves ordered edit chunks against verified file contents.

`backend/domains/workspace/tool-path-resolution.ts` owns approved-root path resolution, per-session project roots, learned workspaces, read-only Skill paths, and command working-directory selection. The exact-identity workspace registry, agent-run bindings, and approved-root project discovery are separated under `backend/domains/workspace/session-context/`; `workspace.ts` remains their stable facade. The tool kernel supplies the exact caller session and multi-agent status while preserving its existing resolver exports.

`backend/domains/workspace/git/` separates Git process control, repository identity, file access, status parsing, branch snapshots, diff reading, and metadata watches. File-system events only invalidate the view so the next Git read remains authoritative.

`backend/domains/workspace/toolchain/` separates Windows Java/Go discovery from Git-root detection; `toolchain.ts` preserves the stable import facade for executor and instruction consumers.

`backend/domains/workspace/execution/command-batch.ts` composes sequential shell commands with invocation-scoped frames, maps private frames to readable streaming labels, and parses only complete ordered command results. `backend/domains/workspace/exec-hints.ts` owns conservative shell and ripgrep normalization, while `exec-recovery-hints.ts` owns failure-specific advice and result-note formatting used directly by the tool gateway.

`exec-command-output.ts` builds one bounded result projection for both the readable response and structured tool data so neither presentation can apply a different output limit.

`backend/infrastructure/tool-gateway/protocol/tool-contracts.ts` owns the internal tool context, result shapes, annotations, and surface registrar contract. `tool-arguments.ts` owns shared bounded Zod schemas; `presentation/file-metadata.ts` owns workspace file metadata text; `registrar.ts` owns handler validation and surface registration. `tools-read.ts` owns filesystem read primitives and glob expansion; `tools-read-tool.ts` owns bounded read registration and result projection; `tools-find.ts` owns bounded file and content search; `tool-admission.ts` owns pre-handler refusal precedence and refusal classification; `tool-result-appendices.ts` assembles bounded background output, unattributed identity notices, and worker inbox messages from their existing owners. `dispatch-result.ts` owns post-handler result processing and preserves identity revalidation, input acknowledgements, appendices, persistence, and timing order. `tool-guard.ts` owns model-safe error text, outcome classification, and tool failure logging; `kernel.ts` owns dispatch admission, evidence lookups, and the stable public API; `agent-liveness.ts` owns worker alive evidence, quiet-worker sleep, recovery, and durable queued-revival admission.

`protocol/instructions.ts` routes requests to the shared tool surfaces. `protocol/guidance/` owns browser, Core, desktop, and user-added instruction text separately. `protocol/guidance/core/` separates workspace context, local capability guidance, and plan/worker instructions.

`backend/infrastructure/local-api/control-api-http.ts` owns bounded JSON body framing, token comparison, and response writing; `control-api.ts` composes the loopback lifecycle and action routes. `control-reads.ts` owns read-route validation, bounded concurrency, and response assembly; `control-read-projections.ts` owns allowlisted field projection, redaction, truncation, and serialization.

`protocol/windows-desktop/` separates Windows caller-bound observation state (`caller-context.ts`), bounded screenshot and tool-result projection (`result.ts`), browser-shortcut refusal and native recovery advice (`failure-guidance.ts`), and the desktop tool registrar (`register.ts`). The platform selector in `tools-desktop.ts` remains the production entry point.

`backend/infrastructure/tool-gateway/protocol/code-mode-runtime.ts` owns bounded QuickJS execution and host-side result validation. `protocol/code-mode-worker.ts` assembles the worker bootstrap from `code-mode-worker/shell-source.ts`, `bridge-source.ts`, `sandbox-source.ts`, and `event-loop-source.ts`, keeping initialization, message authority, exposed sandbox APIs, and promise scheduling in separate owners.

`backend/infrastructure/tool-gateway/protocol/dispatch-identity.ts` resolves exact caller identity and workspace-identity admission; `identity-windows.ts` owns time windows for identity evidence. `identity-notices.ts` owns typed identity refusals, bounded strict-mode refusal episodes, and late-proof recovery notices; the kernel decides when those notices apply.

`backend/domains/providers/` owns model observations and provider-page result routes. `api-chat-protocol.ts` owns bounded API completion reads, provider error redaction, and response validation; `api-chat.ts` composes that protocol with conversation, tool, image, and cancellation state. `browser-chat-thread.ts` owns bounded browser-provider transcript validation and persistence; `browser-chat.ts` composes those operations with provider observations and tool admission. `browser-chat-tools.ts` owns browser chat tool registration, guide context (including the selected interface language), invocation, and bounded result formatting. Provider page waits refresh while the page reports generation progress. Later provider turns keep the selected language and project directory without repeating opening AGENTS.md. `api-attribution.ts` owns the shared provider attribution headers used by API catalog requests. The browser bridge supplies HTTP parsing and host checks while the provider domain validates and records those observations.

`backend/domains/automation/` owns Goal acknowledgement, objective, and opening-message routes. `goal-context.ts` builds bounded conversation references and resume anchors; `goal-model-catalog.ts` owns API model discovery and picker pagination; `goal-reply-format.ts` owns deterministic reply normalization; `goal-controls.ts` owns durable objectives, Goal/Loop switches, and backend selection; `goal-events.ts` owns change subscriptions; `goal-decision.ts` owns the bounded API/browser request protocol and provider labels; `goal-reply-ledger.ts` owns the bounded durable reply ledger, validation, expiry, snapshots, and mutation API; `goal.ts` coordinates Goal/Loop policy and draft lifecycle while re-exporting the existing control API. `agents.ts` composes the shared agent state and stable public API; `agents-read-model.ts` owns read-only swarm projections and exact conversation-to-agent/prime ownership lookups; `agents-identity.ts` owns exact caller identity and family selection; `agents-run-registry.ts` owns active and dormant run lookup, parking, retirement, and bounded history retention; `agents-request-ownership.ts` restores provisional prime ownership from exact request proof and durable session ancestry, with its own generation reset; `agents-capacity.ts` owns per-family and global worker slot accounting; `agents-spawning.ts` validates worker plans, stages topology behind durable acceptance, and requests browser bootstraps; `agents-finishing.ts` plans worker reports, stages durable completion, commits or rolls back finish authority, and handles explicit, browser-observed, and failed finishes; `agents-model-policy.ts` owns worker model/reasoning validation and account-aware defaults; `agents-messaging.ts` coordinates routed delivery and inbox acknowledgements while `agents-messaging/staging.ts` owns bounded worker-message validation, durable send transactions, and rollback; `agents-messaging/prime-message-staging.ts` owns cross-family prime delivery; `agents-revival.ts` owns worker sleep, wake reservations, and wake failure handling; `agents-revival-receipts.ts` owns exact browser wake claims, durable delivery evidence, and acknowledgement recording; `agents-context-recovery.ts` owns exact-turn recovery for workers parked after reaching the context ceiling; `agents-lifecycle.ts` owns worker liveness, silence timing, and prime transfer. The browser bridge supplies request parsing, conversation identity validation, and consistent Goal error responses.

`backend/infrastructure/` adapts operating-system, Electron, network, and tool-protocol capabilities. `backend/persistence/` publishes local files atomically; the app stores local JSON and session records and does not require a database server. The preload layer exposes only explicit operations to the renderer.

`backend/infrastructure/device-control/native/index.ts` is the stable facade for screen observation and ordered desktop actions. `observations.ts` owns UI discovery and combined window state; `screenshots.ts` owns capture, geometry checks, PNG limits, and frame registration. `frame-store.ts` owns screenshot coordinate frames and generation-scoped accessibility references; `operation-lock.ts` owns the shared desktop-operation queue; `window-queries.ts` owns window and installed-app queries; `macos-access.ts` owns permission state and helper prewarming; `types.ts` owns the desktop payload contracts. `transport.ts` owns cross-transport serialization, timeouts, shutdown coordination, and reply generations; `process-helper-transport.ts` owns the stdio helper process lifecycle; `macos-addon-transport.ts` owns the macOS addon worker lifecycle; `errors.ts` owns stable desktop error and action-route types.

`backend/native/macos-desktop-helper/` compiles six Swift units together: `NativeRuntime.swift` owns shared wire and display geometry types, `WindowSystem.swift` proves WindowServer and Accessibility targets, `Interaction.swift` handles UI traversal and input, `ScreenCapture.swift` bounds image capture, `RequestRouter.swift` dispatches helper operations, and `main.swift` owns JSON-lines and C ABI entry points.

`windows-app-identity.ts` provides native Windows window-to-app identity, while `windows-app-catalog.ts` handles installed-app listing and validated executable launch. `windows-apps.ts` keeps the shared import surface stable for the helper bootstrap and request handler.

`helper.ts` keeps the stable Windows helper export. `helper-bootstrap.ts` assembles the PowerShell runtime and compiles `windows-control-interop.ts`, `windows-control-input.ts`, `windows-control-windows.ts`, and `windows-control-capture.ts` into one partial native control type in a single Add-Type call. `helper-accessibility.ts` and `helper-requests.ts` provide the UI Automation and request/action layers around that persistent helper process.

`frontend/` owns presentation and interaction state. It has no direct filesystem, process, credential, or generic main-process authority. Shared requests and responses live in `contracts/` and are checked at process boundaries.

`frontend/features/settings/skill-library/` separates the managed Skills page into view rendering, GitHub update checks, import and confirmation dialogs, shared contracts, and a small composition entry point.

`contracts/browser/integrated-browser-toolbar.ts` defines the window-to-renderer toolbar state and action contract. `frontend/features/browser/toolbar/` owns tab rendering, navigation controls, and the HTML entry point for the integrated browser window.

`frontend/features/chat/markdown-renderer.ts` owns message markdown, captured markup sanitization, citations, read-only prompt cards, and math rendering. `chat-event-renderer.ts` owns recorded event rows, tool output, image previews, reactions, and answer export actions. `image-storage-control.ts` owns the explicit cleanup dialog and its persistent in-flight operation state. `sidebar/order-preferences.ts` owns bounded per-scope chat order and off-page order retention; `sidebar/order-interactions.ts` owns pointer and keyboard movement, click suppression, and stale drag rejection; `sidebar/completion-state.ts` owns device-local read receipts for completed chats. `chat-detail-renderer.ts` composes the selected transcript, reuses timeline rows, and projects its footer status. `chat-workspace-panels.ts` composes the Files, Review, sub-agent, and terminal views in the shared workspace docks. `timeline-presentation.ts` owns compaction grouping, reusable timeline rows, and round disclosures for the main chat and worker panels. `chat-timeline-history.ts` owns detail reads, event delta merging, turn-trace lookup, history paging, and bounded page retention; `chat-timeline-agent-filter.ts` owns agent-filter rendering and event visibility. `chat-reader-state.ts` owns sent-message anchoring, reader position, tail geometry, and jump-to-latest state. `chat-reader-scroll.ts` owns reader gesture intent, send-hold release, history paging signals, scroll observers, and resize correction. `chat-navigation.ts` owns view switching, session selection, and draft-preserving new-chat navigation; `chat-composer-delivery.ts` owns input admission, Stop/Cancel selection, and renderer-side outbox projection; `chat-composer-input-events.ts` owns composer edit, Enter, plan, settings, and submit event bindings. `chat.ts` supplies session generation, draft state, timeline resets, and delivery inputs through typed runtimes.

`chat-composer-composition.ts` assembles the input queue, delivery, plan, draft, session, and automation controllers. `chat-runtime-composition.ts` connects that composer group to timeline, progress, session navigation, project controls, and settings; `chat.ts` keeps the renderer entry points and shared session state.

`chat-runtime-bindings.ts` composes fixed actions with typed live state accessors for chat feature runtimes. `chat-session-change-scheduler.ts` owns debounced session-list reloads and retains changes that arrive during an active reload. `chat-session-removal.ts` owns removal from the visible session list and invalidates selected-session detail and handoff loads. `chat-orchestrator.ts` remains the owner of mutable session state and renderer composition.

`backend/domains/workspace/execution/apply-patch/` keeps the public patch entry point in `index.ts`; `file-operations.ts` applies add, update, delete, and move hunks while recording rollback evidence, and `types.ts` defines the affected-path and committed-delta contracts.

`chat-initialization.ts` coordinates renderer startup. `chat-initialization-controllers.ts` creates chat state controllers, `chat-initialization-workspace.ts` mounts the browser-independent workspace panels and composer tools, and `chat-initialization-events.ts` binds DOM and app events.

`frontend/features/chat/sidebar/pins.ts` owns the persisted pinned-chat set and keeps pinned and unpinned rows in stable relative order. Its scope helper separates manual ordering for pinned rows within each chat list.

`frontend/features/chat/tool-results/presentation.ts` projects readable text and structured tool output for recorded events while omitting binary image payloads from text views. `chat-event-renderer.ts` supplies the serialized result, truncation state, and persisted image availability.

`frontend/features/chat/chat-automation-controls.ts` owns Goal and Loop mode changes, objective persistence, and generated opening-message admission. The `chat.ts` runtime supplies the authoritative selection, objective-generation, and outbox state.

`frontend/features/chat/chat-session-controls.ts` owns selected-session control reads and their generation fence, then projects Goal/Loop, compaction, and delivery availability. The chat coordinator supplies session state and repaint actions.

`frontend/features/chat/chat-draft-state.ts` owns text drafts, new-chat task drafts, and composer generation tokens that reject stale imports. The chat coordinator supplies the selected identity, skill picker, and task presentation callbacks.

`frontend/features/chat/chat-sidebar-events.ts` binds search, chat selection, view switching, and agent-filter events to the chat coordinator's current session state.

`frontend/features/chat/chat-search-navigation.ts` owns search-result location, history paging around an older match, and timeline scrolling/highlighting; the chat coordinator supplies session-generation and history state through an explicit runtime.

`frontend/features/chat/chat-agent-events.ts` binds worker reset and clear actions to the main-process outcomes and projects the returned swarm snapshot through the chat coordinator.

`frontend/features/chat/chat-task-controls.ts` owns composer-side Goal/Loop presentation, objective-editor state, finish timing labels, and plan affordances; `chat-task-plan.ts` owns plan generation, editable stages, and queue admission.

`frontend/features/chat/chat-composer-attachments.ts` owns attachment draft storage, preview rendering, removal, file-picker input, and paste/drop admission; `chat.ts` supplies generation-checked draft ownership and current delivery controls.

`frontend/features/chat/chat-session-navigation-composition.ts` assembles session row and catalog runtimes from the chat state, UI helpers, and session actions. `chat-runtime-composition.ts` composes that navigation owner with the remaining chat feature controllers.

`frontend/features/chat/background-process-panel.ts` owns process polling, per-session process state, stop actions, elapsed-time updates, and focus restoration for the chat dock. `chat-project-controls.ts` owns project grouping, color/removal menu actions, and selected-project resolution; `chat-session-list.ts` owns catalog paging, active-state projection, and activity-expiry scheduling; `chat-session-list-renderer.ts` owns chat and worker grouping, diagnostics, hover and focus retention, and repaint coordination; `chat-project-sidebar.ts` owns project ordering, project-group rendering, menus, and task pagination. `chat-session-row.ts` owns row badges and menus; `chat-session-rename.ts` owns inline title editing; `chat-session-tooltip.ts` owns tooltip lifecycle and placement; `chat-session-actions.ts` owns access changes and chat removal. `chat-main-actions.ts` owns composer delivery, finish-goal, compaction, project creation, handoff-copy, and browser-unpair event binding. `chat-settings.ts` owns the settings projection; `chat-goal-settings-view.ts` paints Goal-provider state and `chat-goal-settings-events.ts` binds prompt and credential controls; `chat-settings-patch.ts` reads those controls into the complete validated save snapshot; `chat-goal-model-picker.ts` owns model catalogue paging, query state, reasoning options, and selection; `chat-provider-picker.ts` owns the selected browser/API model presentation. `chat-task-plan.ts` owns task-plan drafts, planning requests, editable stages, and queue admission. `chat-progress.ts` composes progress state, turn presentation, and typed runtime contracts from `chat-progress-status.ts`, `chat-turn-progress.ts`, and `chat-progress-types.ts`. `chat-recovery-view.ts` owns handoff loading and presentation plus dismissible recovery notices. `chat-input-queue.ts` owns opening admission, retries, queue reconciliation, and pending composer-input lookup; `chat-input-rows.ts` owns delivery status rows and their local retry/cancel actions. `chat-delivery-controls.ts` owns delivery-mode labels, visibility, and send/stop button state. `queued-task-list.ts` filters and reconciles queued follow-ups for the active session; `queued-task-card.ts` renders task actions, editing, cancellation, reordering, and paused-helper retry rows. `chat-timeline-history.ts` owns open-turn identification. `chat.ts` supplies shared session and UI state through explicit runtimes.

`frontend/features/agents/swarm-view.ts` owns the worker and prime status list presentation. The chat coordinator retains the live swarm snapshot and passes only its state-line and session-list repaint actions.

`frontend/features/agents/reasoning-selector.ts` projects Goal model reasoning choices and updates the native selector without rebuilding it during unrelated status changes.

`frontend/features/settings/permissions.ts` owns capability-group controls, command allowlist editing, access profiles, host-specific permission guidance, and keyboard-accessible Setup and Composer access-choice controls. `settings-persistence.ts` captures requested snapshots, serializes settings writes, and restores rejected controls. `frontend/main.ts` supplies current app state and applies committed settings through explicit callbacks while retaining the original access-control initialization order.

`frontend/features/activity/activity-feed.ts` owns bounded log rows, problem badges, scroll pinning, and worker filtering. `activity-log-hydration.ts` reconciles initial log history with buffered and live events; `frontend/main.ts` supplies the snapshot and event subscription in the existing startup order.

`frontend/features/settings/skill-composer/` separates slash-command parsing, composer contracts, selected-skill chips, result rendering, labels, and draft orchestration.

`frontend/features/settings/provider-status-view.ts` projects browser companion health, provider presence, and the workspace status popover from read-only state supplied by `frontend/main.ts`. `frontend/application/folder-drop-actions.ts` owns folder drop listeners and applies imported roots through the current app state.

`frontend/features/settings/update-status-view.ts` derives the version and companion status sentence, updates the header and Activity projections, and announces the first settled result once per window. The update service remains the source of version and download facts.

`frontend/features/setup/setup-wizard.ts` owns Setup step navigation, progress, integrated-browser provider setup, and the Ready checklist. It receives current state, permission projections, folder selection, and app-shell navigation through explicit callbacks.

`frontend/features/workspace/approved-roots.ts` owns approved-folder row rendering and the rename draft, focus, selection, and commit lifecycle. The app shell supplies authoritative root state, IPC access, and state application.

`frontend/features/workspace/sidebar-layout/` owns the sidebar width and collapsed state. `controller.ts` handles pointer, keyboard, shortcut, and accessibility updates; `preferences.ts` persists width and collapse preferences with storage failure handling.

`frontend/features/workspace/docks/` separates dock state and view registration in `controller.ts`, tab rendering and focus restoration in `tab-strip.ts`, bottom-panel resizing in `bottom-resizer.ts`, localized icon buttons in `elements.ts`, and shared dock contracts in `types.ts`.

`frontend/features/workspace/file-panel.ts` coordinates project file operations and viewer lifetimes. `file-panel-action-state.ts` owns selection validation and action availability; `file-panel-review.ts` owns historical review navigation and `file-panel-git-controller.ts` coordinates Git state and operations. `file-panel-actions.ts` owns generation-fenced create, rename, delete, and reveal operations; `file-panel-tree.ts` owns accessible tree rendering and keyboard navigation; `file-panel-git-list.ts` owns grouped Git change rows and their status statistics; `file-panel-branch-selector.ts` owns branch search, keyboard selection, and menu lifecycle; `file-panel-watch.ts` owns bounded directory subscriptions, change reconciliation, and stale-generation rejection; `file-panel-editor.ts` owns edit drafts, optimistic saves, and editor lifecycle; `editors/code-editor.ts` owns editable and read-only source views; `editors/diff-viewer.ts` owns unified change presentation; `editors/theme.ts` owns shared CodeMirror appearance and syntax colors; `editors/types.ts` defines their lifecycle contracts. `file-panel-format.ts` owns file-size and Git labels; `file-panel-ui.ts` owns safe Markdown previews and file-entry dialogs; `file-preview-content.ts` selects image, PDF, binary, Markdown, and code surfaces; `file-preview-resize.ts` owns pointer and keyboard resizing. `frontend/shared/storage-namespace.ts` migrates prior renderer preference keys to the `neuraflok.*` namespace before language initialization. Skill discovery uses `.neuraflok` paths and reads earlier user Skill folders as compatibility data.

`frontend/styles/` separates core renderer rules into ordered modules for the base theme, shell, permissions and status, setup, chat, automation, workspace docks, setup completion, and edit previews. The stable `frontend/styles/permissions-and-status.css` entry imports five ordered system modules for buttons and notices, permissions, folders, connection health, and the activity feed. `frontend/styles/chat/` splits chat shell and composer, session list, timeline, tool activity, compaction, and agent/status rules while `frontend/styles.css` preserves their original cascade order. NEURAFLOK's product skin remains in the `frontend/neuraflok.css` entry and imports six ordered modules from `frontend/styles/neuraflok/` for theme, providers, activity, settings, the app shell, and composer controls. Source verification resolves both entries and their nested imports before checking selectors.

`frontend/features/workspace/terminal/` owns terminal panel composition, tab presentation, session input and output, event handling, and theme updates.

`contracts/browser/control-policy.ts` owns the browser-tool access catalog and transfer limits. `backend/domains/browser/control/` separates connected-client presence, pending-request settlement, and broker coordination for claims, permission rechecks, results, and timeouts; `bridge-companion-routes.ts` owns the authenticated HTTP boundary.

`backend/domains/browser/command-broker/state.ts` owns the replaceable command and receipt queues, retirement journal, in-flight write and redemption maps, and return-wait set. `bridge.ts` composes that state with the command and route modules.

`backend/domains/browser/bridge-runtime-state.ts` owns the live HTTP server and port, wake channel, recovery status, lifecycle controller, silence timer, watch floors, placement target, and observation counter. Lifecycle, recovery, and route adapters read and update this shared state through the bridge composition module.

The canonical extension package lives in `browser-extension/`, with its manifest at `browser-extension/manifest.json`. `browser-extension/src/background/service-worker.js` starts the companion and composes connectivity, browser-control, and provider domains. `connectivity/bridge-client.js` owns persisted pairing, discovery, and authenticated HTTP requests; `connectivity/wake-channel.js` owns the wake WebSocket lifecycle and reconnect timer. `browser/active-tabs/owner.js` manages provider-page rendering leases, `policy.js` checks the shared provider catalog, and `persistence.js` restores and retires stored leases. `browser/control/controller.js` owns tab leases, permission checks, and receipts; `control/lifecycle-events.js` owns debugger event routing and detach cleanup; `page-runtime.js` owns bounded frame, page, screenshot, and DOM-only inspection; `control/input/actions.js` dispatches approved input; `coordinates.js` validates screenshots and translates nested-frame points; `keyboard.js` normalizes key names and modifiers. `diagnostics.js` owns bounded console/network event capture, reads, and sensitive-header redaction. Extension storage writes NEURAFLOK-scoped keys and migrates previous keys before retiring them. Provider pages receive isolated DOM adapters and message controllers; the extension token and local tools stay in the background worker. Popup presentation and localization live in `browser-extension/src/popup/`.

`frontend/features/chat/chat-goal-progress.ts` owns Goal and Loop lifecycle copy, retry timing, recovery-wait presentation, and the closed-chat action. `chat.ts` supplies current selection and delivery state through typed runtimes.

`backend/domains/browser/command-broker/routes.ts` preserves authenticated dispatch order and composes `pending-revivals-route.ts`, `redeem-route.ts`, `command-step-route.ts`, and `command-ack-route.ts`; each route owner validates and handles one command lifecycle operation.

`backend/domains/sessions/history/recorder-turn-recovery.ts` owns turn-recovery checks and their durable writes; `recorder-call-admission.ts` owns request and session attribution, serialized tool-call admission, and pending-write tracking; `session-summary-writer.ts` owns durable summary/checkpoint writes, sync-before-rename, validated backup rotation, and temporary-file cleanup; `recorder.ts` keeps the stable public recorder API.

`backend/infrastructure/device-control/native/actions.ts` coordinates native action execution through `action-validation.ts`, `action-mapping.ts`, `action-verification.ts`, and `action-local-operations.ts`, keeping input checks, native payload mapping, locked postcondition checks, and clipboard handling in separate owners.

## Provider and tool flow

The providers domain owns API endpoint selection, credential lookup, browser and API execution, model catalogs, and usage. `Config.providers.api` is the sole persisted owner of the shared API endpoint; `Config.providerTools.instructions` owns user guidance sent with local tool calls; Goal keeps only its automation model and reasoning choices. Config loading migrates the former `goal.provider` field before validation so upgrades retain custom endpoints. Browser provider IDs stay distinct from durable local session IDs. The browser extension is limited to DeepSeek, Kimi, Qwen, and Z AI and does not access OpenAI websites. OpenAI models use the main-process API executor through the configured OpenAI or compatible endpoint. Browser-provider and API requests invoke local tool handlers in-process after caller and permission checks. Claude Code plugin packages are supported only as Skills sources.

Fresh worker and resume URLs use the namespaced source provider; unnamespaced legacy chats use the selected web provider. API conversations stay out of browser commands, recovery, and browser-only compaction controls.

## Build and packaging

`electron.vite.config.ts` builds the main process, preload scripts, and frontend into `out/`. `electron-builder.yml` packages those outputs with `browser-extension/`, platform helpers, and required third-party notices.

Build scripts import packaging policy from `scripts/packaging/` directly: `target-platforms.mjs` owns OS and CPU normalization, `target-options.mjs` parses command-line targets, and `native-artifacts.mjs` selects platform-specific packages and archive paths.

## Licensing

NEURAFLOK application source is licensed under the MIT License (`SPDX-License-Identifier: MIT`) in `LICENSE`. `NOTICE`, `THIRD-PARTY-NOTICES.txt`, and `docs/licenses/` retain the required terms for bundled frameworks, dependencies, icon assets, and native components.

## Recent module ownership

- `backend/domains/providers/api-chat-thread-store.ts` validates, trims, reads, and serializes local API conversation threads.
- `backend/domains/sessions/input/input-session-receipt-retirement.ts` retires deleted-session delivery receipts through the existing durable commit path.
- `backend/domains/sessions/input/input-startup-recovery.ts` reconciles durable input entries during startup, including opening repair, origin restoration, and stale decision cleanup.
- `backend/domains/workspace/execution/unified-exec-stdin.ts` owns serialized interactive input, output polling, and replay of completed process output.
- `frontend/features/chat/chat-input-notice-dismissals.ts` stores bounded dismissed-notice IDs and refreshes the queue after dismissal.
- `frontend/features/settings/general-preferences-view.ts` renders general preferences while the application entry point supplies state in its existing apply order.
- `frontend/features/workspace/file-panel-header.ts` renders branch, Git/review title, statistics, and navigation controls for the file panel.
- `frontend/features/settings/command-policy-settings.ts` owns allow/deny policy controls, rule validation, and save events.
- `frontend/features/chat/chat-visibility-lifecycle.ts` owns refresh-on-show and timer cleanup-on-hide for the Chat tab.
- `backend/domains/automation/local-agent-delivery-primitives.ts` owns deterministic delivery IDs and provider routing; `local-agent-delivery-revivals.ts` owns worker wake delivery and receipt handling; `local-agent-delivery-reports.ts` persists revival outcomes and records their messages.
- `frontend/features/activity/activity-log-hydration.ts` reconciles initial activity history with retained and live log events while preserving event order and duplicate counts.
- `browser-extension/src/background/browser/control/lifecycle-events.js` owns debugger event routing and disconnect cleanup for browser-control clients.
- `backend/domains/browser/bridge-stop-controls.ts` validates and persists session Stop commands using the shared runtime contract.
