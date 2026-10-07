const assert = require('node:assert/strict');

module.exports = async function runRevisedHistoryCheck(win) {
  const revisedHistory=await win.webContents.executeJavaScript(`(async()=>{
    document.getElementById('newChat').click();await frame();
    fixture.history.splice(0,fixture.history.length,...Array.from({length:360},(_,i)=>({
      seq:i+1,time:1,source:'extension',kind:'user_message',messageId:'position-'+i,
      message:{text:'History position '+(i+1),chars:25,truncated:false}})));
    fixture.history[99]={seq:1000,origin:100,time:1,source:'extension',kind:'assistant_message',messageId:'review',
      message:{text:'Detailed review with ratings. '.repeat(650),chars:18850,truncated:false},final:true};
    fixture.inputs=[{id:'old',sessionId:'history-fixture',text:'Already delivered input',state:'sent',mode:'auto',
      createdAt:100,deliveredAt:110,messageId:'input:old',historyAnchored:true,historyRecorded:true,historySeq:50},
      {id:'waiting',sessionId:'history-fixture',text:'Still waiting input',state:'queued',mode:'auto',createdAt:100,dueAt:100}];
    fixture.session.events=1000;
    document.querySelector('#sessionList [data-id="history-fixture"]').click();
    await waitFor(()=>document.getElementById('timeline').textContent.includes('History position 360'));
    fixture.signal();await waitFor(()=>document.getElementById('inputQueue').textContent.includes('Still waiting input'));
    const pane=document.getElementById('chatBody'),timeline=document.getElementById('timeline');
    const checks=[];
    for(let i=0;i<12&&!timeline.textContent.includes('Detailed review');i++) {
      pane.scrollTop=0;await frame();const count=fixture.reads.length;
      pane.dispatchEvent(new WheelEvent('wheel',{deltaY:-100}));
      await waitFor(()=>fixture.reads.length>count);await frame();
      checks.push(fixture.reads.at(-1));
    }
    const present=timeline.textContent.includes('Detailed review');
    const reads=fixture.reads.length;
    // Panel departure/return performs the same production refresh path.
    chat.chatVisible(false);chat.chatVisible(true);await frame();
    return {present,afterReturn:timeline.textContent.includes('Detailed review'),checks,reads,
      queue:document.getElementById('inputQueue').textContent,
      copies:timeline.querySelectorAll('.ev-assistant_message').length};
  })()`);
  assert.equal(revisedHistory.present,true,'A revised long answer remains reachable by its original history page');
  assert.equal(revisedHistory.afterReturn,true,'Returning to the chat retains the long answer');
  assert.equal(revisedHistory.copies,1,'The long answer has one canonical row');
  assert.ok(!revisedHistory.queue.includes('Already delivered input'),'Old timestamps cannot resurrect a committed input in the queue');
  assert.ok(revisedHistory.queue.includes('Still waiting input'),'The actual waiting input stays visible');
  assert.ok(await win.webContents.executeJavaScript('fixture.reads.every(read => read.limit === 30)'),
    'Opening, history navigation and live deltas all use 30-row requests');
  return revisedHistory;
};
