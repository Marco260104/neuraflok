/** The session recorder, its store, and everything that reads back out of it. Real files in a real temp folder, because the properties that matter here are durability properties: a torn line must cost one event and not a session, a reopened conversation must continue its own log, and a handoff must survive the pruner. None of that is observable against an in-memory fake. */

import './session/context.js';
import './session/store-attribution-and-reads.test.js';
import './session/store-canonical-messages.test.js';
import './session/store-session-projections.test.js';
import './session/store-restart-and-repair.test.js';
import './session/store-assets-and-compaction.test.js';
import './session/handoff-storage.test.js';
import './session/canonical-recorder.test.js';
import './session/session-naming.test.js';
import './session/tool-summaries.test.js';
import './session/line-deltas.test.js';
import './session/token-estimation.test.js';
import './session/progress-folding.test.js';
import './session/uninitialized-store.test.js';
import './session/activity-windows.test.js';
import './session/session-acceptance.test.js';
