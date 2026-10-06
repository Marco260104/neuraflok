const { readRendererMarkup } = require('./read-renderer-markup.cjs');
/** Current composer markup/CSS in offscreen Chromium; no installed app interaction. */
const fs = require('node:fs');
const path = require('node:path');
const { readRendererStyleSource } = require('./read-renderer-style-source.cjs');
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], { env, encoding: 'utf8', windowsHide: true });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { offscreen: true } });
  const html = readRendererMarkup(path.resolve(__dirname, '..'));
  const composer = html.match(/<form class="composer"[\s\S]*?<\/form>/)[0];
  const css = readRendererStyleSource(path.join(__dirname, '..')) + '\n' +
    readRendererStyleSource(path.join(__dirname, '..'), 'neuraflok.css');
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<style>${css}</style><div id="fixture" style="margin:250px 20px 0">${composer}</div>`));
  const results = await win.webContents.executeJavaScript(`(async () => {
    const fixture = document.getElementById('fixture');
    const rect = selector => document.querySelector(selector).getBoundingClientRect();
    const output = [];
    document.getElementById('contextMeter').classList.add('pinned');
    // 560px is below the narrowest real composer: the 640px minimum window leaves it about 600px wide.
    for (const width of [1000, 640, 560]) for (const images of [false, true]) {
      fixture.style.width = width + 'px';
      const attachments = document.getElementById('composerImages');
      attachments.hidden = !images;
      attachments.textContent = 'Example image'; attachments.style.height = '60px';
      await new Promise(resolve => requestAnimationFrame(resolve));
      const add = rect('#attachmentMenu > summary'), access = rect('#composerAccess > summary'), terminal = rect('#toggleTerminal');
      const circle = rect('#contextMeterButton'), tooltip = rect('#contextMeterInfo'), model = rect('#chatModelPickerTrigger'), input = rect('#chatInput'), send = rect('#chatSend');
      output.push({width, images,
        leftOrder: add.right <= access.left + 1 && access.right <= terminal.left + 1,
        modelRightOfContext: model.left >= circle.right + 4,
        sendRightOfModel: model.right <= send.left - 4,
        centerDifference: Math.abs((circle.top + circle.bottom - model.top - model.bottom) / 2),
        tooltipEdgeDifference: Math.abs(tooltip.right - circle.right),
        tooltipInViewport: tooltip.left >= 0 && tooltip.right <= document.documentElement.clientWidth && tooltip.top >= 0 && tooltip.bottom <= document.documentElement.clientHeight,
        toolbarBelowInput: circle.top >= input.bottom, sendAligned: Math.abs((send.top + send.bottom - circle.top - circle.bottom) / 2) < 1, overflow: fixture.scrollWidth > fixture.clientWidth});
    }
    return output;
  })()`);
  for (const row of results) {
    // The composer keeps workspace actions at left, context in the middle, and the model beside Send.
    assert.equal(row.leftOrder, true, JSON.stringify(row));
    assert.equal(row.modelRightOfContext, true, JSON.stringify(row));
    assert.equal(row.sendRightOfModel, true, JSON.stringify(row));
    assert.ok(row.centerDifference < 1, 'Context indicator and model picker share their toolbar row');
    assert.ok(row.tooltipEdgeDifference < 1, 'Context dialog is right-aligned to the context circle');
    assert.equal(row.tooltipInViewport, true, 'Tooltip remains within the visible viewport');
    assert.equal(row.toolbarBelowInput, true);
    assert.equal(row.sendAligned, true);
    assert.equal(row.overflow, false);
  }
  console.log('Composer geometry passed at 1000/640/560px with/without attachments: add/access/Terminal at left, context in the middle, model and Send at right.');
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
