import { boundedBrowserValue } from './page-agent.js';
import { createBrowserActions } from './input/actions.js';
import { createBrowserDiagnostics } from './diagnostics.js';
import { createBrowserPageRuntime } from './page-runtime.js';
import { createBrowserControlEvents } from './lifecycle-events.js';

// One browser-lifetime tab custodian prevents selected-tab fallbacks and action replay.
export function createBrowserControl(chrome, transport, protectedTab = () => false) {
  const KEY = 'neuraflokBrowserControl';
  const LEGACY_KEY = 'neuralJamBrowserControl';
  const tabs = new Map();
  let browserId, epoch = null, receipt = null, loading, pumping, again = false, saving = Promise.resolve();
  let policy = { read: false, write: false };
  const id = () => crypto.randomUUID();
  const cut = (s, n = 1000) => String(s ?? '').slice(0,n);
  const error = message => { throw new Error(message); };
  const handle = tabId => `${browserId}:${tabId}`;
  const owns = (state, command) => !!state && (state.owner === command.owner ||
    state.owner.startsWith('request:') && command.owner.startsWith('session:') && command.ownerAliases?.includes(state.owner));
  async function cleanup(work) {
    let timer;
    try { await Promise.race([work.catch(() => {}),new Promise(resolve => {timer=setTimeout(resolve,1500);})]); }
    finally {clearTimeout(timer);}
  }
  function removeIndicator(state) {
    return chrome.scripting.executeScript({target:{tabId:state.tabId},args:[state.lease],func:lease=>{
      for(const node of document.querySelectorAll('[data-integrated-browser-control]')) if(node.getAttribute('data-integrated-browser-control')===lease)node.remove();
    }});
  }
  const pageURL = raw => {
    if (raw === 'about:blank') return raw;
    let url; try { url = new URL(raw); } catch { error('BROWSER_URL_INVALID'); }
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) error('BROWSER_URL_UNSUPPORTED: use an HTTP(S) page without embedded credentials.');
    return url.href;
  };
  function save() {
    const work = saving.catch(() => {}).then(() => chrome.storage.session.set({ [KEY]: {
      browserId, epoch, receipt,
      tabs: [...tabs.values()].map(s => ({ tabId: s.tabId, owner: s.owner, lease: s.lease }))
    } }));
    saving = work; return work;
  }
  function newState(tabId, owner, lease = id()) {
    return { tabId, owner, lease, pageId: id(), contexts: new Map(), frames: new Map(), sessions: new Set(),
      console: [], network: new Map(), seq: 0, consoleDropped: 0, networkDropped: 0, screenshot: null, dialog: null, initialized: false };
  }
  function invalidate(state) {
    state.pageId = id(); state.screenshot = null; state.refFrames?.clear();
    for (const key of state.contexts.keys()) if (key.endsWith(':isolated')) state.contexts.delete(key);
  }
  async function ready() {
    if (!loading) loading = (async () => {
      const stored = await chrome.storage.session.get([KEY, LEGACY_KEY]);
      const data = stored[KEY] || stored[LEGACY_KEY];
      browserId = typeof data?.browserId === 'string' && /^[a-f\d-]{36}$/i.test(data.browserId) ? data.browserId : id();
      epoch = data?.epoch || null; receipt = data?.receipt || null;
      for (const entry of (Array.isArray(data?.tabs) ? data.tabs : []).slice(0,32)) {
        if (Number.isSafeInteger(entry.tabId) && typeof entry.owner === 'string' && typeof entry.lease === 'string') {
          const state = newState(entry.tabId, entry.owner, entry.lease);state.restored = true;tabs.set(entry.tabId,state);
        }
      }
      await save();
      await chrome.storage.session.remove(LEGACY_KEY);
    })();
    return loading;
  }
  function alive(state, command) {
    if (tabs.get(state.tabId) !== state) error('BROWSER_DETACHED: tab ownership was released. Attach again deliberately.');
    if (command && (command.epoch !== epoch || command.expiresAt <= Date.now())) error('BROWSER_EXPIRED: remaining input was not dispatched. Earlier actions may have completed.');
    if (command?.args.pageId && !/^[a-f\d-]{36}$/i.test(command.args.pageId)) error('BROWSER_PAGE_ID_INVALID: copy the top-level pageId from the observation, not a frameId or element ref. No input was dispatched.');
    if (command?.args.pageId && state.pageId !== command.args.pageId) error('BROWSER_PAGE_STALE: navigation invalidated the observation. Snapshot again.');
  }
  async function send(state, method, params = {}, sessionId, command) {
    alive(state,command);
    if (method === 'Input.dispatchMouseEvent' && params.__sessionId) {
      const {__sessionId,...inputParams} = params;sessionId = __sessionId;params = inputParams;
    }
    let timer;
    try {
      return await Promise.race([
        chrome.debugger.sendCommand({ tabId: state.tabId, ...(sessionId ? { sessionId } : {}) }, method, params).then(value => {alive(state);return value;}),
        new Promise((_,reject) => { timer = setTimeout(() => {
          // Retire admission before releasing a stuck debugger. A late result cannot lend its target to another command; accepted effects are not replayed.
          if (tabs.get(state.tabId) === state) {
            tabs.delete(state.tabId);
            void cleanup(removeIndicator(state));
            if (method === 'Runtime.evaluate') void chrome.debugger.sendCommand({tabId:state.tabId,...(sessionId ? {sessionId}: {})},'Runtime.terminateExecution').catch(() => {});
            void chrome.debugger.detach({tabId:state.tabId}).catch(() => {});
            void save().catch(() => {});
          }
          reject(new Error(`BROWSER_CDP_TIMEOUT: ${method} did not acknowledge within its deadline. This attachment was retired; the tab was not closed. List tabs, explicitly attach the same existing tab, then inspect before repeating any input.`));
        // Background compositing can legitimately outlast input's 8s bound. A capture gets 20s within the same absolute RPC deadline, never a retry.
        }, Math.min(method==='Page.captureScreenshot' ? 20000 : 8000,command ? Math.max(1,command.expiresAt-Date.now()) : 8000)); })
      ]);
    } catch (cause) {
      clearTimeout(timer);
      // A debugger loss can race its MV3 notification. Confirm Chrome's current target state before retiring custody; an ordinary protocol/JavaScript error is not detach.
      if (tabs.get(state.tabId) === state) {
        const targets = await chrome.debugger.getTargets().catch(() => null);
        if (targets && !targets.some(target => target.tabId === state.tabId && target.attached)) {
          await release(state);
          error('BROWSER_DETACHED: Chrome ended this attachment. Earlier input may have completed; inspect before repeating.');
        }
      }
      throw cause;
    } finally { clearTimeout(timer); }
  }
  async function currentTab(state, command) {
    alive(state,command);
    const tab = await getTab(state.tabId);
    alive(state,command);
    pageURL(tab.url);
    if (tab.pendingUrl && tab.pendingUrl !== tab.url) error('BROWSER_NAVIGATING: wait for the destination and snapshot again.');
    const observes = ['browser_snapshot','browser_screenshot','browser_console','browser_network'].includes(command?.tool);
    if (!observes && protectedTab(state.tabId, tab.url, command?.conversationId)) error('BROWSER_TASK_TAB: an active NEURAFLOK operation owns this tab. browser_snapshot can inspect its DOM without taking control.');
    return tab;
  }
  async function getTab(tabId) {
    try { return await chrome.tabs.get(tabId); }
    catch (cause) {
      if (/No tab with id|Invalid tab ID/i.test(cause?.message || '')) error('BROWSER_TAB_CLOSED: this exact tab no longer exists, possibly closed by the user. List tabs to inspect current state; do not recreate it automatically.');
      throw cause;
    }
  }
  async function input(state, method, params, command) {
    await authorize(command);
    await currentTab(state,command);
    return send(state,method,params,undefined,command);
  }
  async function authorize(command, writes = true) {
    if (!(writes ? policy.write : policy.read)) error('BROWSER_PERMISSION_REVOKED');
    const check = await transport('/browser-control',{method:'POST',body:JSON.stringify({action:'check',browserId,id:command.id,epoch:command.epoch})});
    if (!check.ok || check.data?.allowed !== true) error('BROWSER_PERMISSION_REVOKED: remaining input was not dispatched.');
  }
  async function initialize(state, sessionId) {
    if (!sessionId && state.restored) {
      // Chrome may retain enabled domains while the MV3 JavaScript heap disappears. Renew this lease's domain subscriptions so existing contexts/child sessions are emitted.
      await send(state,'Target.setAutoAttach',{autoAttach:false,waitForDebuggerOnStart:false,flatten:true});
      await send(state,'Runtime.disable');state.restored = false;
    }
    await send(state,'Page.enable',{},sessionId);
    // Hidden widgets otherwise wait ~5s for mouse ACKs and suspend animation/media. This affects only the attached page, never Chrome's selected tab or OS focus. Chrome drops the emulation when its debugger session is detached.
    if (!sessionId) await send(state,'Emulation.setFocusEmulationEnabled',{enabled:true});
    await send(state,'Runtime.enable',{},sessionId);
    await send(state,'Network.enable',{ maxTotalBufferSize: 2_000_000, maxResourceBufferSize: 500_000, maxPostDataSize: 16000 },sessionId);
    await send(state,'Log.enable',{},sessionId);
    // Chrome 125+ flat child sessions let the same tab own out-of-process frames.
    await send(state,'Target.setAutoAttach',{ autoAttach:true, waitForDebuggerOnStart:false, flatten:true, filter:[{ type:'iframe', exclude:false }] },sessionId);
    if (!sessionId) state.initialized = true;
  }
  async function release(state) {
    if (tabs.get(state.tabId) !== state) return;
    // Revoke first: no in-flight continuation can send more input while detach yields.
    tabs.delete(state.tabId);
    await Promise.all([cleanup(removeIndicator(state)),cleanup(chrome.debugger.detach({tabId:state.tabId}))]);
    await save();
  }
  async function revoke() {
    await ready(); policy = { read:false,write:false };
    await Promise.all([...tabs.values()].map(release));
  }
  async function attach(tabId, command) {
    if (tabs.size >= 32 && !tabs.has(tabId)) error('BROWSER_TAB_LIMIT: release an unused tab first.');
    const previous = tabs.get(tabId);
    if (previous && !owns(previous, command)) error('BROWSER_TAB_OWNED: another conversation owns this attachment. browser_snapshot can inspect this same tab without attach; opening a duplicate is unnecessary for DOM review.');
    const state = previous || newState(tabId,command.owner);
    if (!previous) tabs.set(tabId,state);
    let acquired = false;
    try {
      await currentTab(state,command);
      if (!previous) {
        await save(); // Crash before/after attach never grants an automatic reattach.
        await chrome.debugger.attach({ tabId },'1.3');
        acquired = true;
      }
      if (!state.initialized) await initialize(state);
      await page(state,'overlay');
      const tab = await currentTab(state,command);
      return { tabId:handle(tabId), pageId:state.pageId, url:tab.url, title:cut(tab.title,500), attached:true };
    } catch (cause) {
      if (!previous) {
        // A preflight/attach refusal owns no debugger to detach. In particular, the active-tab renderer may already own it; cleanup must not cancel that work.
        if (acquired) await release(state);
        else { if (tabs.get(tabId) === state) tabs.delete(tabId); await save(); }
      }
      throw cause;
    }
  }
  async function waitForCreatedDocument(tabId,url,command) {
    // The requested navigation starts in tabs.create, independently of our debugger. Wait for a committed document, not every subresource or a temporary blank page.
    await new Promise((resolve,reject) => {
      let done = false;
      const finish = cause => {
        if(done)return;done=true;clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(changed);chrome.tabs.onRemoved.removeListener(removed);
        cause?reject(cause):resolve();
      };
      const check = () => getTab(tabId).then(tab => {
        if (!tab.url || tab.pendingUrl && tab.pendingUrl !== tab.url) return;
        if (tab.url === 'about:blank' && (url !== 'about:blank' || tab.status === 'loading')) return;
        pageURL(tab.url);finish();
      }).catch(finish);
      const changed = changedId => {if(changedId===tabId)void check();};
      const removed = removedId => {if(removedId===tabId)finish(new Error('BROWSER_TAB_CLOSED: the created tab was closed. Do not recreate it automatically.'));};
      const timer=setTimeout(()=>finish(new Error('BROWSER_CREATED_TAB_LOADING: attach this tab after it loads.')),Math.max(1,Math.min(5000,command.expiresAt-Date.now())));
      chrome.tabs.onUpdated.addListener(changed);chrome.tabs.onRemoved.addListener(removed);void check();
    });
  }
  async function owned(command) {
    const state = tabs.get(command.args.tabId);
    if (!state) {
      await getTab(command.args.tabId);
      error('BROWSER_TAB_NOT_OWNED: the tab still exists but has no live attachment. Chrome may have ended debugging or the extension restarted. Explicitly attach this same tab, then take a fresh observation. Do not open a replacement.');
    }
    if (!owns(state, command)) error('BROWSER_TAB_OWNED: another conversation owns this tab. browser_snapshot can inspect it without taking its attachment.');
    // Releasing only revokes this caller's existing lease. Do not inspect or reinitialize a page that became protected, navigated, or closed meanwhile.
    if (command.tool === 'browser_tabs' && command.args.action === 'release') { alive(state,command); return state; }
    await currentTab(state,command);
    if (!state.initialized) {
      try { await initialize(state); } catch { await release(state); error('BROWSER_DETACHED: Chrome ended this debugger attachment. Attach again deliberately.'); }
    }
    return state;
  }
  const pageRuntime = createBrowserPageRuntime({ chrome, send, getTab, authorize, pageURL, cut, error, handle, id, currentEpoch: () => epoch });
  const { frameList, context, evaluate, page, screenshot, inspect } = pageRuntime;
  const { point, action } = createBrowserActions({ authorize,currentTab,send,input,page,frameList,context,cut,error,handle });
  const { diagnostics,ingest } = createBrowserDiagnostics({send,cut,error});
  async function execute(command) {
    if (command.epoch !== epoch || command.expiresAt <= Date.now()) error('BROWSER_EXPIRED: no operation dispatched.');
    const {tool,args} = command;
    const writes = ['browser_action','browser_navigate','browser_evaluate'].includes(tool) || tool === 'browser_tabs' && ['new','close'].includes(args.action);
    if (!(writes ? policy.write : policy.read)) error('BROWSER_PERMISSION_REVOKED');
    if (tool === 'browser_tabs') {
      if (args.action === 'list') {
        const list = await chrome.tabs.query({});
        const matched=list.filter(t=>(/^https?:/.test(t.url || t.pendingUrl || '') || t.url === 'about:blank')&&(!args.filter || `${t.title} ${t.url} ${t.pendingUrl || ''}`.toLowerCase().includes(args.filter.toLowerCase())));
        const values=[];let size=0;
        for(const tab of matched.slice(args.offset || 0,(args.offset || 0)+(args.limit || 100))) {
          const attached=owns(tabs.get(tab.id),command),claimed=tabs.has(tab.id),protectedPage=protectedTab(tab.id,tab.url,command.conversationId);
          const navigating=!tab.url || !!tab.pendingUrl && tab.pendingUrl!==tab.url;
          const value={tabId:handle(tab.id),title:cut(tab.title,300),url:cut(tab.url,2000),urlTruncated:(tab.url?.length || 0)>2000,active:tab.active,pinned:tab.pinned,
            pendingUrl:tab.pendingUrl?cut(tab.pendingUrl,2000):undefined,pendingUrlTruncated:(tab.pendingUrl?.length || 0)>2000,status:tab.status || 'unknown',
            owned:attached,claimed,protected:protectedPage,access:{
              snapshot:navigating?'loading':attached?'interactive':tab.url==='about:blank'?'attach-required':'inspect',
              input:protectedPage?'protected':claimed&&!attached?'other-owner':!policy.write?'disabled':navigating?'loading':attached?'available':'attach-required'
            }};
          size+=JSON.stringify(value).length;if(size>24000)break;values.push(value);
        }
        const nextOffset=(args.offset || 0)+values.length;
        return {value:{browserId,tabs:values,total:matched.length,truncated:nextOffset<matched.length,nextOffset:nextOffset<matched.length?nextOffset:null,
          guidance:'Use browser_snapshot on this Desktop connector to inspect an existing HTTP(S) tab, including protected or foreign-owned tabs. access.input describes interaction separately. External browser plugins use separate tabs and handles.'}};
      }
      if (args.action === 'attach') return {value:await attach(args.tabId,command)};
      if (args.action === 'new') {
        const url = pageURL(args.url || 'about:blank');
        if (tabs.size >= 32) error('BROWSER_TAB_LIMIT: release an unused attachment before opening another tab.');
        await authorize(command);
        const tab = await chrome.tabs.create({url,active:false});
        // Creation is already accepted. Preserve that receipt even when attachment fails. In particular, an unavailable debugger must not strand the requested URL on blank.
        try {
          await waitForCreatedDocument(tab.id,url,command);
          await authorize(command);
          const value = await attach(tab.id,command);
          return {value:{...value,created:true,navigationRequested:url,message:'Snapshot this tab to inspect the current destination.'}};
        } catch (cause) {
          return {value:{tabId:handle(tab.id),created:true,attached:false,navigationRequested:url,attachmentError:cut(cause?.message || cause,1000),
            message:'The tab was created and its requested navigation started; attachment did not complete. Do not repeat new. Inspect this tab if it still exists; attach the same tab only when interaction is needed and available.'}};
        }
      }
      const state = await owned(command);
      if (args.action === 'release') { await release(state); return {value:{tabId:handle(state.tabId),released:true}}; }
      if (args.action === 'close') { await authorize(command); await currentTab(state,command); await chrome.tabs.remove(state.tabId); await release(state); return {value:{tabId:handle(state.tabId),closed:true}}; }
      error('BROWSER_TABS_ACTION_UNKNOWN');
    }
    const existing = tabs.get(args.tabId);
    if (tool === 'browser_snapshot' && (args.mode === 'inspect' || !owns(existing, command))) return inspect(command);
    const state = await owned(command);
    if (tool === 'browser_snapshot') {
      if (state.dialog) return {value:{tabId:handle(state.tabId),pageId:state.pageId,dialog:state.dialog,text:'A JavaScript dialog is open. Use browser_action dialog before inspecting the DOM.'}};
      const frames = await frameList(state),frameId = args.frameId || frames[0]?.frameId;
      const {refs,...value} = await page(state,'snapshot',{...args,frameId});
      // Each snapshot replaces refs only in its own frame; other inspected frames remain valid.
      state.refFrames ||= new Map();
      for (const [ref,frame] of state.refFrames) if (frame === frameId || !ref.startsWith(`${state.pageId}:`)) state.refFrames.delete(ref);
      for (const ref of refs) state.refFrames.set(ref,frameId);
      return {value:{...value,tabId:handle(state.tabId),pageId:state.pageId,frameId,frames,dialog:state.dialog}};
    }
    if (tool === 'browser_screenshot') return screenshot(state,args,command);
    if (tool === 'browser_action') return {value:await action(state,args,command)};
    if (tool === 'browser_navigate') {
      if (args.action === 'url') {
        const url = pageURL(args.url);
        const result = await input(state,'Page.navigate',{url},command);
        if (result.errorText) error(`BROWSER_NAVIGATION_FAILED: ${cut(result.errorText)}`);
      } else if (args.action === 'reload') await input(state,'Page.reload',{},command);
      else {
        const history = await send(state,'Page.getNavigationHistory');
        const next = history.entries[history.currentIndex + (args.action === 'back' ? -1 : 1)];
        if (!next) error('BROWSER_HISTORY_EMPTY');
        pageURL(next.url);
        await input(state,'Page.navigateToHistoryEntry',{entryId:next.id},command);
      }
      invalidate(state);
      return {value:{tabId:handle(state.tabId),accepted:true,message:'Navigation requested. Snapshot again when the destination loads.'}};
    }
    if (tool === 'browser_evaluate') {
      const ctx = await context(state,args.frameId,true);
      await authorize(command); await currentTab(state,command);
      const value = await evaluate(state,`(async()=>{const value=await (${args.expression});return (${boundedBrowserValue.toString()})(value);})()`,ctx,command);
      state.screenshot = null;
      return {value:{tabId:handle(state.tabId),pageId:state.pageId,...value}};
    }
    if (tool === 'browser_console' || tool === 'browser_network') return {value:await diagnostics(state,tool,args)};
    error('BROWSER_TOOL_UNKNOWN');
  }
  const { event, detached } = createBrowserControlEvents({ ready, tabs, initialize, invalidate, page, ingest, cut, save, cleanup, removeIndicator });
  async function pumpOnce() {
    await ready();
    const enabled = await chrome.permissions.contains({permissions:['debugger','tabs']});
    if (receipt) {
      const ack = await transport('/browser-control',{method:'POST',body:JSON.stringify({action:'result',browserId,...receipt})});
      if (!ack.ok && ack.status !== 409) return;
      receipt = null; await save();
    }
    const poll = await transport('/browser-control',{method:'POST',body:JSON.stringify({action:'poll',browserId,name:/Edg\//.test(navigator.userAgent) ? 'Edge' : 'Chrome / Chromium',enabled})});
    if (!poll.ok) { if (poll.status === 401 || poll.status === 426) await revoke(); return; }
    policy = poll.data.policy;
    if (epoch !== poll.data.epoch) { await Promise.all([...tabs.values()].map(release)); epoch = poll.data.epoch; await save(); }
    if (!enabled || !policy?.read) { await revoke(); return; }
    for (const request of poll.data.requests || []) {
      const owners = [...new Set([...tabs.values()].map(state => state.owner).filter(owner => owner.startsWith('request:')))];
      const claim = await transport('/browser-control',{method:'POST',body:JSON.stringify({action:'claim',browserId,id:request,epoch,owners})});
      if (!claim.ok || !claim.data.command) continue;
      let result;
      try { result = await execute(claim.data.command); }
      catch (cause) { result = {error:cut(cause?.message || cause,1500)}; }
      if (new TextEncoder().encode(JSON.stringify(result)).length > 1_800_000) result = {error:'BROWSER_RESULT_TOO_LARGE: operation may have completed; inspect before repeating.'};
      receipt = {id:request,epoch,result}; await save();
      const ack = await transport('/browser-control',{method:'POST',body:JSON.stringify({action:'result',browserId,...receipt})});
      if (!ack.ok && ack.status !== 409) return;
      receipt = null; await save();
    }
  }
  function pump() {
    if (pumping) {again = true;return pumping;}
    pumping = (async () => { do {again = false;await pumpOnce();} while (again); })().finally(() => {pumping = null;});
    return pumping;
  }
  return {pump,event,detached,revoke,execute,ready,busy:()=>pumping!==null};
}
