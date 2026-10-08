import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import sharp from "sharp";
import { APP_VERSION, BRIDGE_PROTOCOL } from "../../../backend/infrastructure/settings/version.js";
import { webProviderConversationId } from "../../../contracts/web-providers.js";
import { browserControl } from "../../../backend/domains/browser/control/index.js";
import {
  agentInfoForOwnedConversation,
  attachSummary,
  bindConversation,
  bridgePort,
  bridgeState,
  bridgeStatus,
  claimContinuationNow,
  commitContinuation,
  companionDiagnostics,
  createSession,
  DEFAULT_PORTS,
  describe,
  expect,
  EXTENSION_ORIGIN,
  finishAgent,
  getConfig,
  getLog,
  it,
  noteAgentAlive,
  onBridgeChange,
  openContinuationNow,
  pair,
  PRIME_CHAT,
  readEvents,
  recordFinalForTest,
  request,
  requestProviderPageComplete,
  resetBridgeForTests,
  resetProviderPageForTests,
  resetSecretsCacheForTests,
  safeStorage,
  SAMPLE_BRIEF,
  saveConfig,
  sessionStoreModule,
  setChatBlocked,
  spawn,
  startBridge,
  stopBridge,
  suiteConfig,
  unpair,
  vi,
  workerConversationGone,
  writeDurableNow
} from '../test-context.js';

describe('direct browser control over the paired bridge', () => {
  it('recovers request-owned browser tabs only from exact server-side correlation, including a resumed session', async () => {
    browserControl.reset(); await pair();
    const browserId = randomUUID(), conversationId = randomUUID(), foreignChat = randomUUID();
    const session = await createSession({ conversationId });
    const requestId = `wfr_browser_owner_${randomUUID()}`, foreignRequest = `wfr_browser_foreign_${randomUUID()}`;
    for (const [chat, proofId] of [[conversationId, requestId], [foreignChat, foreignRequest]]) {
      const proof = await request('POST', '/correlations', { body: { conversationId: chat, calls: [
        { requestId: proofId, messageId: randomUUID(), tool: 'browser_tabs', order: 0, answered: false }
      ] } });
      expect(proof.body.confirmed).toContain(proofId);
    }
    const resumed = randomUUID();
    expect(await sessionStoreModule.rebindSession(session.id, conversationId, resumed)).toBe(true);
    const poll = { action: 'poll', browserId, name: 'Fixture', enabled: true };
    const hello = await request('POST', '/browser-control', { body: poll });
    const result = browserControl.execute('browser_tabs', { action: 'list' }, `session:${session.id}`, resumed, async () => true);
    try {
      const listed = await request('POST', '/browser-control', { body: poll });
      const claim = { action: 'claim', browserId, id: listed.body.requests[0], epoch: hello.body.epoch };
      expect((await request('POST', '/browser-control', { body: { ...claim, owners: [{ owner: `request:${foreignRequest}`, sessionId: session.id }] } })).status).toBe(400);
      const claimed = await request('POST', '/browser-control', { body: { ...claim,
        owners: [`request:${requestId}`, `request:${foreignRequest}`, 'request:unproved']
      } });
      expect(claimed.status).toBe(200);
      expect(claimed.body.command).toMatchObject({ owner: `session:${session.id}`, conversationId: resumed,
        ownerAliases: [`request:${requestId}`] });
      expect((await request('POST', '/browser-control', { body: { ...claim, action: 'result', result: { value: true } } })).status).toBe(200);
      expect(await result).toEqual({ value: true });
    } finally { browserControl.reset(); await result; }
  });

  it('requires extension authentication and transfers each exact command once', async () => {
    browserControl.reset();
    const browserId = randomUUID();
    const poll = { action:'poll',browserId,name:'Fixture',enabled:true };
    expect((await request('POST','/browser-control',{auth:null,body:poll})).status).toBe(401);
    await pair();
    expect((await request('POST','/browser-control',{origin:'https://example.test',body:poll})).status).toBe(403);
    const hello = await request('POST','/browser-control',{body:poll});expect(hello.status).toBe(200);
    const result = browserControl.execute('browser_snapshot',{tabId:`${browserId}:12`},'session:browser-fixture',null,async()=>true);
    try {
      const list = await request('POST','/browser-control',{body:poll});
      const claim = {action:'claim',browserId,id:list.body.requests[0],epoch:hello.body.epoch};
      const claimed = await request('POST','/browser-control',{body:claim});
      expect(claimed.body.command).toMatchObject({owner:'session:browser-fixture',args:{tabId:12}});
      expect((await request('POST','/browser-control',{body:claim})).status).toBe(409);
      const receipt = {...claim,action:'result',result:{value:{text:'fixture DOM'}}};
      expect((await request('POST','/browser-control',{body:{...receipt,browserId:randomUUID()}})).status).toBe(409);
      expect((await request('POST','/browser-control',{body:receipt})).status).toBe(200);
      expect(await result).toEqual(receipt.result);
      expect((await request('POST','/browser-control',{body:receipt})).status).toBe(409);
    } finally {browserControl.reset();await result;}
  });

  it('projects read-only policy and rechecks permission after handout', async () => {
    browserControl.reset();await pair();
    await saveConfig({...suiteConfig,readOnly:false,capabilities:{...suiteConfig.capabilities,screen:true,control:true}});
    const browserId=randomUUID(),poll={action:'poll',browserId,name:'Fixture',enabled:true};
    const hello=await request('POST','/browser-control',{body:poll});
    const result=browserControl.execute('browser_action',{tabId:`${browserId}:12`,pageId:'p',action:'click'},'session:browser-fixture',null,async()=>!getConfig().readOnly);
    try {
      const list=await request('POST','/browser-control',{body:poll});
      const command={browserId,id:list.body.requests[0],epoch:hello.body.epoch};
      expect((await request('POST','/browser-control',{body:{...command,action:'claim'}})).status).toBe(200);
      await saveConfig({...getConfig(),readOnly:true});
      expect((await request('POST','/browser-control',{body:poll})).body.policy).toEqual({read:true,write:false});
      expect((await request('POST','/browser-control',{body:{...command,action:'check'}})).body.allowed).toBe(false);
    } finally {browserControl.reset();await result;}
  });
});

