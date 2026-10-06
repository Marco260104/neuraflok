const assert = require('node:assert/strict');

module.exports = async function runPagingChecks(win) {
  const initial = await win.webContents.executeJavaScript('geometry()');
  assert.ok(initial.viewport > 0 && initial.height > 4000, 'Opening fills visible history through collapsed batches without wheel input: '+JSON.stringify(initial));
  let older = initial;
  const stages = [];
  for (let stage = 0; stage < 10 && older.height <= 4000; stage++) {
    const before = older;
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseWheel',x:before.x,y:before.y,deltaY:-100,deltaX:0});
    await new Promise(resolve=>setTimeout(resolve,250));
    older = await win.webContents.executeJavaScript('geometry()');
    assert.ok(older.readerPresent && Math.abs(older.readerTop-before.readerTop) <= 110,
      'Each 30-row stage preserves the reader: '+JSON.stringify({before,older}));
    stages.push(older);
  }
  assert.equal(older.readerPresent,true,'Prepending must not evict the messages currently on screen');
  assert.ok(Math.abs(older.readerTop-initial.readerTop) <= 110, 'One wheel step must not jump to the earlier long task: '+JSON.stringify({initial,older}));
  assert.ok(older.height > 4000,'Earlier task must actually load above the reader: '+JSON.stringify({initial,older,reads:await win.webContents.executeJavaScript('fixture.reads')}));
  assert.equal(older.groups,1,'The overlapping activity remains one disclosure');
  const expanded = await win.webContents.executeJavaScript(`(async()=>{
    const pane=document.getElementById('chatBody'),timeline=document.getElementById('timeline');
    const group=timeline.querySelector('.tool-group');
    const collapsedHeight=group.getBoundingClientRect().height;
    group.querySelector('summary').click();await frame();
    const tools=group.querySelectorAll('.tool');
    tools[100].querySelector('summary').click();await frame();
    const output=tools[100].querySelector('.raw');
    pane.scrollTop+=output.getBoundingClientRect().top-pane.getBoundingClientRect().top-100;await frame();
    const rect=pane.getBoundingClientRect();
    return {collapsedHeight,expandedHeight:group.getBoundingClientRect().height,
      rawCount:timeline.querySelectorAll('.raw').length,top:pane.scrollTop,
      x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+160)};
  })()`);
  assert.ok(expanded.collapsedHeight<60 && expanded.expandedHeight>4000,'Group height follows its actual disclosure');
  assert.equal(expanded.rawCount,1,'Only the deliberately expanded call materializes its output');
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',x:expanded.x,y:expanded.y,deltaY:120,deltaX:0});
  await new Promise(resolve=>setTimeout(resolve,200));
  const collapsedAgain=await win.webContents.executeJavaScript(`(async()=>{
    const pane=document.getElementById('chatBody'),group=document.querySelector('#timeline .tool-group');
    const afterWheel=pane.scrollTop;
    group.querySelector('summary').click();await frame();
    const height=group.getBoundingClientRect().height;
    const hiddenOutputHeight=group.querySelector('.raw').getBoundingClientRect().height;
    pane.scrollTop=pane.scrollHeight;await frame();
    return {afterWheel,height,hiddenOutputHeight};
  })()`);
  assert.ok(Math.abs(collapsedAgain.afterWheel-expanded.top-120)<2,'Native wheel over an expanded group travels its requested distance');
  assert.equal(collapsedAgain.height,expanded.collapsedHeight,'Collapsing returns to one headline');
  assert.equal(collapsedAgain.hiddenOutputHeight,0,'Collapsed output contributes no scroll geometry');
  return { initial, older, stages, expanded, collapsedAgain };
};
