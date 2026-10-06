const assert = require('node:assert/strict');

module.exports = async function runRefreshChecks(win, { initial, older, stages }) {
  const historicalRefresh=await win.webContents.executeJavaScript(`(async()=>{
    const listBefore=fixture.listReads;fixture.signal();
    await waitFor(()=>fixture.listReads>listBefore);await frame();
    return {...geometry(),listBefore,listAfter:fixture.listReads};
  })()`);
  assert.ok(historicalRefresh.listAfter>historicalRefresh.listBefore,'Historical refresh must perform a list read');
  assert.equal(historicalRefresh.readerTop,older.readerTop,'Historical repaint preserves the underfilled tail reserve');
  const observations=[{phase:'initial',...initial},...stages.map((stage,index)=>({phase:'older-'+index,...stage}))];
  for(let cycle=0;cycle<4;cycle++) {
    const before=await win.webContents.executeJavaScript('geometry()');
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',x:before.x,y:before.y,deltaY:cycle%2 ? -100 : 100,deltaX:0});
    await new Promise(resolve=>setTimeout(resolve,150));
    const after=await win.webContents.executeJavaScript('geometry()');
    assert.ok(after.readerPresent && Math.abs(after.readerTop-before.readerTop)<=110,'Direction reversal stays within the wheel distance');
    assert.ok(after.height > 4000,'Returning to the tail must retain the adjacent long row instead of collapsing the scrollbar');
    observations.push({phase:'reverse-'+cycle,...after});
  }
  const latest=await win.webContents.executeJavaScript(`(async()=>{
    const readBefore=fixture.reads.length;
    const pane=document.getElementById('chatBody');
    for(let i=0;i<4;i++){
      pane.scrollTop=pane.scrollHeight;
      pane.dispatchEvent(new WheelEvent('wheel',{deltaY:100}));
      await frame();
    }
    return {...geometry(),banner:!!document.querySelector('[data-history="latest"]'),readBefore,readAfter:fixture.reads.length};
  })()`);
  assert.equal(latest.banner,false,'History navigation never renders a Back to latest banner');
  const refresh=await win.webContents.executeJavaScript(`(async()=>{
    const before=geometry();
    const readBefore=fixture.reads.length;
    fixture.add({kind:'assistant_message',messageId:'live-new',message:{text:'New live work',truncated:false,chars:13},state:'final',final:true});
    fixture.signal();
    await waitFor(()=>fixture.reads.length>readBefore&&[...document.querySelectorAll('.ev-assistant_message')].some(row=>row.textContent.includes('New live work')));
    await frame();
    return {before,after:geometry(),readBefore,readAfter:fixture.reads.length,
      inserted:[...document.querySelectorAll('.ev-assistant_message')].some(row=>row.textContent.includes('New live work'))};
  })()`);
  assert.ok(refresh.readAfter>refresh.readBefore,'Live refresh must perform a session read');
  assert.equal(refresh.inserted,true,'Live refresh must render the inserted assistant row');
  assert.ok(refresh.after.records>refresh.before.records,'Live refresh must add a rendered record');
  assert.ok(refresh.after.readerPresent,'Live deltas retain the reader');
  if(refresh.before.bottomGap<=1) assert.ok(refresh.after.bottomGap<=1,'A live refresh at the bottom must continue following it');
  else assert.ok(Math.abs(refresh.after.readerTop-refresh.before.readerTop)<2,'A live refresh must preserve the deliberate reader row');
  const bottomRefresh=await win.webContents.executeJavaScript(`(async()=>{
    const pane=document.getElementById('chatBody');pane.scrollTop=pane.scrollHeight;await frame();
    const before=geometry(),readBefore=fixture.reads.length;fixture.signal();
    await waitFor(()=>fixture.reads.length>readBefore);await frame();
    return {before,after:geometry(),readBefore,readAfter:fixture.reads.length};
  })()`);
  assert.ok(bottomRefresh.readAfter>bottomRefresh.readBefore,'Bottom refresh must perform a session read');
  assert.equal(bottomRefresh.after.readerTop,bottomRefresh.before.readerTop,'An unchanged live repaint cannot consume the tail reserve');
  await win.webContents.executeJavaScript(`(async()=>{
    document.getElementById('newChat').click();await frame();
    fixture.history.splice(0,fixture.history.length,{seq:50,time:50,source:'extension',kind:'user_message',messageId:'short',message:{text:'Short chat',chars:10,truncated:false}});
    fixture.session.events=1;
    document.querySelector('#sessionList [data-id="history-fixture"]').click();
    await waitFor(()=>document.getElementById('timeline').textContent.includes('Short chat'));await frame();
  })()`);
  const shortBefore=await win.webContents.executeJavaScript('geometry()');
  assert.equal(shortBefore.height,shortBefore.viewport,'Short conversation fits without overflow');
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',x:shortBefore.x,y:shortBefore.y,deltaY:-100,deltaX:0});
  const shortAfter=await win.webContents.executeJavaScript(`(async()=>{
    await waitFor(()=>fixture.reads.some(read=>read.before===50));await frame();
    const after=geometry();
    fixture.history.push({seq:51,time:51,source:'extension',kind:'assistant_message',messageId:'short-live',message:{text:'Still live',chars:10,truncated:false},final:true});
    fixture.signal();await waitFor(()=>document.getElementById('timeline').textContent.includes('Still live'));
    return {...after,banner:!!document.querySelector('.timeline-window-note')};
  })()`);
  assert.equal(shortAfter.top,0,'Wheel-up cannot scroll a fitting conversation');
  assert.equal(shortAfter.height,shortAfter.viewport,'Empty history does not create overflow');
  assert.equal(shortAfter.banner,false,'Short conversation never shows a navigation banner');
  return { historicalRefresh, observations, latest, refresh, bottomRefresh, shortAfter };
};
