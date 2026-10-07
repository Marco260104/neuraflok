const { readRendererMarkup } = require('../read-renderer-markup.cjs');
const { readRendererStyleSource } = require('../read-renderer-style-source.cjs');
const path = require('node:path');

module.exports = async function createRendererFixture({ root, BrowserWindow, show }) {
  const built = await require('esbuild').build({ entryPoints: [path.join(root, 'frontend/features/chat/chat.ts')],
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'chat',
    outfile: path.join(root, '.local/history-fixture.js'),
    // KaTeX's stylesheet names its fonts; this fixture draws no formulas, so they stay out.
    loader: { '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty' },
    plugins: [{ name: 'fixture-url-assets', setup(build) {
      build.onResolve({ filter: /\?url$/ }, args => ({ path: args.path, namespace: 'fixture-url' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture-url' }, () => ({ contents: 'export default "";', loader: 'js' }));
    } }] });
  const code = built.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = readRendererStyleSource(root) +
    built.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  const html = readRendererMarkup(root)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '')
    .replace('</head>', `<style>${css}</style></head>`);
  const win = new BrowserWindow({ show, title: 'NEURAFLOK history scroll verification', width: 1400, height: 1000,
    webPreferences: { sandbox: true, backgroundThrottling: false, offscreen: !show } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await win.webContents.executeJavaScript(`(() => {
    const ok = data => Promise.resolve({ok:true, data});
    const text = value => ({text:value, truncated:false, chars:value.length});
    let sessionChanged = null;
    const history = [];
    const add = event => { const seq=history.length+1; history.push({seq,time:seq,source:'extension',...event}); };
    add({kind:'user_message',messageId:'long-task',message:text(('The full earlier task stays above the recent work.\\n\\n').repeat(120))});
    for(let i=0;i<200;i++) add({kind:'tool_call',source:'mcp',call:{callId:'tool-'+i,tool:'read',
      args:text('{}'),result:text('Recorded tool output. '.repeat(50)),outcome:'ok',durationMs:1,
      attribution:'request_id',summary:{kind:'read',title:'Read file '+i,tone:'neutral'}}});
    for(let i=0;i<8;i++) add({kind:'assistant_message',messageId:'recent-'+i,message:text('Recent visible message '+i),state:'final',final:true});
    const session={id:'history-fixture',title:'Dense history fixture',conversationId:'fixture',chatIds:['fixture'],
      startedAt:1,updatedAt:1,endedAt:null,events:history.length,userMessages:1,toolCalls:200,
      errors:0,estimatedTokens:0,contextTokens:0,agents:[],origin:null};
    window.fixture={history,session,inputs:[],reads:[],listReads:0,
      add:event=>{add(event);session.events=history.length;session.updatedAt++;},
      // Every synthetic write belongs to this one session, so its push names that owner.
      signal:()=>{if(!sessionChanged)throw new Error('onSessionChanged was not registered');sessionChanged({sessionIds:[session.id]});}};
    window.api=new Proxy({
      listSessions:()=>{fixture.listReads++;return ok({sessions:[session],activeId:null,blocked:[],pressure:[]})},
      listProjects:()=>ok([]),listInputs:()=>ok(fixture.inputs),runningTools:()=>ok([]),listPausedHelpers:()=>ok([]),
      onSessionChanged:handler=>{sessionChanged=handler;return()=>{if(sessionChanged===handler)sessionChanged=null;}},
      getSession:(_id,options)=>{
        fixture.reads.push(options);
        const position=e=>e.origin??e.seq;
        const eligible=history.filter(e=>(options.from===undefined||e.seq>=options.from)&&(options.before===undefined||position(e)<options.before)&&(options.after===undefined||position(e)>options.after))
          .sort((a,b)=>options.from===undefined?position(a)-position(b):a.seq-b.seq);
        const events=options.from===undefined&&options.after===undefined?eligible.slice(-options.limit):eligible.slice(0,options.limit);
        return ok({summary:session,total:history.length,events,nextFrom:events.reduce((n,e)=>Math.max(n,e.seq+1),options.from??0)});
      }
    },{get:(target,key)=>target[key]??(()=>ok(null))});
    window.frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    window.waitFor=async predicate=>{
      const deadline=performance.now()+5000;
      while(performance.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,25));}
      throw new Error('Timed out waiting for synthetic session refresh: '+JSON.stringify({reads:fixture.reads.slice(-10),geometry:geometry(),users:document.querySelectorAll('#timeline .ev-user_message').length}));
    };
    window.geometry=()=>{
      const pane=document.getElementById('chatBody'),timeline=document.getElementById('timeline');
      const row=[...timeline.querySelectorAll('.ev-assistant_message')].find(e=>e.textContent.includes('Recent visible message 0'));
      const bounds=pane.getBoundingClientRect();
      return {top:pane.scrollTop,height:pane.scrollHeight,viewport:pane.clientHeight,
        readerTop:row?.getBoundingClientRect().top-bounds.top,readerPresent:!!row,
        groups:timeline.querySelectorAll('.tool-group').length,records:timeline.querySelectorAll('.ev').length,
        bottomGap:pane.scrollHeight-pane.clientHeight-pane.scrollTop,
        x:Math.round(bounds.right-100),y:Math.round(bounds.top+100)};
    };
  })()`);
  await win.webContents.executeJavaScript(code);
  await win.webContents.executeJavaScript(`(async()=>{
    chat.initChat({state:()=>null,save:async()=>{}});chat.chatVisible(true);await frame();
    document.querySelector('#sessionList [data-id="history-fixture"]').click();
    for(let i=0;i<120&&!geometry().readerPresent;i++) await frame();
    await waitFor(()=>document.querySelector('#timeline .ev-user_message'));
    await frame();
  })()`);
  return win;
};
