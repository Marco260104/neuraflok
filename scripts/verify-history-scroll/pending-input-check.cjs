const assert = require('node:assert/strict');

module.exports = async function runPendingInputCheck(win) {
  const interjection = await win.webContents.executeJavaScript(`(async()=>{
    fixture.inputs=[{id:'interjection',sessionId:'history-fixture',text:'Pending correction beside current tools',
      delivery:'tool',mode:'auto',state:'queued',createdAt:52,dueAt:52}];
    fixture.signal();await waitFor(()=>document.querySelector('#inputQueue .pending-message'));await frame();
    const pane=document.getElementById('chatBody'),timeline=document.getElementById('timeline');
    const root=document.getElementById('timelineContent')||timeline;
    // A legitimate underfilled-page reserve must stay below the entire transcript, including the input which is still awaiting its first tool receipt.
    root.style.setProperty('--timeline-scroll-reserve','600px');
    pane.scrollTop=pane.scrollHeight;await frame();
    const pending=document.querySelector('#inputQueue .pending-message');
    for(const animation of pending.getAnimations()) animation.finish();
    await frame();
    const last=timeline.lastElementChild;
    const gap=pending.getBoundingClientRect().top-last.getBoundingClientRect().bottom;
    const before=pending.getBoundingClientRect().top,scrollBefore=pane.scrollTop;
    pane.dispatchEvent(new WheelEvent('wheel',{deltaY:-80}));
    pane.scrollTop=Math.max(0,scrollBefore-80);await frame();
    const movement=pending.getBoundingClientRect().top-before;
    const pendingBeforeDelivery=pending.getBoundingClientRect().top;
    const count=()=>[...document.querySelectorAll('#timeline .said.is-user,#inputQueue .pending-message')]
      .filter(row=>row.textContent.includes('Pending correction beside current tools')).length;
    fixture.history.push({seq:52,time:52,source:'app',kind:'user_message',messageId:'input:interjection',inputId:'interjection',
      message:{text:fixture.inputs[0].text,chars:45,truncated:false}});
    fixture.inputs[0]={...fixture.inputs[0],state:'tool',messageId:'input:interjection',offeredAt:52,historyAnchored:true,historySeq:52};
    fixture.signal();await waitFor(()=>!document.querySelector('#inputQueue .pending-message'));await frame();
    const delivered=[...timeline.querySelectorAll('[data-timeline-key]')].find(row=>row.dataset.timelineKey==='input:interjection')?.querySelector('.user-message-text');
    return {gap,movement,scrollDelta:scrollBefore-(scrollBefore-80<0?0:scrollBefore-80),copies:count(),
      deliveryDrift:delivered?Math.abs(delivered.getBoundingClientRect().top-pendingBeforeDelivery):null};
  })()`);
  assert.ok(interjection.gap >= 0 && interjection.gap < 60,
    'Pending interjection stays adjacent to transcript content, never beyond reserved empty space: '+JSON.stringify(interjection));
  assert.ok(Math.abs(interjection.movement-interjection.scrollDelta)<2,'Pending interjection moves with the transcript');
  assert.equal(interjection.copies,1,'First tool delivery keeps exactly one interjection');
  assert.ok(interjection.deliveryDrift!==null && interjection.deliveryDrift<2,
    'First tool delivery preserves the interjection position: '+JSON.stringify(interjection));
  return interjection;
};
