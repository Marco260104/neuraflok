// Checks that context dialog rows fit in every interface language.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { BENIGN_RENDERER_ERRORS } = require('./fixtures/app-defaults.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.tmp/context-dialog');
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/composer-ui.js'), 'utf8');
  server = await createServer({ configFile: false, root: path.join(root, './frontend'),
    cacheDir: path.join(output, 'vite'), logLevel: 'error',
    resolve: { alias: { '@phosphor-icons/web': path.join(root, 'node_modules/@phosphor-icons/web/src') } },
    server: { host: '127.0.0.1', port: 4422, strictPort: true, fs: { allow: [root] } },
    plugins: [{ name: 'ipc-fixture', transformIndexHtml(html) {
      return html.replace('</head>', '<script src="/composer-fixture.js"></script></head>');
    }, configureServer(vite) { vite.middlewares.use((req, res, next) => {
      if (req.url !== '/composer-fixture.js') return next();
      res.setHeader('Content-Type', 'text/javascript'); res.end(fixture);
    }); } }]
  });
  await server.listen();
  const win = new BrowserWindow({ show: false, width: 1440, height: 960,
    webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error' && !BENIGN_RENDERER_ERRORS.includes(event.message)) errors.push(event.message); });
  const js = source => win.webContents.executeJavaScript(source);
  const capture = async name => { fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  try {
    await win.loadURL('http://127.0.0.1:4422'); await pause(2200);
    await js(`document.querySelector('#sessionList [data-id="composer-preview"]').click()`); await pause(500);
    const languages = [...new Set(await js(`[...document.querySelectorAll('#uiLanguage option')].map(o=>o.value)`))];
    assert.ok(languages.length >= 11, 'all interface languages: ' + languages.join(','));
    const results = [];
    for (const language of languages) {
      await js(`(()=>{const s=document.getElementById('uiLanguage');s.value=${JSON.stringify('LANG')};s.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`.replace('LANG', language));
      await pause(500);
      await js(`(()=>{const m=document.getElementById('contextMeter');if(!m.classList.contains('pinned'))document.getElementById('contextMeterButton').click();return 1})()`);
      await pause(300);
      const r = await js(`(()=>{const d=document.getElementById('contextMeterInfo'),box=d.getBoundingClientRect();
        const rows=[...d.querySelectorAll('.context-data dt')].map(dt=>{const dd=dt.nextElementSibling,a=dt.getBoundingClientRect(),b=dd.getBoundingClientRect();
          return {label:dt.textContent,value:dd.textContent,inside:a.left>=box.left-1&&b.right<=box.right+1,overlap:a.right>b.left+1&&Math.abs(a.top-b.top)<4,clipped:dt.scrollWidth>dt.clientWidth+1||dd.scrollWidth>dd.clientWidth+1}});
        return {lang:document.documentElement.lang,rows,inViewport:box.left>=0&&box.right<=innerWidth&&box.top>=0}})()`);
      results.push(r);
      assert.equal(r.rows.length, 4, language + ': four rows');
      assert.ok(r.inViewport, language + ': dialog visible');
      for (const row of r.rows) {
        assert.ok(row.inside && !row.overlap && !row.clipped, language + ': row fits: ' + JSON.stringify(row));
        assert.ok(row.value.trim().length > 0 && !/undefined|NaN|\{\d\}/.test(row.value + row.label), language + ': row has a value: ' + JSON.stringify(row));
      }
      if (['en', 'de', 'pt-BR'].includes(language)) await capture('context-' + language);
    }
    await js(`(()=>{const s=document.getElementById('uiLanguage');s.value='en';s.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`);
    assert.deepEqual(errors, [], 'no renderer errors: ' + errors.join('\n'));
    console.log('PASS: context dialog has four labelled rows that fit in ' + results.length + ' languages. ' + output);
  } finally { win.destroy(); await server?.close(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
