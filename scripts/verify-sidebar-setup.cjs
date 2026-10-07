const { readRendererMarkup } = require('./read-renderer-markup.cjs');
// Isolated renderer/Chromium acceptance. No backend, provider, credentials or pairing.
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename],
    { env, encoding: 'utf8', windowsHide: true });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const { fixtureConfigSource } = require('./fixtures/app-defaults.cjs');
const output = path.join(root, 'outputs/sidebar-setup');
app.setPath('userData', path.join(output, 'runtime'));
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const fixture = `
    if (new URL(location.href).searchParams.has('reset')) localStorage.removeItem('neuraflok.sidebar-order');
    localStorage.removeItem('neuraflok.ui.language');
    ${fixtureConfigSource()}
    const config = fixtureConfig({
      roots: [{name:'demo',path:'C:/demo'}], readOnly:true,
      capabilities: {browse:true,search:true,read:true,metadata:true,create:false,edit:false,move:false,deleteFile:false,command:false,screen:false,control:false,clipboardRead:false,clipboardWrite:false},
      ui: {minimizeToTray:true,autoConnect:false,privacyScreenshots:false,theme:'dark'},
      sessions: {record:true,retainDays:30,advisoryTokens:300000,limitTokens:400000}, compaction:{auto:true,autoTokens:300000},
      multiAgent:{enabled:false,maxWorkers:2,allowUnattributedCalls:false,recoverAgentTabs:false},
      goal:{enabled:false,model:'fixture',reasoning:'default',prompt:'Fixture'}
    });
    const state = {config,hasApiKey:false,hasGoalKey:false,
      status:{state:'disconnected',detail:'',publicUrl:null,localUrl:null,handshakeAt:null,lastRequestAt:null,lastToolCallAt:null,health:null,surfaces:[]},
      bridge:{running:false,port:0,paired:false,present:false,lastSeenAt:null,extensionVersion:null},
      update:{current:'2.0.9',latest:null,stage:'idle',error:null,checkedAt:null}};
    const project = {id:'demo-project',name:'VideoClipper',path:'C:/demo',createdAt:1};
    const projects = [project, {id:'second-project',name:'Documentation',path:'C:/docs',createdAt:2}];
    const rows = Array.from({length:22},(_,i)=>({id:'task-'+i,title:'Project chat '+(i+1),projectId:project.id,
      conversationId:'chat-'+i,chatIds:['chat-'+i],startedAt:1,updatedAt:100-i,endedAt:2,events:0,userMessages:0,
      toolCalls:0,lastToolCallAt:null,processExitNonzero:0,toolRejected:0,toolInternalErrors:0,errors:0,
      estimatedTokens:0,contextTokens:0,lastHandoffId:null,lastHandoffAt:null,lastTurnOutcome:null,activeTurnId:null,agents:[],origin:null}));
    const ok=data=>Promise.resolve({ok:true,data});
    window.api = new Proxy({ getState:()=>ok(state),getLog:()=>ok([]),
      listProjects:()=>ok(projects),listSessions:()=>ok({sessions:rows,total:22,nextCursor:null,activeId:null,pressure:[],blocked:[]}),
      setProjectColor:(id,color)=>{const value=projects.find(row=>row.id===id);if(!value)return Promise.resolve({ok:false,error:'Project not found'});if(color)value.color=color;else delete value.color;return ok({...value})},
      getSwarm:()=>ok({running:false,runId:null,agents:[],maxWorkers:2,pendingReports:0}),
      getChatModels:()=>ok({state:'unknown',models:[]}),
      saveSettings:patch=>{state.config={...state.config,...patch};return ok(state)},
    },{get:(target,key)=>key in target?target[key]:()=>ok(null)});
    await import('/main.ts');
    const still=document.createElement('style'); still.textContent='*,*::before,*::after{animation:none!important;transition:none!important}'; document.head.append(still);
    window.fixtureReady=true;
  `;
  // A verification worktree may share dependencies through a junction. Permit only the two actual icon assets outside this checkout; never publish a missing-glyph screenshot as proof.
  const iconFiles = ['@phosphor-icons/web/regular/Phosphor.woff2', '@phosphor-icons/web/fill/Phosphor-Fill.woff2']
    .map(file => fs.realpathSync(require.resolve(file)));
  const server = await createServer({ configFile:false, root:path.join(root, './frontend'),
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,...iconFiles]}}, plugins:[{ name:'sidebar-fixture', configureServer(vite) {
      vite.middlewares.use('/fixture.html', async (_request,response) => {
        const source = readRendererMarkup(root)
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace('</body>', '<script type="module">'+fixture+'</script></body>');
        response.setHeader('Content-Type','text/html'); response.end(await vite.transformIndexHtml('/fixture.html',source));
      });
    }}] });
  let win;
  try {
    await server.listen(); fs.mkdirSync(output,{recursive:true});
    win = new BrowserWindow({show:false,width:1100,height:900,webPreferences:{sandbox:true,backgroundThrottling:false}});
    await win.loadURL(server.resolvedUrls.local[0]+'fixture.html?reset=1');
    win.webContents.setZoomFactor(1);
    const js = code=>win.webContents.executeJavaScript(code);
    const screenshot = async name => {
      await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
      await new Promise(r=>setTimeout(r,200));
      fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    };
    for(let i=0;i<100 && !(await js('!!window.fixtureReady && document.querySelectorAll(".project-group > .sess").length === 5'));i++) await new Promise(r=>setTimeout(r,25));
    assert.equal(await js(`Promise.all(['NEURAFLOK Phosphor','NEURAFLOK Phosphor Fill'].map(name=>document.fonts.load('16px "'+name+'"'))).then(faces=>faces.every(face=>face.length>0))`),true,
      'The actual bundled icon faces must load before visual evidence is captured');
    await js(`window.disclosureEvents=[]; for(const type of ['keydown','keypress','keyup','click']) document.addEventListener(type,e=>window.disclosureEvents.push({type,key:e.key,tag:e.target.tagName,cls:e.target.className,open:document.querySelector('.project-group')?.open}),true)`);
    // Project groups start closed. Exercise native summary activation before the existing visible-row geometry, drag ordering and pagination checks.
    assert.equal(await js(`document.querySelector('.project-group').open`), false);
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const shell = await js(`(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return {left:r.left,right:r.right,width:r.width,height:r.height}; };
      return { sidebar:rect('#sidebar'), main:rect('.app > main'),
        topbar:rect('.app-topbar'), providerInTitlebar:document.querySelector('.app-topbar #sidebarConnection') !== null,
        wordmark:document.querySelector('#railWorkspace [data-brand-wordmark]') !== null,
        settingsInSidebar:document.querySelector('#workspaceSettings')?.closest('#sidebar') !== null,
        rail:document.querySelector('.app-rail') };
    })()`);
    assert.equal(shell.rail, null, JSON.stringify(shell));
    assert.ok(shell.sidebar.right <= shell.main.left + 1, JSON.stringify(shell));
    assert.ok(shell.topbar.height >= 44 && shell.providerInTitlebar && shell.settingsInSidebar && shell.wordmark, JSON.stringify(shell));
    assert.deepEqual(await js(`[...document.querySelectorAll('#browserWebProvider option')].map(option=>option.value)`),
      ['deepseek','kimi','qwen','glm']);
    assert.equal(await js(`!!document.getElementById('openBrowserProvider')`), true);
    const routing = await js(`(async () => {
      document.getElementById('workspaceSettings').click();
      document.querySelector('[data-settings-go="setup"]').click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const setup = {screen:document.querySelector('.app').dataset.screen, page:document.getElementById('appPageTitle').textContent,
        active:document.querySelector('[data-panel="setup"]').classList.contains('is-active'), selected:document.querySelector('[data-settings-go="setup"]').classList.contains('is-sel')};
      document.querySelector('[data-workspace-page="chat"]').click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {setup, chat:{screen:document.querySelector('.app').dataset.screen, page:document.getElementById('appPageTitle').textContent,
        active:document.querySelector('[data-panel="chat"]').classList.contains('is-active'), selected:document.querySelector('[data-workspace-page="chat"]').classList.contains('is-sel')}};
    })()`);
    assert.deepEqual(routing, {setup:{screen:'settings',page:'Connections',active:true,selected:false},
      chat:{screen:'chat',page:'Workspace',active:true,selected:true}}, JSON.stringify(routing));
    const providerSignIn = await js(`({action:document.getElementById('browserProviderAction').textContent,
      status:document.getElementById('browserProviderStatusDeepseek').textContent,
      connectionAction:document.getElementById('connectionPopoverProviderAction').textContent,
      help:document.querySelector('.provider-account-warning span').textContent})`);
    assert.match(providerSignIn.action, /connect|conectar/i, JSON.stringify(providerSignIn));
    assert.match(providerSignIn.status, /not detected|no detectado/i, JSON.stringify(providerSignIn));
    assert.match(providerSignIn.connectionAction, /sign in|inicia sesión/i, JSON.stringify(providerSignIn));
    assert.match(providerSignIn.help, /sessions stay in the browser|las sesiones permanecen en el navegador/i, JSON.stringify(providerSignIn));
    assert.equal(providerSignIn.help, 'Separate account recommended. Sessions stay in the browser where you sign in; NEURAFLOK never copies cookies between profiles.', JSON.stringify(providerSignIn));
    const headingPoint = await js(`(() => {const r=document.querySelector('.project-heading').getBoundingClientRect();return {x:Math.round(r.left+35),y:Math.round(r.top+r.height/2)}})()`);
    const expectDisclosure = async open => {
      for (let i=0;i<100;i++) {
        if (await js(`document.querySelector('.project-group').open === ${open}`)) return;
        await new Promise(r=>setTimeout(r,10));
      }
      assert.equal(await js(`document.querySelector('.project-group').open`),open,
        JSON.stringify(await js(`({focus:document.activeElement.outerHTML.slice(0,250),events:window.disclosureEvents.slice(-12)})`)));
    };
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...headingPoint});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...headingPoint});
    await expectDisclosure(true);
    // The disclosure click above leaves the real pointer hovering the heading, which intentionally reveals its otherwise-quiet controls, and summary activation can retain focus too. Clear both before checking the idle baseline; hover/focus are separately intended to reveal the control.
    win.webContents.sendInputEvent({type:'mouseMove',x:1090,y:890});
    await js('document.activeElement?.blur(); new Promise(r=>requestAnimationFrame(r))');
    // Two quiet buttons on the project row: the new chat, then one "⋯" whose menu holds color and removal.
    assert.equal(await js(`document.querySelector('.project-group').dataset.projectColor`),undefined);
    assert.equal(await js(`getComputedStyle(document.querySelector('.project-menu')).opacity`),'0');
    assert.equal(await js(`getComputedStyle(document.querySelector('.project-new')).opacity`),'0');
    assert.deepEqual(await js(`[...document.querySelector('.project-heading').querySelectorAll('button')].map(b=>b.classList.contains('project-new')?'new':b.classList.contains('project-menu')?'menu':b.className)`),['new','menu']);
    const press=keyCode=>{for (const type of ['keyDown','char','keyUp']) if (type!=='char'||keyCode==='Enter') win.webContents.sendInputEvent({type,keyCode:type==='char'?'\r':keyCode});};
    await js(`document.querySelector('.project-menu').click()`);
    assert.equal(await js(`document.querySelector('.project-menu').getAttribute('aria-expanded')`),'true');
    // The menu and its submenu stay inside the window: the old color popup was cut by the sidebar.
    await js(`document.querySelector('.row-menu [data-row-action="color"]').focus()`);
    press('Right');
    for(let i=0;i<100 && await js(`document.querySelectorAll('.row-menu').length!==2`);i++) await new Promise(r=>setTimeout(r,10));
    const fits=await js(`[...document.querySelectorAll('.row-menu')].map(m=>{const r=m.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})`);
    assert.deepEqual(fits,[true,true],'The menu and its Color submenu fit in the window');
    assert.equal(await js(`document.activeElement.dataset.rowAction`),'color-none','The submenu opens on the current color');
    await screenshot('project-menu-color.png');
    press('Down');
    // Input events are handled asynchronously; a slow runner read the focus before the key landed.
    for(let i=0;i<100 && await js(`document.activeElement.dataset.rowAction==='color-none'`);i++) await new Promise(r=>setTimeout(r,10));
    assert.equal(await js(`document.activeElement.dataset.rowAction`),'color-blue');
    press('Enter');
    for(let i=0;i<100 && await js(`document.querySelector('.project-group').dataset.projectColor!=='blue'`);i++) await new Promise(r=>setTimeout(r,10));
    assert.equal(await js(`document.querySelector('.project-group').dataset.projectColor`),'blue');
    assert.equal(await js(`getComputedStyle(document.querySelector('.project-heading > .ico')).color`),'rgb(76, 127, 193)','The folder wears the project color');
    assert.equal(await js(`document.querySelectorAll('.row-menu').length`),0);
    await screenshot('project-color-blue.png');
    assert.equal(await js(`document.activeElement===document.querySelector('.project-menu')`),true,
      'Saving a keyboard-selected color must return focus to its project menu button');
    // A later completion must not take focus back from a newer composer interaction.
    await js(`window.originalColorSave=window.api.setProjectColor;
      window.api.setProjectColor=(id,value)=>new Promise(resolve=>{window.completeColorSave=()=>window.originalColorSave(id,value).then(resolve)});
      document.querySelector('.project-menu').click();
      document.querySelector('.row-menu [data-row-action="color"]').click();
      document.querySelector('.row-menu [data-row-action="color-green"]').focus()`);
    press('Enter');
    for(let i=0;i<100 && await js(`typeof window.completeColorSave!=='function'`);i++) await new Promise(r=>setTimeout(r,10));
    assert.equal(await js(`typeof window.completeColorSave`),'function');
    const composerPoint = await js(`(() => {const r=document.getElementById('chatInput').getBoundingClientRect();return {x:Math.round(r.left+20),y:Math.round(r.top+r.height/2)}})()`);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...composerPoint});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...composerPoint});
    for(let i=0;i<100 && await js(`document.activeElement!==document.getElementById('chatInput')`);i++) await new Promise(r=>setTimeout(r,10));
    assert.equal(await js(`document.activeElement===document.getElementById('chatInput')`),true);
    await js(`window.completeColorSave()`);
    for(let i=0;i<100 && await js(`document.querySelector('.project-group').dataset.projectColor!=='green'`);i++) await new Promise(r=>setTimeout(r,10));
    assert.equal(await js(`document.querySelector('.project-group').dataset.projectColor`),'green');
    await screenshot('project-color-newer-focus.png');
    assert.equal(await js(`document.activeElement===document.getElementById('chatInput')`),true,
      'A delayed color save must not steal focus from a newer composer interaction');
    await js(`window.api.setProjectColor=window.originalColorSave;delete window.originalColorSave;delete window.completeColorSave`);
    await js(`document.querySelector('.project-heading').focus()`);
    for (const keyCode of ['Space','Enter']) {
      win.webContents.sendInputEvent({type:'keyDown',keyCode});
      // Enter's native summary activation uses the character event. Electron's low-level keyDown/keyUp pair does not synthesize that part of typing.
      if (keyCode === 'Enter') win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode});
      await expectDisclosure(keyCode === 'Enter');
    }
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const geometry = await js(`(() => { const group=document.querySelector('.project-group');
      const title=group.querySelector('.project-name').getBoundingClientRect(), chat=group.querySelector('.sess-top b').getBoundingClientRect();
      const rgb = value => value.match(/[\\d.]+/g).slice(0,3).map(Number).map(channel => {const c=channel/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4});
      const color=getComputedStyle(document.getElementById('newChat')).color, background=getComputedStyle(document.getElementById('sidebar')).backgroundColor;
      const [l1,l2]=[rgb(color),rgb(background)].map(channels => channels.reduce((sum,channel,index)=>sum+channel*[.2126,.7152,.0722][index],0)).sort((a,b)=>b-a);
      return {title:title.left,chat:chat.left,count:group.querySelectorAll(':scope > .sess').length,color,contrast:(l1+.05)/(l2+.05),
        icon:[...document.querySelector('#newChat i.ico').classList].find(name => name.startsWith('ph-') && name !== 'ph')}; })()`);
    assert.equal(geometry.count,5); assert.ok(Math.abs(geometry.title-geometry.chat)<1,JSON.stringify(geometry));
    assert.ok(geometry.contrast >= 4.5,JSON.stringify(geometry)); assert.equal(geometry.icon,'ph-pencil-simple');
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    await new Promise(r=>setTimeout(r,200));
    const points=await js(`[...document.querySelectorAll('.project-group > .sess')].map(row=>{const r=row.getBoundingClientRect();return {x:Math.round(r.left+35),y:Math.round(r.top+r.height/2)}})`);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...points[0]});
    await new Promise(r=>setTimeout(r,25));
    win.webContents.sendInputEvent({type:'mouseMove',...points[2],y:points[2].y+12});
    await new Promise(r=>setTimeout(r,40));
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...points[2],y:points[2].y+12});
    await new Promise(r=>setTimeout(r,40));
    const moved=await js(`[...document.querySelectorAll('.project-group > .sess')].map(row=>row.dataset.id)`);
    assert.deepEqual(moved,['task-1','task-2','task-0','task-3','task-4']);
    assert.equal(await js(`document.querySelector('.sess.is-sel') === null`),true);
    await new Promise(r=>setTimeout(r,200));
    await screenshot('sidebar.png');
    win.webContents.setZoomFactor(1.17);
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'),true);
    await screenshot('sidebar-base-zoom.png');
    win.webContents.setZoomFactor(1);
    await js(`document.querySelector('.project-show-more').click()`);
    assert.equal(await js(`document.querySelectorAll('.project-group > .sess').length`),13);
    await js(`document.querySelector('[data-tab="setup"]').click()`);
    assert.equal(await js(`document.querySelector('[data-panel="setup"]').classList.contains('is-active')`),true);
    // Setup is a stepped wizard, one step on screen at a time: there is no guide to collapse.
    assert.equal(await js(`!!document.querySelector('#wizard > li.step.is-current')`),true);
    await new Promise(r=>setTimeout(r,200));
    await screenshot('setup-clean.png');
    await js(`document.getElementById('workspaceSettings').click()`);
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    assert.equal(await js('document.getElementById("quickSettingsDialog").open'), true);
    const languageLayouts = [];
    for(const [width,zoom] of [[1100,1],[800,1],[1100,1.17],[800,1.17],[1100,1.5]]) {
      win.setSize(width,900); win.webContents.setZoomFactor(zoom);
      await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      const languageBounds = await js(`(() => {const select=document.getElementById('uiLanguage'),row=select.closest('.quick-setting'),r=row.getBoundingClientRect(),s=select.getBoundingClientRect(),p=document.getElementById('quickSettingsDialog').getBoundingClientRect();return {visible:select.checkVisibility(),inside:r.left>=p.left-1&&r.right<=p.right+1,control:s.width>0&&s.right<=p.right+1,overflow:row.scrollWidth>row.clientWidth+1}})()`);
      assert.ok(languageBounds.visible && languageBounds.inside && languageBounds.control && !languageBounds.overflow,
        JSON.stringify({width,zoom,languageBounds}));
      languageLayouts.push({width,zoom,...languageBounds});
    }
    win.setSize(1100,900);win.webContents.setZoomFactor(1);
    await js(`document.querySelector('[data-settings-go="appearance"]').click()`);
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    // Wake the hidden fixture's compositor before retaining the final frame.
    await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    await new Promise(r=>setTimeout(r,250));
    fs.writeFileSync(path.join(output,'settings-preferences.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());
    await js(`document.getElementById('newChat').click(); document.querySelector('[data-project-id="demo-project"] summary').click()`);
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const projectPoints = await js(`[...document.querySelectorAll('.project-heading')].map(heading=>{const r=heading.getBoundingClientRect();return {x:Math.round(r.left+35),y:Math.round(r.top+r.height/2)}})`);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...projectPoints[1]});
    win.webContents.sendInputEvent({type:'mouseMove',...projectPoints[0],y:projectPoints[0].y-8});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...projectPoints[0],y:projectPoints[0].y-8});
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const projectOrder = `[...document.querySelectorAll('.project-group')].map(group=>group.dataset.projectId)`;
    assert.deepEqual(await js(projectOrder),['second-project','demo-project']);
    assert.equal(await js(`document.querySelectorAll('[data-project-id="demo-project"] > .sess').length`),13);
    assert.equal(await js(`document.querySelector('.sess.is-sel') === null`),true);
    await js(`document.querySelector('[data-project-id="second-project"] summary').focus()`);
    for(const type of ['keyDown','keyUp']) win.webContents.sendInputEvent({type,keyCode:'Down',modifiers:['alt']});
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    assert.deepEqual(await js(projectOrder),['demo-project','second-project']);
    assert.equal(await js(`document.activeElement.closest('.project-group').dataset.projectId`),'second-project');
    for(const type of ['keyDown','keyUp']) win.webContents.sendInputEvent({type,keyCode:'Up',modifiers:['alt']});
    await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    assert.deepEqual(await js(projectOrder),['second-project','demo-project']);
    await win.loadURL(server.resolvedUrls.local[0]+'fixture.html');
    for(let i=0;i<100 && !(await js('!!window.fixtureReady && document.querySelectorAll(".project-group").length === 2'));i++) await new Promise(r=>setTimeout(r,25));
    assert.deepEqual(await js(projectOrder),['second-project','demo-project']);
    await screenshot('project-order-restored.png');
    console.log(JSON.stringify({projectDisclosure:{initiallyCollapsed:true,pointer:true,space:true,enter:true},geometry,drag:moved,projectOrder:{pointer:true,keyboard:true,restored:true},showMore:13,collapse:true,languageLayouts,output}));
  } finally { win?.destroy(); await server.close(); app.quit(); }
}).catch(error=>{console.error(error);app.exit(1)});
