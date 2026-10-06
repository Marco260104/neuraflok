const { readRendererMarkup } = require('./read-renderer-markup.cjs');
// Production renderer in isolated Electron without credentials or user data.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { fixtureConfigSource } = require('./fixtures/app-defaults.cjs');
const output = path.join(root, 'outputs/disconnect-ui');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const fixture = `
    localStorage.removeItem('neuraflok.ui.language');
    ${fixtureConfigSource()}
    const config = fixtureConfig({
      roots:[{name:'fixture',path:'C:/fixture'}],readOnly:true,
      capabilities:{browse:true,search:true,read:true,metadata:true},
      ui:{theme:'dark',autoConnect:false,chatExecutor:'web',webProvider:'deepseek'},sessions:{record:true,retainDays:30,advisoryTokens:300000,limitTokens:400000},
      compaction:{auto:false,autoTokens:300000},multiAgent:{enabled:false,maxWorkers:2},
      goal:{enabled:false,model:'fixture',reasoning:'default',prompt:'Fixture'}
    });
    const state = {config,hasApiKey:false,hasGoalKey:false,
      status:{state:'disconnected',detail:'',publicUrl:null,localUrl:null,handshakeAt:null,lastRequestAt:null,lastToolCallAt:null,health:null,surfaces:[]},
      bridge:{running:true,port:8765,paired:true,present:true,lastSeenAt:Date.now(),extensionVersion:'0.1.0',webProviders:{
        deepseek:{open:false,signedIn:null,tabId:null,lastSeenAt:null}
      }},
      update:{current:'2.1.13',latest:null,stage:'idle',error:null,checkedAt:null}};
    const ok=data=>Promise.resolve({ok:true,data:structuredClone(data)});
    let push = () => {};
    window.api = new Proxy({
      getState:()=>ok(state),getLog:()=>ok([]),listProjects:()=>ok([]),
      listSessions:()=>ok({sessions:[],total:0,nextCursor:null,activeId:null,pressure:[],blocked:[]}),
      getSwarm:()=>ok({running:false,runId:null,agents:[],maxWorkers:2,pendingReports:0}),
      getChatModels:()=>ok({state:'unknown',models:[]}),
      onStateChanged:callback=>{push=()=>callback(structuredClone(state));return()=>{};}
    },{get:(target,key)=>key in target?target[key]:()=>ok(null)});
    await import('/main.ts');
    window.setDeepSeekSighting=(open,signedIn)=>{
      state.bridge.webProviders.deepseek={open,signedIn,tabId:open?7:null,lastSeenAt:Date.now()};
      push();
    };
    window.fixtureReady=true;
  `;
  const server = await createServer({configFile:false,root:path.join(root, './frontend'),
    server:{host:'127.0.0.1',port:0},plugins:[{name:'disconnect-fixture',configureServer(vite) {
      vite.middlewares.use('/fixture.html',async (_req,res)=>{
        const html=readRendererMarkup(root)
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'')
          .replace('</body>','<script type="module">'+fixture+'</script></body>');
        res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/fixture.html',html));
      });
    }}]});
  let win;
  try {
    await server.listen();
    win=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{sandbox:true,backgroundThrottling:false}});
    await win.loadURL(server.resolvedUrls.local[0]+'fixture.html');
    const js=code=>win.webContents.executeJavaScript(code);
    for(let i=0;i<100 && !(await js('!!window.fixtureReady'));i++) await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(await js('!!window.fixtureReady'),true);
    await js(`document.getElementById('sidebarConnection').click()`);
    const waitFor=async expression=>{for(let i=0;i<100&&!await js(expression);i++)await new Promise(resolve=>setTimeout(resolve,25));assert.equal(await js(expression),true,expression);};
    await waitFor('!document.getElementById("connectionPopover").hidden');
    assert.deepEqual(await js(`(() => ({title:document.getElementById('connectionPopoverTitle').textContent,providerStatus:document.getElementById('connectionPopoverDeepseekStatus').textContent,providerAction:document.getElementById('connectionPopoverProviderAction').textContent,providerHidden:document.getElementById('connectionPopoverDeepseek').hidden}))()`),
      {title:'DeepSeek · Not detected',providerStatus:'Not detected',providerAction:'Sign in to DeepSeek to connect your account.',providerHidden:false});
    await js(`window.setDeepSeekSighting(true,false)`);
    await waitFor('document.getElementById("connectionPopoverTitle").textContent==="DeepSeek · Sign in"');
    assert.equal(await js(`document.getElementById('connectionPopoverDeepseekStatus').textContent`),'Sign in');
    await js(`window.setDeepSeekSighting(true,true)`);
    await waitFor('document.getElementById("connectionPopoverTitle").textContent==="System active · DeepSeek"');
    assert.equal(await js(`document.getElementById('connectionPopoverDeepseekStatus').textContent`),'Session active');
    assert.equal(await js(`document.getElementById('connectionPopoverProviderAction').textContent`),'Open DeepSeek');
    assert.equal(await js(`document.getElementById('sidebarConnection').classList.contains('is-connected')`),true);
    await js(`window.setDeepSeekSighting(false,null)`);
    await waitFor('document.getElementById("connectionPopoverTitle").textContent==="DeepSeek · Not detected"');
    assert.equal(await js(`document.getElementById('sidebarConnection').classList.contains('is-connected')`),false);
    console.log('DeepSeek provider UI passed: not detected → signed out → session active → tab closed.');
  } finally {
    win?.destroy();await server.close();
  }
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
