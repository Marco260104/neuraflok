const assert = require('node:assert/strict');
const path = require('node:path');
const { readRendererStyleSource } = require('./read-renderer-style-source.cjs');

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], {
    env,
    encoding: 'utf8',
    windowsHide: true
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = require('electron');
const layouts = [
  { scale: 1, widths: [1100, 760, 500] },
  { scale: 1.17, widths: [1100, 760, 500] },
  { scale: 1.5, widths: [1100, 760, 500] }
];

function fixtureMarkup(styles) {
  return `<style>${styles}</style>
    <main id="fixture"><section id="chatBody" class="scroll"><div id="timelineContent" class="view" data-view="timeline">
    <div id="timeline"><button class="timeline-window-note" hidden>Back to latest</button>
    <article class="ev"><div class="ev-body"><p class="msg" id="prose"></p></div></article>
    <details class="tool-group"><summary>Refused to run a tool</summary><div class="tool-group-body" style="height:400px">Recorded tool details</div></details>
    <article class="ev ev-tool_call"><div class="ev-body"><details class="tool tone-good"><summary><b>Edited 2 files</b><span class="metric"><span class="metric-added">+28</span> <span class="metric-removed">−11</span></span></summary></details></div></article>
    </div></div></section></main>`;
}

function measureScript(width) {
  return `(async () => {
    const fixture = document.getElementById('fixture');
    const pane = document.getElementById('chatBody');
    const timeline = document.getElementById('timelineContent');
    const prose = document.getElementById('prose');
    const disclosure = document.querySelector('.tool-group');
    const history = document.querySelector('.timeline-window-note');
    fixture.style.width = '${width}px';
    prose.textContent = 'Transcript layout remains stable when activity expands, history opens, and the timeline returns to its end. '.repeat(4);
    disclosure.open = false;
    history.hidden = true;
    timeline.style.removeProperty('--timeline-scroll-reserve');
    pane.style.height = 'auto';
    pane.style.height = (pane.scrollHeight + 5) + 'px';
    const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const capture = name => {
      const text = document.createRange();
      text.selectNodeContents(prose);
      const rect = prose.getBoundingClientRect();
      return { name, width: rect.width, left: rect.left, lines: [...text.getClientRects()].map(row => row.width), overflow: pane.scrollHeight > pane.clientHeight };
    };
    const states = [];
    await paint();
    states.push(capture('closed'));
    disclosure.open = true;
    await paint();
    states.push(capture('expanded'));
    pane.scrollTop = 60;
    history.hidden = false;
    await paint();
    states.push(capture('history'));
    disclosure.open = false;
    timeline.style.setProperty('--timeline-scroll-reserve', '500px');
    await paint();
    states.push(capture('reserved-tail'));
    history.hidden = true;
    timeline.style.removeProperty('--timeline-scroll-reserve');
    pane.scrollTop = pane.scrollHeight;
    await paint();
    states.push(capture('latest'));
    return states;
  })()`;
}

async function checkToolDiffPresentation(window) {
  return window.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('.ev-tool_call .ev-body');
    const summary = row.querySelector('summary');
    const label = summary.querySelector('b');
    const metric = summary.querySelector('.metric');
    const added = metric.querySelector('.metric-added');
    const removed = metric.querySelector('.metric-removed');
    const success = document.createElement('span');
    const danger = document.createElement('span');
    success.style.color = 'var(--green)';
    danger.style.color = 'var(--red)';
    document.body.append(success, danger);
    const result = {
      leadingBleed: row.getBoundingClientRect().left - summary.getBoundingClientRect().left,
      trailingBleed: summary.getBoundingClientRect().right - row.getBoundingClientRect().right,
      labelInset: label.getBoundingClientRect().left - summary.getBoundingClientRect().left,
      metricInset: summary.getBoundingClientRect().right - metric.getBoundingClientRect().right,
      added: getComputedStyle(added).color,
      removed: getComputedStyle(removed).color,
      success: getComputedStyle(success).color,
      danger: getComputedStyle(danger).color
    };
    success.remove();
    danger.remove();
    return result;
  })()`);
}

async function runLayoutChecks() {
  const window = new BrowserWindow({
    show: false,
    width: 1500,
    height: 1000,
    webPreferences: { offscreen: true }
  });
  const styles = readRendererStyleSource(path.resolve(__dirname, '..'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fixtureMarkup(styles))}`);
  const results = [];
  try {
    for (const layout of layouts) {
      window.webContents.setZoomFactor(layout.scale);
      for (const width of layout.widths) {
        const states = await window.webContents.executeJavaScript(measureScript(width));
        const closed = states[0];
        assert.equal(closed.overflow, false, 'Transcript fixture must start without vertical overflow');
        assert.equal(states[1].overflow, true, 'Opening a tool disclosure must add vertical overflow');
        assert.equal(states.at(-1).overflow, false, 'Returning to the newest message must clear vertical overflow');
        for (const state of states.slice(1)) {
          assert.equal(state.width, closed.width, `Transcript width changed at scale ${layout.scale} and viewport ${width}`);
          assert.equal(state.left, closed.left, `Transcript position changed during ${state.name}`);
          assert.deepEqual(state.lines, closed.lines, `Transcript wrapping changed during ${state.name}`);
        }
        const diff = await checkToolDiffPresentation(window);
        assert.ok(diff.leadingBleed >= 9.5 && diff.trailingBleed >= 9.5, 'Diff disclosure highlight must extend beyond its text column');
        assert.ok(diff.labelInset >= 9.5 && diff.metricInset >= 9.5, 'Diff disclosure highlight must keep readable inner spacing');
        assert.equal(diff.added, diff.success, 'Added lines must use the success color');
        assert.equal(diff.removed, diff.danger, 'Removed lines must use the danger color');
        results.push({ scale: layout.scale, viewport: width, phases: states.length });
      }
    }
  } finally {
    window.destroy();
  }
  console.log(JSON.stringify(results));
  console.log('Transcript layout passed across disclosure, history, scroll reserve, zoom, and viewport states.');
}

app.whenReady().then(runLayoutChecks).then(() => app.exit(0)).catch(error => {
  console.error(error);
  app.exit(1);
});
