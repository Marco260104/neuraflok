const assert = require('node:assert/strict');
const path = require('node:path');
const { readRendererStyleSource } = require('./read-renderer-style-source.cjs');

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
    env,
    encoding: 'utf8',
    windowsHide: true
  });
  process.stdout.write(child.stdout || '');
  process.stderr.write(child.stderr || '');
  process.exit(child.status ?? 1);
}

const { app, BrowserWindow } = require('electron');
const widths = [800, 360, 220];

function createMarkup(css) {
  return `<style>${css}</style><main id="fixture" style="margin:20px">
    <article class="msg rich"><div class="markdown-table"><table><tbody></tbody></table></div></article>
    </main>`;
}

function ordinaryTableScript(width) {
  return `(async () => {
    const width = ${width};
    const fixture = document.getElementById('fixture');
    const viewport = document.querySelector('.markdown-table');
    const table = viewport.querySelector('table');
    fixture.style.width = width + 'px';
    table.innerHTML = '<tbody><tr><th>Area</th><th>Status</th><th>Details</th></tr><tr><td>Great Hall</td><td>Browser acceptance passed with remaining visual refinements</td><td>' + 'long_filename_'.repeat(30) + '</td></tr></tbody>';
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const text = table.rows[1].cells[1];
    return {
      width,
      tableWidth: table.getBoundingClientRect().width,
      textHeight: text.getBoundingClientRect().height,
      outsideOverflow: fixture.scrollWidth > fixture.clientWidth
    };
  })()`;
}

async function measureManyColumns(window) {
  return window.webContents.executeJavaScript(`(async () => {
    const fixture = document.getElementById('fixture');
    const viewport = document.querySelector('.markdown-table');
    const table = viewport.querySelector('table');
    table.innerHTML = '<tbody><tr>' + '<td>column</td>'.repeat(80) + '</tr></tbody>';
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      outsideOverflow: fixture.scrollWidth > fixture.clientWidth,
      localScroll: viewport.scrollWidth > viewport.clientWidth
    };
  })()`);
}

async function verifyTableLayouts() {
  const window = new BrowserWindow({
    show: false,
    width: 1100,
    height: 800,
    webPreferences: { offscreen: true }
  });
  const css = readRendererStyleSource(path.resolve(__dirname, '..'));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(createMarkup(css))}`);
  try {
    for (const width of widths) {
      const result = await window.webContents.executeJavaScript(ordinaryTableScript(width));
      assert.equal(result.outsideOverflow, false, `A ${width}px table must stay inside its message column`);
      assert.ok(result.tableWidth <= width + 1, `A ${width}px table must fit its available width`);
      assert.ok(result.textHeight > 50, `Long cell content must wrap at ${width}px`);
    }
    const dense = await measureManyColumns(window);
    assert.equal(dense.outsideOverflow, false, 'A dense table must not widen the transcript');
    assert.equal(dense.localScroll, true, 'A dense table must scroll inside its own viewport');
  } finally {
    window.destroy();
  }
  console.log('Markdown tables fit narrow columns, wrap long content, and keep dense grids locally scrollable.');
}

app.whenReady().then(verifyTableLayouts).then(() => app.exit(0)).catch(error => {
  console.error(error);
  app.exit(1);
});