describe('who is allowed to talk to it', () => {
  it('bounds authenticated companion diagnostics and clears them with the bridge lifecycle', async () => {
    const body = { capturedAt: Date.now(), status: { connected: true, paired: true, appVersion: 'v'.repeat(200) },
      preferences: { overwrite: true, durations: false }, transcript: 'must not be forwarded',
      tab: { tab: 17, page: { text: 'must not be forwarded', requestId: 'r'.repeat(500),
        trace: Array.from({ length: 30 }, () => ({ requestId: 'r', read: true, text: 'must not be forwarded' })) } } };
    expect((await request('POST', '/diagnostics', { auth: null, body })).status).toBe(401);
    await pair();
    const pending = companionDiagnostics();
    expect((await request('POST', '/diagnostics', { body })).status).toBe(200);
    const snapshot = await pending;
    expect(snapshot?.status.appVersion).toHaveLength(32);
    expect(snapshot?.tab?.page?.requestId).toHaveLength(160);
    expect(snapshot?.tab?.page?.trace).toHaveLength(16);
    expect(JSON.stringify(snapshot)).not.toContain('must not be forwarded');
    resetBridgeForTests();
    expect(await companionDiagnostics()).toBeNull();
  });

  it('keeps the extension preferences it stored and hands them and the app language back in /status', async () => {
    await pair();
    const diagnostics = (preferences: { overwrite: boolean; durations: boolean }, stored: boolean) => ({ capturedAt: Date.now(),
      status: { connected: true, paired: true }, preferences, preferencesStored: stored, tab: null });
    // A fresh install reports defaults it never stored: not a choice, so nothing is kept.
    expect((await request('POST', '/diagnostics', { body: diagnostics({ overwrite: true, durations: false }, false) })).status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(getConfig().ui.browserPreferences).toBeUndefined();
    expect((await request('POST', '/diagnostics', { body: diagnostics({ overwrite: false, durations: true }, true) })).status).toBe(200);
    // The save runs after the reply; a busy CI runner can take longer than any fixed pause.
    await vi.waitFor(() => expect(getConfig().ui.browserPreferences).toEqual({ overwrite: false, durations: true }));
    await saveConfig({ ...getConfig(), ui: { ...getConfig().ui, language: 'en' } });
    const status = await request('POST', '/status', { body: { openConversations: [] } });
    expect(status.body).toMatchObject({ language: 'en', browserPreferences: { overwrite: false, durations: true } });
  });

  it('answers unknown rather than incompatible to a /hello without a protocol header (#568)', async () => {
    // A plain curl in a bug report read "compatible": false and pointed everyone the wrong way.
    const plain = await fetch(`${bridgeState.base}/hello`);
    expect((await plain.json()).compatible).toBeNull();
    const extension = await request('GET', '/hello', { auth: null });
    expect(extension.body.compatible).toBe(true);
  });

  it('pushes newly detected incompatible extension versions without granting browser presence', async () => {
    const changed = vi.fn();
    const unsubscribe = onBridgeChange(changed);
    try {
      const options = { auth: null, extensionVersion: '0.0.1', protocol: BRIDGE_PROTOCOL - 1 };
      const hello = await request('GET', '/hello', options);
      expect(hello.body.compatible).toBe(false);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(await bridgeStatus()).toMatchObject({ extensionVersion: '0.0.1', present: false, lastSeenAt: null });
      const rejected = await request('POST', '/pair', options);
      expect(rejected.status).toBe(426);
      expect(changed).toHaveBeenCalledTimes(1);
      await request('GET', '/hello', { ...options, extensionVersion: '0.0.2' });
      expect(changed).toHaveBeenCalledTimes(2);
      expect(await bridgeStatus()).toMatchObject({ extensionVersion: '0.0.2', present: false, paired: false });
    } finally { unsubscribe(); }
  });

  it('binds a loopback port only', () => {
    expect(bridgePort()).toBeGreaterThan(0);
    expect(bridgeState.base.startsWith('http://127.0.0.1:')).toBe(true);
  });

  it('requires an explicitly external authenticated companion for external Setup presence', async () => {
    await pair();
    for (const host of ['integrated', undefined, 'unknown']) {
      await request('GET', '/status', { host });
      expect((await bridgeStatus()).externalExtension).toBeNull();
    }
    await request('GET', '/hello', { host: 'browser', auth: null });
    expect((await bridgeStatus()).externalExtension).toMatchObject({ version: APP_VERSION, present: false, lastSeenAt: null });
    await request('GET', '/status', { host: 'browser', auth: 'wrong-token' });
    expect((await bridgeStatus()).externalExtension?.present).toBe(false);
    await request('GET', '/status', { host: 'browser' });
    expect((await bridgeStatus()).externalExtension).toMatchObject({ version: APP_VERSION, present: true });
    await request('GET', '/status', { host: 'integrated', extensionVersion: '99.0.0' });
    expect((await bridgeStatus()).externalExtension).toMatchObject({ version: APP_VERSION, present: true });
    await unpair();
    expect((await bridgeStatus()).externalExtension?.present).toBe(false);
  });

  it('retains an incompatible external version without granting presence', async () => {
    const changed = vi.fn(); const unsubscribe = onBridgeChange(changed);
    try {
      expect((await request('POST', '/pair', { host: 'browser', extensionVersion: '0.0.1', protocol: 0 })).status).toBe(426);
      // An incompatible peer leaves no lasting proof either.
      expect((await bridgeStatus()).externalExtension).toEqual({ present: false, version: '0.0.1', lastSeenAt: null, proof: null });
      expect(changed).toHaveBeenCalled();
    } finally { unsubscribe(); }
  });

  it('publishes external expiry while the NEURAFLOK companion continues polling', async () => {
    await pair();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const changed = vi.fn(); const unsubscribe = onBridgeChange(changed);
    try {
      await request('GET', '/status', { host: 'browser' });
      await vi.advanceTimersByTimeAsync(30_000);
      await request('GET', '/status', { host: 'integrated' });
      changed.mockClear();
      await vi.advanceTimersByTimeAsync(30_002);
      expect(changed).toHaveBeenCalled();
      expect(await bridgeStatus()).toMatchObject({ present: true, externalExtension: { present: false } });
      await request('GET', '/status', { host: 'browser' });
      expect((await bridgeStatus()).externalExtension?.present).toBe(true);
    } finally { unsubscribe(); vi.useRealTimers(); }
  });

  it('keeps extension installation evidence across a bridge restart', async () => {
    await pair();
    const browser = 'c'.repeat(32);
    await request('GET', '/status', { host: 'integrated' });
    expect(await bridgeStatus()).toMatchObject({ integratedExtension: { present: true }, externalExtension: null });
    await request('POST', '/status', { host: 'browser', browser, body: { openConversations: [] } });
    expect((await bridgeStatus()).externalExtension).toMatchObject({ present: true, proof: { version: APP_VERSION } });
    await stopBridge(); await startBridge();
    bridgeState.base = `http://127.0.0.1:${bridgePort()}`;
    // Presence needs a fresh sighting; installation proof persists.
    expect(await bridgeStatus()).toMatchObject({ integratedExtension: { present: false },
      externalExtension: { present: false, proof: { version: APP_VERSION } } });
  });

  it('counts an idle NEURAFLOK companion as present through its own wake channel only', async () => {
    await pair();
    const connect = async (host: string) => {
      const socket = new WebSocket(bridgeState.base.replace('http:', 'ws:') + `/wake?host=${host}`, { origin: EXTENSION_ORIGIN });
      await once(socket, 'open');
      const authenticated = once(socket, 'message'); socket.send(bridgeState.token!); await authenticated;
      return socket;
    };
    // No request at all: presence comes from the open channel alone.
    const browser = await connect('browser');
    try {
      expect((await bridgeStatus()).integratedExtension).toEqual({ present: false });
      const integrated = await connect('integrated');
      try { expect((await bridgeStatus()).integratedExtension).toEqual({ present: true }); }
      finally { const closed = once(integrated, 'close'); integrated.close(); await closed; }
      await vi.waitFor(async () => expect((await bridgeStatus()).integratedExtension).toEqual({ present: false }));
    } finally { const closed = once(browser, 'close'); browser.close(); await closed; }
  });

  it('requires a fresh external sighting after a bridge restart', async () => {
    await pair(); await request('GET', '/status', { host: 'browser' });
    expect((await bridgeStatus()).externalExtension?.present).toBe(true);
    await stopBridge(); await startBridge();
    bridgeState.base = `http://127.0.0.1:${bridgePort()}`;
    expect((await bridgeStatus()).externalExtension?.present).toBe(false);
  });

  it('accepts provider session evidence only from the app-owned browser profile', async () => {
    await pair();
    expect((await bridgeStatus()).webProviders?.deepseek).toMatchObject({ open: false, signedIn: null, tabId: null, lastSeenAt: null });
    const priorLogs = new Set(getLog());
    await request('POST', '/status', { host: 'browser', browser: 'e'.repeat(32),
      body: { openConversations: [], webProviders: { deepseek: { open: true, signedIn: true, tabId: 7 } } } });
    expect((await bridgeStatus()).webProviders?.deepseek).toMatchObject({ open: false, signedIn: null });
    expect(getLog().filter(entry => !priorLogs.has(entry)).map(entry => entry.message)).not.toContain('bridge: DeepSeek signed in');

    const beforeAppBrowser = new Set(getLog());
    await request('POST', '/status', { host: 'integrated', browser: 'f'.repeat(32), body: { openConversations: [], webProviders: {
      deepseek: { open: true, signedIn: true, tabId: 7 },
      kimi: { open: true, signedIn: false, tabId: 8 }
    } } });
    const seen = await bridgeStatus();
    expect(seen.webProviders?.deepseek).toMatchObject({ open: true, signedIn: true, tabId: 7 });
    expect(seen.webProviders?.deepseek?.lastSeenAt).toEqual(expect.any(Number));
    expect(seen.webProviders?.kimi).toMatchObject({ open: true, signedIn: false, tabId: 8 });
    const providerLogs = getLog().filter(entry => !beforeAppBrowser.has(entry)).map(entry => entry.message);
    expect(providerLogs).toContain('bridge: DeepSeek signed in');
    expect(providerLogs).toContain('bridge: Kimi open, signed out');

    await request('POST', '/status', { host: 'integrated', browser: 'f'.repeat(32),
      body: { openConversations: [], deepseekOpen: true, deepseekSignedIn: false } });
    expect((await bridgeStatus()).webProviders?.deepseek?.signedIn).toBe(true);
    resetBridgeForTests();
    expect((await bridgeStatus()).webProviders?.deepseek).toMatchObject({ open: false, signedIn: null, tabId: null, lastSeenAt: null });
  });

  it('delivers and accepts provider-page work only through the app-owned extension host', async () => {
    await pair();
    const conversationId = webProviderConversationId('qwen', randomUUID());
    const completion = requestProviderPageComplete('qwen', conversationId, 'Answer from the local workspace');
    try {
      const external = await request('GET', '/status', { host: 'browser' });
      expect(external.body.providerPage).toBeNull();
      const internal = await request('GET', '/status', { host: 'integrated' });
      const offer = internal.body.providerPage;
      expect(offer).toMatchObject({ provider: 'qwen', conversationId, text: 'Answer from the local workspace' });

      const reply = { id: offer.id, provider: 'qwen', conversationId, text: 'wrong browser account' };
      expect((await request('POST', '/deepseek/page', { host: 'integrated', body: reply })).status).toBe(404);
      expect((await request('GET', '/status', { host: 'integrated' })).body.providerPage).toEqual(offer);
      expect((await request('POST', '/provider/page', { host: 'browser', body: reply })).body.ok).toBe(false);
      expect((await request('GET', '/status', { host: 'integrated' })).body.providerPage).toEqual(offer);
      expect((await request('POST', '/provider/page', { host: 'integrated', body: reply })).body.ok).toBe(true);
      await expect(completion).resolves.toEqual({ text: 'wrong browser account' });
    } finally {
      resetProviderPageForTests();
    }
  });

  // The suite binds ephemeral ports so it can never collide with the installed app, so the shipped range has to be asserted directly or a typo in it would ship unnoticed.
  it('ships the fixed candidate range the extension scans', () => {
    expect(DEFAULT_PORTS).toEqual([8765, 8766, 8767, 8768, 8769]);
  });

  it('identifies itself to an extension without any credential', async () => {
    const reply = await request('GET', '/hello', { auth: null });
    expect(reply.status).toBe(200);
    expect(reply.body.app).toBe('neuraflok');
    // Against the constant, not a literal: what matters is that the handshake reports the build's own version, and a hard-coded number here only ever fails on release day.
    expect(reply.body.version).toBe(APP_VERSION);
    expect(reply.body.bridge).toBe(BRIDGE_PROTOCOL);
    expect(reply.body.paired).toBe(false);
    // Identification must not double as a status leak.
    expect(Object.keys(reply.body)).toEqual(['app', 'version', 'bridge', 'compatible', 'paired', 'disconnected']);
    expect(reply.body.disconnected).toBe(false);
    expect(reply.body.compatible).toBe(true);
  });

  it('refuses every web page origin, chatgpt.com included', async () => {
    for (const origin of ['https://chatgpt.com', 'https://evil.example.com', 'http://localhost:3000', 'null']) {
      const reply = await request('GET', '/hello', { origin, auth: null });
      expect(reply.status, origin).toBe(403);
      expect(reply.body.error).toBe('forbidden_origin');
      expect(reply.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('serves a request that carries no Origin at all', async () => {
    const reply = await request('GET', '/hello', { origin: null, auth: null });
    expect(reply.status).toBe(200);
    expect(reply.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers an extension preflight with the private-network header Chrome needs', async () => {
    const reply = await request('OPTIONS', '/events', { auth: null });
    expect(reply.status).toBe(204);
    expect(reply.headers['access-control-allow-origin']).toBe(EXTENSION_ORIGIN);
    expect(reply.headers['access-control-allow-private-network']).toBe('true');
    expect(reply.headers['access-control-allow-headers']).toContain('x-extension-build');
  });

  it('refuses a preflight that arrives without an Origin', async () => {
    const reply = await request('OPTIONS', '/events', { origin: null, auth: null });
    expect(reply.status).toBe(403);
  });
});

// -------------------------------------------------------------- provisioning

describe('provisioning', () => {
  it('issues a token to the extension with nothing for the user to type', async () => {
    const reply = await request('POST', '/pair', { auth: null });
    expect(reply.status).toBe(200);
    expect(reply.body.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const hello = await request('GET', '/hello', { auth: null });
    expect(hello.body.paired).toBe(true);
  });

  it('starts and stays usable while secure storage is unavailable, then pairs after it returns', async () => {
    await stopBridge();
    resetSecretsCacheForTests();
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(false);
    const restarted = await startBridge();
    expect(restarted).toBeGreaterThan(0);
    bridgeState.base = `http://127.0.0.1:${restarted}`;

    const hello = await request('GET', '/hello', { auth: null });
    expect(hello.status).toBe(200);
    expect(hello.body.paired).toBe(false);
    const reply = await request('POST', '/pair', { auth: null });
    expect(reply.status).toBe(503);
    expect(reply.body.error).toBe('secure_storage_unavailable');
    expect(reply.body.message).toMatch(/credential storage/i);
    expect(reply.body.token).toBeUndefined();

    // Keychain/Secret Service can become available after login/unlock without the app or bridge restarting. The listener must recover in place rather than being poisoned by the first read.
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
    const paired = await request('POST', '/pair', { auth: null });
    expect(paired.status).toBe(200);
    expect(paired.body.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect((await bridgeStatus()).running).toBe(true);
  });

  it('never issues a token to a web page', async () => {
    for (const origin of ['https://chatgpt.com', 'https://evil.example.com', 'null']) {
      const silent = await request('POST', '/pair', { origin, auth: null });
      expect(silent.status, origin).toBe(403);
      expect(silent.body.error).toBe('forbidden_origin');
      expect(silent.body.token).toBeUndefined();
    }
    expect((await request('GET', '/hello', { auth: null })).body.paired).toBe(false);
  });

  it('replaces the token on a second request, so a re-provision supersedes the old one', async () => {
    const first = await pair();
    const second = await pair();
    expect(second).not.toBe(first);
    expect((await request('GET', '/status', { auth: first })).status).toBe(401);
    expect((await request('GET', '/status', { auth: second })).status).toBe(200);
  });

  it('lets concurrent automatic browser profiles share one valid credential without revoking one another', async () => {
    const replies = await Promise.all(Array.from({ length: 6 }, () => request('POST', '/pair', { auth: null, body: { reuse: true } })));
    expect(replies.every(reply => reply.status === 200)).toBe(true);
    const credentials = replies.map(reply => reply.body.token as string);
    expect(new Set(credentials).size).toBe(1);
    for (const auth of credentials) expect((await request('GET', '/status', { auth })).status).toBe(200);
    resetSecretsCacheForTests();
    const restored = await request('POST', '/pair', { auth: null, body: { reuse: true } });
    expect(restored.body.token).toBe(credentials[0]);
    await unpair();
    expect((await request('GET', '/status', { auth: credentials[0] })).status).toBe(401);
    expect((await request('POST', '/pair', { auth: null, body: { reuse: true } })).status).toBe(409);
    const reconnect = await request('POST', '/pair', { auth: null, body: { reconnect: true } });
    expect(reconnect.status).toBe(200);
    expect(reconnect.body.token).not.toBe(credentials[0]);
    expect((await request('GET', '/status', { auth: credentials[0] })).status).toBe(401);
  });

  it('does not report successful pairing when Disconnect supersedes a delayed credential write', async () => {
    let entered!: () => void;
    let release!: () => void;
    const writing = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(safeStorage.encryptStringAsync).mockImplementationOnce(async value => {
      entered();
      await held;
      return Buffer.from(value, 'utf8');
    });
    const pairing = request('POST', '/pair', { auth: null, body: { reuse: true } });
    await writing;
    const disconnecting = unpair();
    release();
    const paired = await pairing;
    await disconnecting;
    expect(paired.status).toBe(409);
    expect(paired.body.token).toBeUndefined();
    expect((await request('GET', '/hello', { auth: null })).body.disconnected).toBe(true);
    expect((await request('POST', '/pair', { auth: null, body: { reuse: true } })).status).toBe(409);
  });

  it('drops the token when the user disconnects the browser', async () => {
    await pair();
    expect((await request('GET', '/status')).status).toBe(200);
    await unpair();
    expect((await request('GET', '/status')).status).toBe(401);
  });

  it('keeps an app-side disconnect latched until the browser explicitly reconnects', async () => {
    await pair();
    await unpair();
    // Drop the decrypted in-process cache. The next bridge read now has to recover the disconnect marker from the encrypted file, the relevant half of an app restart.
    resetSecretsCacheForTests();

    // First-install provisioning is silent, but this browser was deliberately revoked by the app. A background poll must not be able to turn that revocation into a new token.
    const silent = await request('POST', '/pair', { auth: null });
    expect(silent.status).toBe(409);
    expect(silent.body.error).toBe('browser_disconnected');
    expect((await request('GET', '/hello', { auth: null })).body).toMatchObject({
      paired: false,
      disconnected: true
    });

    // The extension popup's Connect action is the explicit counterpart. Only that intent clears the durable app-side latch and mints a usable token again.
    const reconnect = await request('POST', '/pair', { auth: null, body: { reconnect: true } });
    expect(reconnect.status).toBe(200);
    bridgeState.token = reconnect.body.token as string;
    expect((await request('GET', '/status')).status).toBe(200);
    expect((await request('GET', '/hello', { auth: null })).body).toMatchObject({
      paired: true,
      disconnected: false
    });
  });

  it('does not treat a persisted pairing token as proof the browser is present after restart', async () => {
    await pair();
    expect(await bridgeStatus()).toMatchObject({ paired: true, present: true });

    // Pairing is durable authorization; browser presence belongs to this app process. A restart keeps the token but has not seen the extension yet, so setup must not call it connected merely because an old credential survived on disk.
    resetBridgeForTests();
    expect(await bridgeStatus()).toMatchObject({ paired: true, present: false, lastSeenAt: null });
  });

  it('requires a fresh browser sighting after the local bridge itself restarts', async () => {
    await pair();
    expect(await bridgeStatus()).toMatchObject({ paired: true, present: true });

    await stopBridge();
    expect(await bridgeStatus()).toMatchObject({ running: false, paired: true, present: false, lastSeenAt: null });
    const restarted = await startBridge();
    expect(restarted).not.toBeNull();
    bridgeState.base = `http://127.0.0.1:${restarted}`;
    expect(await bridgeStatus()).toMatchObject({ running: true, paired: true, present: false, lastSeenAt: null });

    // Authorization survived, so the first normal extension poll proves presence again.
    expect((await request('GET', '/status')).status).toBe(200);
    expect(await bridgeStatus()).toMatchObject({ paired: true, present: true });
  });
});

describe('active agent tab discard projection', () => {
  it('reuses sleeping workers after two minutes and releases their pages after five without retiring them', async () => {
    const previous = getConfig();
    await saveConfig({ ...previous, multiAgent: { ...previous.multiAgent, maxWorkers: 3 }, ui: { ...previous.ui, tabsToKeepOpen: 1 } });
    try {
      await pair();
      spawn({ workers: [{ task: 'first' }, { task: 'second' }, { task: 'third' }], caller: { conversationId: PRIME_CHAT } });
      const chats = ['aaaaaaaa-1111-4222-8333-444444444444', 'bbbbbbbb-1111-4222-8333-444444444444', 'cccccccc-1111-4222-8333-444444444444'];
      chats.forEach((id, index) => expect(bindConversation(`worker-${index + 1}`, id)).toBe(true));
      finishAgent({ conversationId: chats[0]! }, 'first sleeping');
      finishAgent({ conversationId: chats[1]! }, 'second sleeping');
      const status = (await request('POST', '/status', { body: { openConversations: chats } })).body;
      expect(status.idleReuseAfterMs).toBe(120000);
      expect(status.idleCloseAfterMs).toBe(300000);
      expect(status.reusableConversations).toEqual([]);
      expect(status.sleepingWorkerConversations).toBeUndefined();
      expect(status.managedConversations).toEqual(expect.arrayContaining(chats));
      expect(status.closableConversations).toEqual([]);
      expect(status.nonDiscardableConversations).not.toContain(chats[2]); // broker state alone is not live page work
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 121_000);
      try {
        noteAgentAlive(chats[0], 'page'); // periodic page presence must not renew idle work
        const quiet = (await request('POST', '/status', { body: { openConversations: chats } })).body;
        expect(quiet.closableConversations).toEqual([]);
        expect(quiet.retiredConversations).toEqual([]);
        expect(quiet.reusableConversations).toEqual(chats.slice(0, 2));
        setChatBlocked(chats[2]!, true);
        const newlyBlocked = (await request('POST', '/status', { body: { openConversations: chats } })).body;
        expect(newlyBlocked.blockedConversations).toContain(chats[2]);
        expect(newlyBlocked.closableConversations).not.toContain(chats[2]);
        clock.mockReturnValue(now + 242_000);
        noteAgentAlive(chats[2], 'page');
        const blockedIdle = (await request('POST', '/status', { body: { openConversations: chats } })).body;
        expect(blockedIdle.closableConversations).toContain(chats[2]);
        setChatBlocked(chats[2]!, false);
        clock.mockReturnValue(now + 301_000);
        noteAgentAlive(chats[0], 'page');
        const expired = (await request('POST', '/status', { body: { openConversations: chats } })).body;
        expect(expired.closableConversations).toEqual(chats.slice(0, 2));
        expect(expired.retiredConversations).toEqual([]);
        expect(agentInfoForOwnedConversation(chats[0]!)?.state).toBe('sleeping');
        workerConversationGone(chats[0]!);
        expect(agentInfoForOwnedConversation(chats[0]!)?.state).toBe('sleeping');
        expect(agentInfoForOwnedConversation(chats[0]!)?.revivable).toBe(true);
      } finally { clock.mockRestore(); }
      const onlyOpen = (await request('POST', '/status', { body: { openConversations: [chats[0]] } })).body;
      expect(onlyOpen.managedConversations).toEqual([chats[0]]);
      expect((await request('POST', '/status', { body: { openConversations: Array(400).fill(chats[0]) } })).status).toBe(200);
      expect((await request('POST', '/status', { body: { openConversations: Array(10_001).fill(chats[0]) } })).status).toBe(400);
      await saveConfig({ ...getConfig(), ui: { ...getConfig().ui, tabsToKeepOpen: 2 } });
      expect((await request('GET', '/status')).body.closableConversations).toEqual([]);
    } finally { await saveConfig(previous); }
  });
  it('never treats the chat Compact & Resume moved the user into as an app-owned tab (#1012)', async () => {
    await pair();
    const { setSessionOrigin } = await import("../../../backend/domains/sessions/history/store.js");
    const resumed = 'cafe1012-0000-4000-8000-000000001012';
    const session = await createSession({ conversationId: resumed, title: 'Long project' });
    await setSessionOrigin(session.id, { kind: 'resume', fromSessionId: session.id, agentId: null, task: '' }, 'Resumed: Long project');
    const status = (await request('POST', '/status', { body: { openConversations: [resumed] } })).body;
    expect(status.managedConversations).not.toContain(resumed);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000);
    try {
      // An hour idle in the background is still the user's working chat.
      const idle = (await request('POST', '/status', { body: { openConversations: [resumed] } })).body;
      expect(idle.managedConversations).not.toContain(resumed);
      expect(idle.closableConversations).not.toContain(resumed);
    } finally { clock.mockRestore(); }
  });

  it.each(['opening', 'established', 'missing-source', 'same-source'])('retires only cancelled claimed dedicated helpers, preserving source and personal chats (%s)', async kind => {
    await pair();
    const { registerGoalDecisionChat } = await import("../../../backend/domains/automation/goal.js");
    const { resetInputForTests } = await import("../../../backend/domains/sessions/input/input.js");
    const main = 'cafe0189-0000-4000-8000-000000000189';
    const helper = `cafe0190-0000-4000-8000-00000000019${['opening', 'established', 'missing-source', 'same-source'].indexOf(kind)}`;
    const personal = 'cafe0191-0000-4000-8000-000000000191';
    const source = await createSession({ conversationId: kind === 'same-source' ? helper : main, title: 'Source' });
    const sourceId = kind === 'opening' ? undefined : kind === 'missing-source' ? '2026-09-07-missing' : source.id;
    const eligible = kind === 'opening' || kind === 'established';
    await registerGoalDecisionChat(helper, sourceId);
    const row = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', sessionId: null, purpose: 'decision', state: 'cancelled',
      text: 'Cancelled helper instruction', mode: 'after-turn', dueAt: Date.now() - 180000, createdAt: Date.now() - 180000,
      model: null, reasoningEffort: null, owner: '71:helper-document:0', decisionSourceSessionId: sourceId, conversationId: helper };
    await writeDurableNow('session-input', [row, { ...row, id: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', conversationId: personal }]);
    resetInputForTests();
    try {
      const status = (await request('POST', '/status', { body: { openConversations: [main, helper, personal] } })).body;
      expect(status.cancelledDecisionClaims.length).toBe(eligible ? 1 : 0);
      if (eligible) {
        expect(status.managedConversations).toContain(helper);
        expect(status.closableConversations).toContain(helper);
      }
      expect(status.closableConversations).not.toContain(main);
      expect(status.managedConversations).not.toContain(personal);
      expect(status.cancelledDecisionClaims).toEqual(eligible ? [{ id: row.id, owner: row.owner, conversationId: helper }] : []);
    } finally { await writeDurableNow('session-input', []); resetInputForTests(); }
  });

  it.each(['queued', 'browser'])('a %s checkpoint protects its actual owner across compaction', async state => {
    await pair();
    const { resetInputForTests } = await import("../../../backend/domains/sessions/input/input.js");
    const from = `cafe0291-0000-4000-8000-00000000029${state === 'queued' ? '1' : '3'}`;
    const to = `cafe0292-0000-4000-8000-00000000029${state === 'queued' ? '2' : '4'}`;
    const source = await createSession({ conversationId: from, title: 'Plan source' });
    const continuation = await openContinuationNow(source.id, from);
    await attachSummary(continuation.token, SAMPLE_BRIEF);
    await claimContinuationNow(continuation.token, 'plan-resume');
    expect(await commitContinuation(continuation.token, to)).toBe(true);
    await writeDurableNow('session-input', [{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', sessionId: source.id,
      text: 'Checkpoint three', state, mode: 'finish', dueAt: Date.now(), createdAt: Date.now(),
      model: null, reasoningEffort: null, owner: state === 'browser' ? 'old-document' : null, conversationId: from }]);
    resetInputForTests();
    try {
      const status = (await request('POST', '/status', { body: { openConversations: [from, to] } })).body;
      expect(status.retiredConversations.includes(from)).toBe(state === 'queued');
      expect(status.retiredConversations).not.toContain(to);
    } finally { await writeDurableNow('session-input', []); resetInputForTests(); }
  });

  it('projects only the owning prime worker status without task or conversation details', async () => {
    await pair();
    const primeConversation = '11223344-1111-4222-8333-444444444444';
    const workerConversation = 'aabbccdd-1111-4222-8333-444444444444';
    await createSession({ conversationId: primeConversation, title: 'Prime' });
    await createSession({ conversationId: workerConversation, title: 'Worker' });
    await recordFinalForTest(primeConversation, 'prime-progress');
    await recordFinalForTest(workerConversation, 'worker-progress');
    spawn({ workers: [{ task: 'PRIVATE_TASK_MUST_NOT_CROSS', label: 'Repository audit' }], caller: { conversationId: primeConversation } });
    expect(bindConversation('worker-1', workerConversation)).toBe(true);
    const prime = (await request('GET', `/activity?conversationId=${primeConversation}`)).body.progress;
    expect(prime.workers).toMatchObject({ total: 1, active: 1, finished: 0, failed: 0, names: ['Repository audit'] });
    expect(JSON.stringify(prime)).not.toContain('PRIVATE_TASK');
    expect(JSON.stringify(prime)).not.toContain(workerConversation);
    expect((await request('GET', `/activity?conversationId=${workerConversation}`)).body.progress.workers).toBeNull();
    finishAgent({ conversationId: workerConversation }, 'done');
    expect((await request('GET', `/activity?conversationId=${primeConversation}`)).body.progress.workers).toMatchObject({ active: 0, finished: 1 });
  });
  it('does not mistake a broker active label for a running provider turn', async () => {
    await pair();
    const workerConversation = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    spawn({ workers: [{ task: 'stay live while Chrome applies the tab policy' }], caller: { conversationId: PRIME_CHAT } });

    expect((await request('GET', '/status')).body.nonDiscardableConversations).toEqual([]);

    expect(bindConversation('worker-1', workerConversation)).toBe(true);
    expect((await request('GET', '/status')).body.nonDiscardableConversations).toEqual([]);

    finishAgent({ conversationId: workerConversation }, 'the worker is sleeping now');
    expect((await request('GET', '/status')).body.nonDiscardableConversations).toEqual([]);
  });
});

// -------------------------------------------------------------------- auth

describe('extension update holds', () => {
  it('logs once per reason why the browser extension waits to update, from its status report', async () => {
    await pair();
    const lines = () => getLog().filter(entry => entry.message.includes('browser extension waits to update'));
    const before = lines().length;
    const status = (updateHold?: string) => request('POST', '/status', { body: { openConversations: [], ...(updateHold ? { updateHold } : {}) } });
    await status('chat-busy'); await status('chat-busy');
    expect(lines().slice(before).map(entry => entry.message)).toEqual(['bridge: the browser extension waits to update: a provider page is still answering']);
    await status('already-tried');
    expect(lines().at(-1)!.message).toContain('already tried this update once; restart the integrated browser');
    // An unknown reason is not logged, and a report without a hold resets it.
    await status('made-up'); await status(); await status('chat-busy');
    expect(lines().slice(before)).toHaveLength(3);
  });
});

describe('authorisation', () => {
  it('refuses every route but /hello and /pair without a token', async () => {
    await pair();
    for (const [method, path] of [
      ['GET', '/status'],
      ['GET', '/activity?conversationId=abcdabcd'],
      ['POST', '/events'],
      ['POST', '/correlations'],
      ['POST', '/closed'],
      ['POST', '/live-preview'],
      ['POST', '/commands/ack']
    ] as const) {
      const reply = await request(method, path, { auth: null, ...(method === 'POST' ? { body: {} } : {}) });
      expect(reply.status, path).toBe(401);
    }
  });

  it('refuses a token of the right shape but the wrong value', async () => {
    const issued = await pair();
    const forged = `${issued.slice(0, -1)}${issued.endsWith('A') ? 'B' : 'A'}`;
    expect((await request('GET', '/status', { auth: forged })).status).toBe(401);
  });

  it('has no route that reads a file or runs anything', async () => {
    await pair();
    for (const path of ['/read', '/exec', '/config', '/secrets', '/../config.json']) {
      expect((await request('GET', path)).status, path).toBe(404);
    }
  });
});

// ------------------------------------------------------------------ events

describe('observations', () => {
  it('persists bounded native reactions on the exact canonical user message and preserves sparse replays', async () => {
    await pair();
    const conversationId = 'f0f00003-1111-4111-8111-111111111119';
    const user = { kind: 'user_message', time: Date.now(), text: 'Question', messageId: 'reaction-user' };
    const send = (events: unknown[]) => request('POST', '/events', { body: { conversationId, events } });
    const first = await send([user, { ...user, messageId: 'other-user' }]);
    const before = (await readEvents(first.body.sessionId, { kinds: ['user_message'] }))[0]!;
    await send([{ ...user, reaction: '😂' }]);
    await send([user, { ...user, reaction: '<script>' }, { ...user, reaction: '😂'.repeat(100) }]);
    let rows = await readEvents(first.body.sessionId, { kinds: ['user_message'] });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ messageId: user.messageId, reaction: '😂', origin: before.seq, time: before.time });
    expect(rows[1]).not.toHaveProperty('reaction');
    await send([{ ...user, reaction: null }]);
    rows = await readEvents(first.body.sessionId, { kinds: ['user_message'] });
    expect(rows[0]).toMatchObject({ reaction: null, origin: before.seq });
  });

  it('refuses anything that is not a conversation id', async () => {
    await pair();
    for (const conversationId of ['', 'not a uuid', '../../etc', 'x'.repeat(100)]) {
      const reply = await request('POST', '/events', { body: { conversationId, events: [] } });
      expect(reply.status, String(conversationId)).toBe(400);
      expect(reply.body.error).toBe('bad_conversation_id');
    }
  });

  it('stores what the page reported and skips what it does not recognise', async () => {
    await pair();
    const conversationId = 'f0f00003-1111-4111-8111-111111111111';
    const reply = await request('POST', '/events', {
      body: {
        conversationId,
        events: [
          { kind: 'user_message', time: Date.now(), text: 'first requirement', messageId: 'm1' },
          { kind: 'turn_start', time: Date.now(), turnId: 'turn-1' },
          { kind: 'assistant_message', time: Date.now(), turnId: 'turn-1', text: 'reading files', messageId: 'a1', state: 'streaming' },
          { kind: 'invented_kind', time: Date.now(), text: 'should be dropped' },
          { kind: 'turn_end', time: Date.now(), turnId: 'turn-1', outcome: 'not-a-real-outcome' }
        ]
      }
    });
    expect(reply.status).toBe(200);
    expect(reply.body.stored).toBe(4);

    const events = await readEvents(reply.body.sessionId);
    expect(events.map((event) => event.kind)).toEqual([
      'session_start',
      'user_message',
      'turn_start',
      'assistant_message',
      'turn_end'
    ]);
    const end = events.at(-1)!;
    // An outcome the page invented must not be believed.
    expect(end.kind === 'turn_end' && end.outcome).toBe('unknown');
  });

  it('replaces an impossible timestamp rather than storing it', async () => {
    await pair();
    const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const reply = await request('POST', '/events', {
      body: {
        conversationId,
        events: [{ kind: 'assistant_message', time: Date.now() + 10 * 24 * 3600_000, text: 'from the future', messageId: 'future-a', state: 'streaming' }]
      }
    });
    const events = await readEvents(reply.body.sessionId, { kinds: ['assistant_message'] });
    expect(events[0]!.time).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('preserves ChatGPT creation times from an old chat instead of moving them to reload time', async () => {
    await pair();
    const conversationId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    const historical = Date.now() - 90 * 24 * 3600_000;
    const reply = await request('POST', '/events', {
      body: {
        conversationId,
        events: [{ kind: 'assistant_message', time: historical, text: 'historical answer', messageId: 'historical-a', state: 'final', final: true }]
      }
    });
    const events = await readEvents(reply.body.sessionId, { kinds: ['assistant_message'] });
    expect(events[0]!.time).toBe(historical);
  });

  it('stores a message once when a reloaded tab reports it twice', async () => {
    await pair();
    const conversationId = '11111111-2222-3333-4444-555555555555';
    const message = { kind: 'user_message', time: Date.now(), text: 'the original task', messageId: 'msg-a' };
    const first = await request('POST', '/events', { body: { conversationId, events: [message] } });
    const second = await request('POST', '/events', { body: { conversationId, events: [message] } });
    expect(first.body.stored).toBe(1);
    expect(second.body.stored).toBe(0);
    expect(await readEvents(first.body.sessionId, { kinds: ['user_message'] })).toHaveLength(1);
  });

  it('anchors and independently enriches multiple exact native generated images without activity effects', async () => {
    await pair();
    const conversationId = '21111111-2222-4333-8444-555555555555';
    const make = async (color: string, width: number, height: number) => {
      const bytes = await sharp({ create: { width, height, channels: 3, background: color } }).webp().toBuffer();
      return `data:image/webp;base64,${bytes.toString('base64')}`;
    };
    const messageId = '3150f756-bf2d-45fa-ac0f-45010b2239fb';
    const images = [
      { providerAssetId: 'file_000000005f2c823085a542762d1de785', previewWidth: 12, previewHeight: 8, previewDataUrl: await make('#0055ff', 12, 8) },
      { providerAssetId: 'file_00000000dc58821198efef946a9ade33', previewWidth: 9, previewHeight: 11, previewDataUrl: await make('#ff6600', 9, 11) }
    ];
    const reply = await request('POST', '/events', { body: { conversationId, events: images.flatMap((image, index) => [
      { kind: 'native_image', time: 1789552000000 + index, messageId, providerAssetId: image.providerAssetId,
        providerRole: 'tool', providerChannel: 'final', providerStatus: 'finished_successfully', width: 1254, height: 1254, previewStatus: 'pending' },
      { kind: 'native_image', time: 1789552000100 + index, messageId, providerAssetId: image.providerAssetId,
        providerRole: 'tool', providerChannel: 'final', providerStatus: 'finished_successfully', width: 1254, height: 1254, previewStatus: 'available',
        previewWidth: image.previewWidth, previewHeight: image.previewHeight, previewDataUrl: image.previewDataUrl,
        src: 'https://chatgpt.com/backend-api/estuary/content?id=must-not-persist&sig=private' }
    ]) } });

    expect(reply.status).toBe(200);
    const stored = await readEvents(reply.body.sessionId, { kinds: ['native_image'] });
    expect(stored).toHaveLength(2);
    expect(stored.map(event => event.kind === 'native_image' && event.providerAssetId)).toEqual(images.map(image => image.providerAssetId));
    expect(stored.every(event => event.kind === 'native_image' && event.previewStatus === 'available' && event.asset?.mimeType === 'image/webp')).toBe(true);
    expect(JSON.stringify(stored)).not.toContain('estuary');
    expect(JSON.stringify(stored)).not.toContain('private');
    const feed = await request('GET', `/activity?conversationId=${conversationId}&since=0`);
    expect(feed.body.entries).toEqual([]);
    expect(feed.body.stream.filter((entry: any) => entry.kind === 'native_image')).toEqual([]);

    const oversized = await request('POST', '/events', { body: { conversationId, events: [{
      kind: 'native_image', time: 1789552000200, messageId,
      providerAssetId: 'file_00000000000000000000000000000099', providerRole: 'tool', providerChannel: 'final',
      providerStatus: 'finished_successfully', width: 30_000, height: 30_000, previewStatus: 'available',
      previewWidth: 12, previewHeight: 8, previewDataUrl: await make('#ffffff', 12, 8)
    }] } });
    expect(oversized.status).toBe(200);
    const oversizedRow = (await readEvents(reply.body.sessionId, { kinds: ['native_image'] }))
      .find(event => event.kind === 'native_image' && event.providerAssetId.endsWith('99'));
    expect(oversizedRow).toMatchObject({ width: 30_000, height: 30_000, previewStatus: 'unavailable', previewError: 'oversized' });
    expect(oversizedRow && oversizedRow.kind === 'native_image' ? oversizedRow.asset : undefined).toBeUndefined();

    const quotaWrite = vi.spyOn(sessionStoreModule, 'writeAsset').mockRejectedValueOnce(new Error('Global session asset quota exceeded'));
    try {
      const quota = await request('POST', '/events', { body: { conversationId, events: [{
        kind: 'native_image', time: 1789552000300, messageId,
        providerAssetId: 'file_00000000000000000000000000000098', providerRole: 'tool', providerChannel: 'final',
        providerStatus: 'finished_successfully', width: 1254, height: 1254, previewStatus: 'available',
        previewWidth: 12, previewHeight: 8, previewDataUrl: await make('#aaaaaa', 12, 8)
      }] } });
      expect(quota.status).toBe(200);
    } finally {
      quotaWrite.mockRestore();
    }
    const quotaRow = (await readEvents(reply.body.sessionId, { kinds: ['native_image'] }))
      .find(event => event.kind === 'native_image' && event.providerAssetId.endsWith('98'));
    expect(quotaRow).toMatchObject({ previewStatus: 'unavailable', previewError: 'quota' });
    expect(quotaRow && quotaRow.kind === 'native_image' ? quotaRow.asset : undefined).toBeUndefined();
  });

  it('retains native-image metadata but refuses preview bytes before final provider status', async () => {
    await pair();
    const conversationId = '21111111-2222-4333-8444-666666666666';
    const messageId = '4150f756-bf2d-45fa-ac0f-45010b2239fb';
    const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#4477aa' } }).webp().toBuffer();
    const previewDataUrl = `data:image/webp;base64,${bytes.toString('base64')}`;
    const events = [
      { providerAssetId: 'file_00000000000000000000000000000081', providerStatus: 'in_progress' },
      { providerAssetId: 'file_00000000000000000000000000000082' }
    ].map((image, index) => ({
      kind: 'native_image', time: 1789552000400 + index, messageId,
      providerAssetId: image.providerAssetId, providerRole: 'tool', providerChannel: 'final',
      ...(image.providerStatus ? { providerStatus: image.providerStatus } : {}),
      width: 1254, height: 1254, previewStatus: 'available', previewWidth: 12, previewHeight: 8, previewDataUrl
    }));

    const reply = await request('POST', '/events', { body: { conversationId, events } });
    expect(reply.status).toBe(200);
    const rows = (await readEvents(reply.body.sessionId, { kinds: ['native_image'] }))
      .filter(event => event.kind === 'native_image');
    expect(rows).toHaveLength(2);
    expect(rows.map(row => ({ id: row.providerAssetId, status: row.providerStatus, preview: row.previewStatus, asset: row.asset }))).toEqual([
      { id: events[0]!.providerAssetId, status: 'in_progress', preview: 'pending', asset: undefined },
      { id: events[1]!.providerAssetId, status: undefined, preview: 'pending', asset: undefined }
    ]);

    const final = await request('POST', '/events', { body: { conversationId, events: [{
      ...events[0], time: 1789552000500, providerStatus: 'finished_successfully'
    }] } });
    expect(final.status).toBe(200);
    const enriched = (await readEvents(reply.body.sessionId, { kinds: ['native_image'] }))
      .find(event => event.kind === 'native_image' && event.providerAssetId === events[0]!.providerAssetId);
    expect(enriched).toMatchObject({ providerStatus: 'finished_successfully', previewStatus: 'available',
      asset: { mimeType: 'image/webp', bytes: bytes.length } });
  });

  it('refuses an over-sized body with an answer, not a reset connection', async () => {
    await pair();
    const reply = await request('POST', '/events', { raw: 'x'.repeat(3 * 1024 * 1024) });
    expect(reply.status).toBe(413);
    expect(reply.body.error).toBe('body_too_large');
  });
});
