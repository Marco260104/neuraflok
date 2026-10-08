import {
  core,
  createSession,
  failed,
  modern,
  observeRequestCorrelation,
  readSessionPlan,
  rebindSession,
  textOf,
  toolList,
} from './context.js';
import { mcpHarness } from './context.js';
import {
  describe,
  expect,
  it,
} from 'vitest';

describe('agent-maintained plans over MCP', () => {
  it('uses exact request proof without workers, refuses foreign targets and retired chats', async () => {
    mcpHarness.ctx.sessionTools = true;
    mcpHarness.ctx.agentTools = false;
    const source = await createSession({ conversationId: 'plan-http-source' });
    const other = await createSession({ conversationId: 'plan-http-other' });
    const args = { plan: [{ step: 'Implement the fix', details: 'Validate session ownership.', status: 'in_progress' }] };
    const send = (requestId: string | null, arguments_: Record<string, unknown> = args) => modern('tools/call',
      { name: 'update_plan', arguments: arguments_ }, requestId ? { 'x-request-id': `${requestId}/att1` } : {});
    expect(failed(await send(null))).toBe(true);
    expect(await readSessionPlan(source.id)).toBeNull();
    const prove = (requestId: string, conversationId = 'plan-http-source') => observeRequestCorrelation({
      requestId, conversationId, sessionId: source.id, messageId: `msg-${requestId}`, tool: 'update_plan', observedAt: Date.now()
    });
    expect(prove('wfr_plan_owned')).toBe('stored');
    expect(failed(await send('wfr_plan_owned', { ...args, session_id: other.id }))).toBe(true);
    expect(failed(await send('wfr_plan_owned'))).toBe(false);
    expect((await readSessionPlan(source.id))?.plan).toEqual(args.plan);
    expect(await readSessionPlan(other.id)).toBeNull();
    // The desktop view reads the same current document, without a second plan store.
    const { sessionControlsFor } = await import('../../backend/domains/browser/bridge.js');
    expect((await sessionControlsFor(source.id)).plan?.plan).toEqual(args.plan);
    expect(await rebindSession(source.id, 'plan-http-source', 'plan-http-destination')).toBe(true);
    expect(failed(await send('wfr_plan_owned', { plan: [] }))).toBe(true);
    expect(prove('wfr_plan_destination', 'plan-http-destination')).toBe('stored');
    expect(failed(await send('wfr_plan_destination', { plan: [] }))).toBe(false);
    expect((await readSessionPlan(source.id))?.plan).toEqual([]);
  });

  it('validates session statuses and enforces recording disable after discovery', async () => {
    mcpHarness.ctx.sessionTools = true;
    const declaration = toolList(await core('tools/list')).find(tool => tool.name === 'update_plan');
    expect(declaration?.inputSchema.required).toEqual(['plan']);
    expect(declaration?.inputSchema.additionalProperties).toBe(false);
    expect(failed(await core('tools/call', { name: 'update_plan', arguments: { plan: [
      { step: 'One', status: 'in_progress' }, { step: 'Two', status: 'in_progress' }
    ] } }))).toBe(true);
    mcpHarness.ctx.sessionTools = false;
    const disabled = await core('tools/call', { name: 'update_plan', arguments: { plan: [] } });
    expect(failed(disabled)).toBe(true);
    expect(textOf(disabled)).toContain('Session recording');
  });
});
