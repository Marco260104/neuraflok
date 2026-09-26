import { z } from 'zod';
import type {
  ControlApiEvents,
  ControlApiInputs,
  ControlApiLog,
  ControlApiSessionDetail,
  ControlApiSessionList
} from '../../../contracts/control-api.js';
import type { SessionEventKind } from '../../../contracts/session.js';
import type { LogEntry } from '../../../contracts/types.js';
import { swarmState } from '../../domains/automation/agents.js';
import { sessionControlsFor } from '../../domains/browser/bridge.js';
import { getLog, logWarn } from '../settings/logger.js';
import { listInputs } from '../../domains/sessions/input/input.js';
import type { InputEntry } from '../../domains/sessions/input/input.js';
import { readSession, readSessionEvents, readSessionList, sessionListCursorSchema } from '../../domains/sessions/history/read-model.js';
import { projectAgents, projectInput, projectLive, projectLog, projectReadableEvent, projectSession, selectInputs } from './control-read-projections.js';
export { projectAgents, projectEvent, projectInput, projectLive, projectLog, projectReadableEvent, projectSession, selectInputs } from './control-read-projections.js';

/** The read routes of the local control API: sessions, their events, the input outbox, agents and the activity log. Each one asks the owner that already serves the renderer and projects the answer through an allowlist: a field is published only by being named below, so a field an owner grows later (a token, a path, a prompt) stays private until someone decides otherwise here. Free text has known credential shapes redacted and is cut to a fixed size; the stored record is untouched. */

export class RequestError extends Error {
  constructor(readonly status: number, readonly code: string, readonly detail?: string) {
    super(code);
  }
}

const MAX_EVENTS = 100;

/** Event pages and live session state can read a whole journal, however small the page. A burst of them must not be able to hold many journals in memory at once. */
const MAX_HEAVY_READS = 2;
let heavyReads = 0;

async function heavy<T>(work: () => Promise<T>): Promise<T> {
  if (heavyReads >= MAX_HEAVY_READS) throw new RequestError(503, 'busy', 'too many journal reads in flight; retry shortly');
  heavyReads += 1;
  try {
    return await work();
  } finally {
    heavyReads -= 1;
  }
}

// Query section.

const integer = (min: number, max: number) =>
  z.string().regex(/^\d{1,16}$/).transform(Number).pipe(z.number().int().min(min).max(max));

/** Unknown, repeated or malformed parameters are refused rather than ignored. */
function parseQuery<T extends z.ZodRawShape>(params: URLSearchParams, shape: T): z.infer<z.ZodObject<T>> {
  // No prototype, so a parameter named like an Object.prototype member is just an unknown name.
  const raw: Record<string, string> = Object.create(null);
  for (const [key, value] of params) {
    if (Object.hasOwn(raw, key)) throw new RequestError(400, 'invalid_query', 'a parameter was given more than once');
    raw[key] = value;
  }
  const parsed = z.object(shape).strict().safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join('.') : 'query';
    throw new RequestError(400, 'invalid_query', issue?.code === 'unrecognized_keys' ? 'unknown parameter' : where + ' is not valid');
  }
  return parsed.data;
}

function csv<V extends string>(allowed: readonly V[]) {
  return z
    .string()
    .transform((value) => value.split(','))
    .pipe(z.array(z.enum(allowed as [V, ...V[]])).min(1).max(allowed.length));
}

/** Each table is exhaustive by type: a new value cannot appear in an owner without a decision here. */
const EVENT_KINDS: Record<SessionEventKind, true> = {
  session_start: true, user_message: true, assistant_message: true, native_image: true, progress: true,
  page_tool: true, turn_start: true, turn_end: true, chat_error: true, tool_call: true, note: true,
  agent_message: true, handoff: true
};
/** `decision` rows are the planner's internal work and are never listed. */
const INPUT_STATES: Record<Exclude<InputEntry['state'], 'decision'>, true> = {
  queued: true, browser: true, tool: true, sent: true, cancelled: true, failed: true
};
const LOG_LEVELS: Record<LogEntry['level'], true> = { info: true, warn: true, error: true };

const keysOf = <K extends string>(table: Record<K, true>) => Object.keys(table) as K[];

// Sessions section.

const CURSOR = /^(\d{1,16})\.([0-9a-z-]{8,64})$/;

function decodeCursor(value: string) {
  const match = CURSOR.exec(value);
  const parsed = match ? sessionListCursorSchema.safeParse({ updatedAt: Number(match[1]), id: match[2] }) : null;
  if (!parsed?.success) throw new RequestError(400, 'invalid_query', 'cursor is not valid');
  return parsed.data;
}

