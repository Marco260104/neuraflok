const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

module.exports = async function runRecordingCheck({ root, win, args }) {
  const recordingAt = args.indexOf('--recording');
  if (recordingAt < 0) return null;
  const recordingPath = args[recordingAt + 1];
    if (!recordingPath) throw new Error('--recording requires an event snapshot path');
    const recording = JSON.parse(fs.readFileSync(recordingPath, 'utf8'));
    const source = Array.isArray(recording) ? recording : recording.events;
    assert.ok(Array.isArray(source) && source.length > 0 && source.every(row =>
      row && Number.isFinite(row.seq) && typeof row.kind === 'string'), 'Recording must contain stored events');
    const compiled = require('esbuild').transformSync(fs.readFileSync(path.join(root, 'contracts/chronology.ts'), 'utf8'),
      { loader: 'ts', format: 'cjs' }).code;
    const module = { exports: {} }; new Function('module', 'exports', compiled)(module, module.exports);
    const { chronological, projectTimeline, positionOf } = module.exports;
    const turns = {};
    for (const row of [...source].sort((a,b)=>a.seq-b.seq)) {
      if (row.kind === 'turn_start' && row.turnId && !turns[row.turnId]) turns[row.turnId] = {origin:positionOf(row),time:row.time};
      if (row.kind === 'turn_end' && turns[row.turnId]) turns[row.turnId].endTime = Math.max(turns[row.turnId].endTime || 0,row.time);
    }
    const projected = projectTimeline(source, recording.summary?.timelineTurns ?? turns, recording.summary?.requestTurns);
    const keys = [...new Set(chronological(projected).flatMap(row => {
      if (row.kind === 'user_message' && row.inputId) return ['input:'+row.inputId];
      if (row.kind === 'tool_call') return [`message:tool_call\u0000${row.call.callId}`];
      return ['user_message','assistant_message'].includes(row.kind) && row.messageId
        ? [`message:${row.kind}\u0000${row.messageId}`] : [];
    }))];
    await win.webContents.executeJavaScript(`(async()=>{
      document.getElementById('newChat').click();await frame();
      fixture.history.splice(0,fixture.history.length,...${JSON.stringify(projected)});
      fixture.inputs=[];fixture.session.events=fixture.history.length;fixture.session.updatedAt++;
      // Use a distinct recording identity instead of reusing the synthetic history window.
      fixture.session.id='recorded-fixture';fixture.signal();
      window.recordingOrder = new Map(${JSON.stringify(keys)}.map((key,index)=>[key,index]));
      await waitFor(()=>document.querySelector('#sessionList [data-id="recorded-fixture"]'));
      document.querySelector('#sessionList [data-id="recorded-fixture"]').click();
      await waitFor(()=>document.querySelectorAll('#timeline [data-timeline-key]').length>0);await frame();
    })()`);
    const recorded = await win.webContents.executeJavaScript(`(async()=>{
      const pane=document.getElementById('chatBody'),timeline=document.getElementById('timeline');
      const steps=[];
      const order=()=>[...timeline.querySelectorAll('[data-timeline-key]')]
        .map(row=>row.dataset.timelineKey).filter(key=>recordingOrder.has(key));
      const checkOrder=()=>{
        const keys=order();
        if(new Set(keys).size!==keys.length) throw new Error('Duplicate canonical recording row');
        for(let i=1;i<keys.length;i++) if(recordingOrder.get(keys[i-1])>recordingOrder.get(keys[i]))
          throw new Error('Recording order changed across a history boundary');
      };
      checkOrder();
      for(const direction of [-1,1]) for(let stage=0;stage<Math.ceil(fixture.history.length/30)+5;stage++) {
        pane.scrollTop=direction<0?0:pane.scrollHeight;await frame();
        const edge=pane.getBoundingClientRect().top;
        const anchor=[...timeline.querySelectorAll('[data-timeline-key]')].find(row=>{
          const rect=row.getBoundingClientRect();return !row.matches('.tool-group[open]') && rect.height>0 && rect.bottom>edge && rect.top<edge+pane.clientHeight;
        });
        const before=anchor?.getBoundingClientRect().top-edge;
        const reads=fixture.reads.length;
        pane.dispatchEvent(new WheelEvent('wheel',{deltaY:direction*100}));await frame();
        if(fixture.reads.length===reads) break;
        checkOrder();
        const after=anchor?.getBoundingClientRect().top-pane.getBoundingClientRect().top;
        if(anchor && (!anchor.isConnected || Math.abs(after-before)>2))
          throw new Error('Recording viewport changed on '+direction+' page '+stage+': '+JSON.stringify({key:anchor.dataset.timelineKey,before,after,connected:anchor.isConnected}));
        steps.push({direction,stage,rows:timeline.querySelectorAll('.ev').length,drift:anchor?Math.abs(after-before):0});
      }
      const retained=order();
      const listReads=fixture.listReads;fixture.signal();await waitFor(()=>fixture.listReads>listReads);await frame();checkOrder();
      if(JSON.stringify(order())!==JSON.stringify(retained)) throw new Error('Idle recording refresh reordered resident history');
      const question=[...timeline.querySelectorAll('.ev-user_message')].at(-1);
      question?.scrollIntoView({block:'center'});await frame();
      return {sourceRows:fixture.history.length,residentRows:retained.length,expectedRows:recordingOrder.size,
        missing:fixture.history.filter(row=>row.kind==='tool_call' ? !retained.some(key=>key.endsWith(row.call.callId)) :
          ['user_message','assistant_message'].includes(row.kind) && row.messageId && !retained.some(key=>key.endsWith(row.inputId ?? row.messageId)))
          .map(row=>({kind:row.kind,tool:row.call?.tool,seq:row.seq})),
        steps,maxDrift:Math.max(0,...steps.map(step=>step.drift))};
    })()`);
    const screenshotPath = path.join(root, '.local', 'recorded-transcript-scroll.png');
    fs.mkdirSync(path.dirname(screenshotPath), {recursive:true});
    fs.writeFileSync(screenshotPath, (await win.webContents.capturePage()).toPNG());
    assert.ok(recorded.steps.length > 0 || recorded.residentRows === recorded.expectedRows,
      'The recorded transcript must exercise paging or already contain every canonical row: '+JSON.stringify(recorded));
    console.log(JSON.stringify({recorded,screenshot:screenshotPath},null,2));
  return recorded;
};
