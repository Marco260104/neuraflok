const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { app, BrowserWindow } = require('electron');
const createRendererFixture = require('./renderer-fixture.cjs');
const runPagingChecks = require('./paging-checks.cjs');
const runRefreshChecks = require('./refresh-checks.cjs');
const runPendingInputCheck = require('./pending-input-check.cjs');
const runRevisedHistoryCheck = require('./revised-history-check.cjs');
const runRecordingCheck = require('./recording-check.cjs');

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 1);
}

app.whenReady().then(async () => {
  const root = path.resolve(__dirname, '../..');
  const args = process.argv.slice(2);
  const show = args.includes('--show');
  const win = await createRendererFixture({ root, BrowserWindow, show });
  win.webContents.debugger.attach('1.3');

  const paging = await runPagingChecks(win);
  const refresh = await runRefreshChecks(win, paging);
  const interjection = await runPendingInputCheck(win);
  const revisedHistory = await runRevisedHistoryCheck(win);
  const recording = await runRecordingCheck({ root, win, args });

  console.log(JSON.stringify({
    observations: refresh.observations,
    expanded: paging.expanded,
    collapsedAgain: paging.collapsedAgain,
    interjection,
    historicalRefresh: refresh.historicalRefresh,
    latest: refresh.latest,
    refresh: refresh.refresh,
    bottomRefresh: refresh.bottomRefresh,
    shortAfter: refresh.shortAfter,
  }, null, 2));
  console.log(JSON.stringify({ revisedHistory }, null, 2));
  console.log('Dense history scroll passed: real renderer, native wheel, overlap, reversals, scrollbar continuity and live refresh.');

  if (show) {
    win.webContents.debugger.detach();
    return;
  }
  win.destroy();
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