async function sessionList(params: URLSearchParams): Promise<ControlApiSessionList> {
  const query = parseQuery(params, { limit: integer(1, 50).optional(), cursor: z.string().min(1).max(100).optional() });
  const page = await readSessionList({ cursor: query.cursor ? decodeCursor(query.cursor) : undefined, limit: query.limit ?? 20 });
  const pressure = new Map(page.pressure.map((entry) => [entry.id, entry]));
  return {
    sessions: page.sessions.map((summary) => {
      const { level, advisory, limit } = pressure.get(summary.id)!;
      return { ...projectSession(summary), pressure: { level, advisory, limit } };
    }),
    total: page.total,
    nextCursor: page.nextCursor ? page.nextCursor.updatedAt + '.' + page.nextCursor.id : null,
    activeId: page.activeId
  };
}

async function sessionDetail(id: string, params: URLSearchParams): Promise<ControlApiSessionDetail> {
  const query = parseQuery(params, { live: z.literal('1').optional() });
  return heavy(async () => {
    const summary = await readSession(id);
    if (!summary) throw new RequestError(404, 'session_not_found');
    const session = projectSession(summary);
    if (!query.live) return { session };
    // The live state comes from the same code the app runs when a chat is opened. It can load the session into memory and seal a torn last line of its journal, so it is asked for rather than attached to every read. A chat with nothing to describe, or one whose state cannot be read right now, leaves `live` null; the session itself was already read.
    try {
      const controls = await sessionControlsFor(id);
      // A compaction can move the session to a new chat while its live state is being worked out, and then the session describes one chat and part of the state another. The chat has to be the one the session was read with, both before and after.
      const after = await readSession(id);
      if (controls.conversationId !== summary.conversationId || after?.conversationId !== summary.conversationId) {
        return { session, live: null };
      }
      return { session, live: projectLive(controls) };
    } catch (error) {
      if (error instanceof Error && !/^(session_not_recorded|conversation_superseded|conversation_changed)$/.test(error.message)) {
        logWarn('control API: live state unavailable for a session: ' + error.message);
      }
      return { session, live: null };
    }
  });
}

// Events section.

async function sessionEvents(id: string, params: URLSearchParams): Promise<ControlApiEvents> {
  const query = parseQuery(params, {
    from: integer(0, 10_000_000).optional(),
    before: integer(1, 10_000_000).optional(),
    after: integer(0, 10_000_000).optional(),
    limit: integer(1, MAX_EVENTS).optional(),
    kinds: csv(keysOf(EVENT_KINDS)).optional()
  });
  // `from` follows live revisions; `before` and `after` page through history. They are two cursors over different orders, and mixing them would silently ignore one.
  if (query.from !== undefined && (query.before !== undefined || query.after !== undefined)) {
    throw new RequestError(400, 'invalid_query', 'from cannot be combined with before or after');
  }
  return heavy(async () => {
    const page = await readSessionEvents(id, { ...query, limit: query.limit ?? 50 });
    if (!page) throw new RequestError(404, 'session_not_found');
    return { events: page.events.map(projectReadableEvent), total: page.total, nextFrom: page.nextFrom };
  });
}

// Inputs section.

async function inputs(params: URLSearchParams): Promise<ControlApiInputs> {
  const query = parseQuery(params, { state: csv(keysOf(INPUT_STATES)).optional(), limit: integer(1, 500).optional() });
  const selected = selectInputs(await listInputs(), { state: query.state, limit: query.limit ?? 100 });
  return { inputs: selected.rows.map(projectInput), total: selected.total };
}

// Agents section.

// Log section.

function activityLog(params: URLSearchParams): ControlApiLog {
  const query = parseQuery(params, {
    limit: integer(1, 500).optional(),
    since: integer(0, Number.MAX_SAFE_INTEGER).optional(),
    level: csv(keysOf(LOG_LEVELS)).optional()
  });
  const levels: readonly string[] | undefined = query.level;
  const ring = getLog();
  // Inclusive: lines share a millisecond, so a caller that passes the newest time it has seen gets that line again, and drops it, rather than losing one written just after.
  const matching = ring.filter((entry) => (query.since === undefined || entry.time >= query.since) && (!levels || levels.includes(entry.level)));
  return { entries: projectLog(matching.slice(-(query.limit ?? 200))), ringSize: ring.length };
}

// Routes section.

const SESSION_ROUTE = /^\/v1\/sessions\/([0-9a-z-]{8,64})(\/events)?$/;

/** Undefined when the path is not one of these routes. Ids are generated lowercase, and a case-insensitive match would let a differently cased spelling reach the store on filesystems that ignore case, so only the exact spelling is a route. */
export async function serveRead(route: string, params: URLSearchParams): Promise<unknown | undefined> {
  if (route === '/v1/sessions') return sessionList(params);
  if (route === '/v1/inputs') return inputs(params);
  if (route === '/v1/agents') {
    parseQuery(params, {});
    return projectAgents(swarmState());
  }
  if (route === '/v1/log') return activityLog(params);
  const session = SESSION_ROUTE.exec(route);
  if (session) return session[2] ? sessionEvents(session[1]!, params) : sessionDetail(session[1]!, params);
  return undefined;
}
