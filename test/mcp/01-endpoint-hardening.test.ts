import {
  SURFACE_LIST,
  core,
  desktop,
  friendlyError,
  http,
  lastToolCallAt,
  path,
  rawGet,
  rawPost,
  toolNames,
  withCaps,
} from './context.js';
import { mcpHarness } from './context.js';
import {
  describe,
  expect,
  it,
} from 'vitest';

// ------------------------------------------------------------------- tests

describe('endpoint hardening', () => {
  it('does not expose native paths from uncommon filesystem errors', () => {
    const error = Object.assign(new Error(`ELOOP: too many symbolic links, realpath '${mcpHarness.approved}\\loop\\file.txt'`), {
      code: 'ELOOP',
      path: path.join(mcpHarness.approved, 'loop', 'file.txt'),
      syscall: 'realpath'
    });
    const text = friendlyError(error);
    expect(text).toBe('Filesystem error (ELOOP)');
    expect(text).not.toContain(mcpHarness.approved);
  });

  it('binds to loopback only, and gives every surface its own path', () => {
    for (const surface of SURFACE_LIST) {
      const url = mcpHarness.endpoint.urls[surface.id];
      expect(url.startsWith('http://127.0.0.1:'), surface.id).toBe(true);
      expect(new URL(url).pathname.startsWith(`/mcp/${surface.id}/`), surface.id).toBe(true);
    }
    expect(mcpHarness.endpoint.urls.core).not.toBe(mcpHarness.endpoint.urls.desktop);
  });

  it('gives each surface its own token, so handing out one does not hand out the other', async () => {
    const coreUrl = new URL(mcpHarness.endpoint.urls.core);
    const desktopUrl = new URL(mcpHarness.endpoint.urls.desktop);
    const coreToken = coreUrl.pathname.split('/').pop() ?? '';
    const desktopToken = desktopUrl.pathname.split('/').pop() ?? '';
    expect(coreToken).not.toBe(desktopToken);

    // A Core token must not authorize requests to the Desktop surface.
    const swapped = new URL(mcpHarness.endpoint.urls.desktop);
    swapped.pathname = `/mcp/desktop/${coreToken}`;
    const res = await rawPost(swapped.toString(), '{}');
    expect(res.status).toBe(404);
  });

  it('serves nothing at a path without the secret token', async () => {
    const wrong = new URL(mcpHarness.endpoint.urls.core);
    for (const p of ['/', '/mcp', '/mcp/', '/mcp/core', '/mcp/core/', '/mcp/core/wrong-token', '/mcp/desktop/wrong']) {
      wrong.pathname = p;
      const res = await rawPost(wrong.toString(), '{}');
      expect(res.status, p).toBe(404);
    }
  });

  it('rejects a token of the right length but the wrong value', async () => {
    const url = new URL(mcpHarness.endpoint.urls.core);
    const token = url.pathname.split('/').pop() ?? '';
    // Same length, so the comparison itself has to reject it.
    url.pathname = `/mcp/core/${'A'.repeat(token.length)}`;
    const res = await rawPost(url.toString(), '{}');
    expect(res.status).toBe(404);
  });

  it('rejects a non-loopback Host header on every surface', async () => {
    for (const surface of SURFACE_LIST) {
      const res = await rawPost(
        mcpHarness.endpoint.urls[surface.id],
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        { host: 'files.example.com' }
      );
      expect(res.status, surface.id).toBeGreaterThanOrEqual(400);
      expect(res.status, surface.id).toBeLessThan(500);
    }
  });

  it('rejects a cross-site Origin header on every surface', async () => {
    for (const surface of SURFACE_LIST) {
      const res = await rawPost(
        mcpHarness.endpoint.urls[surface.id],
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        { origin: 'https://evil.example.com' }
      );
      expect(res.status, surface.id).toBeGreaterThanOrEqual(400);
      expect(res.status, surface.id).toBeLessThan(500);
    }
  });

  it('never answers with a non-JSON body, whatever is asked for', async () => {
    // Unknown paths return the same structured error shape as other endpoint failures.
    const url = new URL(mcpHarness.endpoint.urls.core);
    for (const p of ['/', '/mcp', '/mcp/core', '/favicon.ico', '/.well-known/unsupported']) {
      url.pathname = p;
      const res = await rawGet(url.toString());
      expect(res.status, p).toBe(404);
      expect(res.headers['content-type'], p).toContain('application/json');
      expect(() => JSON.parse(res.text), p).not.toThrow();
    }
  });

  it('records tool dispatch only after a tool is invoked', async () => {
    expect(lastToolCallAt()).toBeNull();

    await core('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' }
    });
    await core('tools/list');
    expect(lastToolCallAt()).toBeNull();

    await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } });
    expect(lastToolCallAt()).not.toBeNull();
  });

  it('tracks tool dispatch independently on each surface', async () => {
    expect(lastToolCallAt('core')).toBeNull();
    expect(lastToolCallAt('desktop')).toBeNull();
    await core('tools/list');
    expect(lastToolCallAt('core')).toBeNull();

    await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/src/app.ts'] } });
    expect(lastToolCallAt('core')).not.toBeNull();
    expect(lastToolCallAt('desktop')).toBeNull();

    mcpHarness.ctx.caps = withCaps({ screen: true });
    await desktop('tools/list');
    expect(lastToolCallAt('desktop')).toBeNull();
  });

  it('records a denied tool invocation', async () => {
    await core('tools/list');
    mcpHarness.ctx.caps = withCaps({ read: false, browse: false, metadata: false });
    const res = await core('tools/call', { name: 'read', arguments: { paths: ['/workspace/notes.txt'] } });
    expect(JSON.stringify(res.body)).toContain('TOOL_DISABLED');
    expect(lastToolCallAt()).not.toBeNull();
  });

  it('rejects a body that declares an oversized content-length', async () => {
    const url = new URL(mcpHarness.endpoint.urls.core);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(64 * 1024 * 1024)
          }
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
          req.destroy();
        }
      );
      req.on('error', reject);
      // Deliberately never finished: the guard must answer on the headers alone.
      req.write('{"jsonrpc":"2.0"');
    });
    expect(status).toBe(413);
  });

  it('enforces the same body cap on chunked requests with no content-length', async () => {
    const url = new URL(mcpHarness.endpoint.urls.core);
    const status = await new Promise<number>((resolve, reject) => {
      let answered = false;
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: { 'content-type': 'application/json' }
        },
        (res) => {
          answered = true;
          resolve(res.statusCode ?? 0);
          res.resume();
        }
      );
      req.on('error', (error) => {
        if (!answered) reject(error);
      });
      req.write('{"jsonrpc":"2.0","id":1,"method":"tools/list","padding":"');
      const chunk = Buffer.alloc(64 * 1024, 0x78);
      for (let index = 0; index < 129; index++) req.write(chunk);
      req.end('"}');
    });
    expect(status).toBe(413);
    expect(toolNames(await core('tools/list'))).toContain('read');
  });

  it('survives a malformed body and keeps serving', async () => {
    const res = await rawPost(mcpHarness.endpoint.urls.core, '{ this is not json');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(toolNames(await core('tools/list'))).toContain('read');
  });

  it('survives a JSON body that is not a JSON-RPC message', async () => {
    const res = await rawPost(mcpHarness.endpoint.urls.core, JSON.stringify({ hello: 'world' }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(toolNames(await core('tools/list'))).toContain('read');
  });
});
