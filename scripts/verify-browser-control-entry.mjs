/** Exercise the real MV3 worker, persisted pairing, alarm/wake and browser RPC transport. */
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {WebSocket,WebSocketServer} from 'ws';
import {build} from 'esbuild';

const extensionSource=path.resolve(process.env.NEURAFLOK_TEST_COMPANION||'browser-extension');
const output=path.resolve('outputs/browser-control-entry'),run=path.join(output,randomUUID());
await fs.mkdir(run,{recursive:true});
await build({entryPoints:['backend/domains/browser/browser-control.ts'],bundle:true,platform:'node',format:'esm',packages:'external',outfile:path.join(run,'broker.mjs')});
const {BrowserControlBroker}=await import(pathToFileURL(path.join(run,'broker.mjs')).href);
const clients=new Set(),requests=new Map(),token=randomUUID();
const broker=new BrowserControlBroker(()=>{for(const ws of clients)ws.send('browser-control');});
const manifest=JSON.parse(await fs.readFile(path.join(extensionSource,'manifest.json'),'utf8'));
// A localized manifest name reaches getManifest() already translated into the browser's UI language.
const messageKey=/^__MSG_(\w+)__$/.exec(manifest.name)?.[1];
const manifestNames=new Set([manifest.name]);
if(messageKey)for(const locale of await fs.readdir(path.join(extensionSource,'_locales'))){
  const messages=JSON.parse(await fs.readFile(path.join(extensionSource,'_locales',locale,'messages.json'),'utf8'));
  if(messages[messageKey]?.message)manifestNames.add(messages[messageKey].message);
}
const source=await fs.readFile(path.join(extensionSource,'src','background','service-worker.js'),'utf8');
const bridgeSource=await fs.readFile(path.join(extensionSource,'src','background','connectivity','bridge-client.js'),'utf8');
const protocol=Number(/const BRIDGE_PROTOCOL = (\d+)/.exec(bridgeSource)[1]);
const alarm=/const RETRY_ALARM = '([^']+)'/.exec(source)[1];
const server=http.createServer(async(req,res)=>{
  const route=req.url;requests.set(route,(requests.get(route)||0)+1);
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
  const reply=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  if(route==='/hello')return reply(200,{app:'neuraflok',bridge:protocol,version:manifest.version,compatible:true});
  if(route==='/pair')return reply(200,{token});
  if(route.startsWith('/fixture')){res.writeHead(200,{'content-type':'text/html'});res.end('<title>Production entry fixture</title><h1>Existing tab from actual background worker</h1><button>Fixture action</button>');return;}
  if(req.headers.authorization!==`Bearer ${token}`)return reply(401,{error:'fixture_auth_required'});
  if(route==='/status')return reply(200,{repairs:[],policy:{},agents:[],inputs:[]});
  if(route==='/browser-control'){
    if(body.action==='poll')return reply(200,{...broker.poll(body.browserId,body.name,body.enabled),policy:{read:true,write:true}});
    if(body.action==='claim'){const command=await broker.claim(body.browserId,body.id,body.epoch);return reply(command?200:409,{command});}
    if(body.action==='check')return reply(200,{allowed:await broker.check(body.browserId,body.id,body.epoch)});
    if(body.action==='result'){const ok=broker.result(body.browserId,body.id,body.epoch,body.result);return reply(ok?200:409,{ok});}
  }
  return reply(200,{});
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port,base=`http://127.0.0.1:${port}`;
const wss=new WebSocketServer({server,path:'/wake'});
wss.on('connection',ws=>{ws.on('message',bytes=>{if(bytes.toString()===token){clients.add(ws);ws.send('wake');}});ws.on('close',()=>clients.delete(ws));});
const extension=path.join(run,'extension');await fs.cp(extensionSource,extension,{recursive:true});
// Isolate only the bridge port. All production extension modules and message handlers remain unchanged.
assert.ok(/const PORTS = \[[^\]]+\];/.test(bridgeSource));
await fs.writeFile(path.join(extension,'src','background','connectivity','bridge-client.js'),bridgeSource.replace(/const PORTS = \[[^\]]+\];/,`const PORTS = [${port}];`));
const testManifest={...manifest,host_permissions:manifest.host_permissions.map(value=>value.startsWith('http://127.0.0.1:')?`http://127.0.0.1:${port}/*`:value)};
await fs.writeFile(path.join(extension,'manifest.json'),JSON.stringify(testManifest,null,2));
const browserRoot=path.join(process.env.LOCALAPPDATA||'','ms-playwright');
const executableCandidates=[
  process.env.NEURAFLOK_TEST_CHROMIUM,
  path.join(browserRoot,'chromium-1243','chrome-win64','chrome.exe'),
  path.join(browserRoot,'chromium-1208','chrome-win64','chrome.exe'),
  path.join(browserRoot,'chromium-1194','chrome-win','chrome.exe'),
  path.join(process.env.PROGRAMFILES||'C:\\Program Files','Google','Chrome','Application','chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)']||'C:\\Program Files (x86)','Microsoft','Edge','Application','msedge.exe')
].filter(Boolean);
let executable=null;
for(const candidate of executableCandidates)try{await fs.access(candidate);executable=candidate;break;}catch{}
if(!executable)throw new Error('Set NEURAFLOK_TEST_CHROMIUM to a Chromium executable that supports unpacked extensions.');
const profile=path.join(run,'profile');
const chrome=spawn(executable,[`--user-data-dir=${profile}`,'--remote-debugging-port=0','--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--enable-logging=stderr','--v=1',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let stderr='',connection,seq=0;const pending=new Map();chrome.stderr.on('data',b=>{stderr=(stderr+b).slice(-12000);});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,label,timeout=12000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const v=await read();if(v)return v;}catch(e){last=e;}await delay(100);}throw new Error(`${label}: ${last?.message||'timed out'}`);}
function cdp(method,params={},sessionId){const id=++seq;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});connection.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
async function evaluate(sessionId,expression){const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;}
const report={run,checks:[],targets:[]};
try {
  const active=await until(async()=>(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n'),'Chrome startup');
  connection=new WebSocket(`ws://127.0.0.1:${active[0]}${active[1]}`);await new Promise(resolve=>connection.on('open',resolve));
  connection.on('message',raw=>{const m=JSON.parse(raw),p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);});
  const worker=await until(async()=>{
    const targets=(await cdp('Target.getTargets')).targetInfos;
    report.targets=targets.map(({type,url})=>({type,url}));
    const workerPath=`/${manifest.background.service_worker}`;
    for(const target of targets.filter(t=>t.type==='service_worker'&&new URL(t.url).pathname===workerPath)){
      let workerSession;
      try {
        workerSession=(await cdp('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
        const name=await evaluate(workerSession,'chrome.runtime.getManifest().name');
        if(manifestNames.has(name))return {...target,workerSession};
      } catch {}
      if(workerSession)await cdp('Target.detachFromTarget',{sessionId:workerSession});
    }
  },'Production worker startup');
  report.browserApi=await evaluate(worker.workerSession,'Promise.race([chrome.tabs.query({}).then(tabs=>({count:tabs.length,urls:tabs.map(tab=>tab.url)})),new Promise(resolve=>setTimeout(()=>resolve("query-timeout"),3000))])');
  report.popupOpen=await evaluate(worker.workerSession,'chrome.action.openPopup().then(()=>({ok:true}),error=>({error:String(error)}))');
  await until(()=>requests.get('/pair'),'Production popup pairing');report.checks.push('production popup paired with the isolated fixture bridge');
  const beforeAlarm=requests.get('/status')||0;
  await evaluate(worker.workerSession,`chrome.alarms.create(${JSON.stringify(alarm)},{when:Date.now()+100})`);
  await until(()=>requests.get('/status')>beforeAlarm,'Authenticated alarm status');report.checks.push('real alarm triggered authenticated status polling');
  await until(()=>broker.browsers().length===1,'Production browser registration');report.checks.push('production import graph registered one browser incarnation');
  await evaluate(worker.workerSession,`Promise.all([0,1].map(window=>chrome.windows.create({focused:false,url:Array.from({length:5},(_,tab)=>${JSON.stringify(base+'/fixture')}+'?window='+window+'&tab='+tab)})))`);
    const listed=await until(async()=>{
      const r=await broker.execute('browser_tabs',{action:'list'},'session:entry-fixture',null,async()=>true);
      const tabs=r.value?.tabs?.filter(t=>t.url?.startsWith(base+'/fixture'));
      return tabs?.length===10?tabs:null;
    },'Ten existing tabs');
    report.checks.push('listed all ten existing tabs created across two Chrome windows');
    const tab=listed[0];
    const attached=await broker.execute('browser_tabs',{action:'attach',tabId:tab.tabId},'session:entry-fixture',null,async()=>true);assert.ok(attached.value?.attached,attached.error);
    const snapshot=await broker.execute('browser_snapshot',{tabId:tab.tabId,maxNodes:100,maxChars:8000},'session:entry-fixture',null,async()=>true);assert.match(snapshot.value?.text||snapshot.error,/Existing tab from actual background worker/);report.checks.push('wake, claim, attach and DOM result used real background transport');
    await broker.execute('browser_tabs',{action:'release',tabId:tab.tabId},'session:entry-fixture',null,async()=>true);
    const opened=await broker.execute('browser_tabs',{action:'new',url:base+'/fixture?opened=by-tool'},'session:entry-fixture',null,async()=>true);
    if(opened.error)report.createdTabState=await evaluate(worker.workerSession,'chrome.tabs.query({})');
    assert.ok(opened.value?.tabId,opened.error);report.checks.push('explicit browser_tabs new opened a tab through the production worker');
    await broker.execute('browser_tabs',{action:'close',tabId:opened.value.tabId},'session:entry-fixture',null,async()=>true);
  report.ok=true;
  report.requests=Object.fromEntries(requests);await fs.writeFile(path.join(output,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} catch(error){await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({...report,error:error.stack,stderr,requests:Object.fromEntries(requests)},null,2));throw error;}
finally {broker.reset();for(const ws of clients)ws.terminate();connection?.close();if(process.platform==='win32')await new Promise(resolve=>{const cleanup=spawn('taskkill',['/PID',String(chrome.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});cleanup.once('close',resolve);cleanup.once('error',resolve);});else chrome.kill();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));}
