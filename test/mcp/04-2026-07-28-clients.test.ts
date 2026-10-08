import {
  modern,
  textOf,
  toolNames,
} from './context.js';
import {
  describe,
  expect,
  it,
} from 'vitest';

describe('2026-07-28 clients', () => {
  it.each(['server/discover', 'tools/list'])('returns JSON for modern %s', async method => {
    const reply = await modern(method);
    expect(reply.status).toBe(200);
    expect(reply.body.error).toBeUndefined();
    expect(reply.headers['content-type']).toContain('application/json');
  });
  it('lists tools when the request carries the _meta envelope', async () => {
    const reply = await modern('tools/list');
    expect(reply.status).toBe(200);
    expect(toolNames(reply)).toContain('read');
  });

  it('calls a tool', async () => {
    const reply = await modern('tools/call', {
      name: 'read',
      arguments: { paths: ['/workspace/src/app.ts'] }
    });
    expect(reply.status).toBe(200);
    expect(textOf(reply)).toContain('export const name = "app";');
  });

  it('rejects a modern request whose headers disagree with its body', async () => {
    const reply = await modern('tools/call', { name: 'read', arguments: { paths: ['/workspace/notes.txt'] } }, {
      'Mcp-Name': 'apply_patch'
    });
    expect(reply.status).toBe(400);
  });
});
