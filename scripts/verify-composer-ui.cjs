// Current NEURAFLOK composer UI, rendered with production code and in-memory IPC only.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { BENIGN_RENDERER_ERRORS } = require('./fixtures/app-defaults.cjs');

const root = path.resolve(__dirname, "..");
const output = path.join(root, ".tmp/composer-ui");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server;
let win;

app.setPath("userData", path.join(output, "profile"));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const { createServer } = await import("vite");
  server = await createServer({
    configFile: false,
    root: path.join(root, "./frontend"),
    cacheDir: path.join(output, "vite"),
    logLevel: "error",
    resolve: { alias: { "@phosphor-icons/web": path.join(root, "node_modules/@phosphor-icons/web/src") } },
    server: { host: "127.0.0.1", port: 4420, strictPort: true, fs: { allow: [root] } },
    plugins: [{
      name: "ipc-fixture",
      transformIndexHtml(html) {
        return html.replace("</head>", "<script src='/composer-fixture.js'></script></head>");
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== "/composer-fixture.js") return next();
          res.setHeader("Content-Type", "text/javascript");
          res.end(fs.readFileSync(path.join(__dirname, "fixtures/composer-ui.js")));
        });
      }
    }]
  });

  await server.listen();
  win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 960,
    webPreferences: { sandbox: true, offscreen: true, backgroundThrottling: false }
  });
  const errors = [];
  win.webContents.on("console-message", event => {
    if (event.level === "error" && !BENIGN_RENDERER_ERRORS.includes(event.message)) {
      errors.push(`${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });
  await win.loadURL("http://127.0.0.1:4420");
  win.webContents.setZoomFactor(1);
  await pause(1800);

  const js = source => win.webContents.executeJavaScript(source);
  const until = async (source, timeout = 5000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await js(source)) return;
      await pause(100);
    }
    assert.fail("Timed out waiting for the composer fixture to render");
  };

  const welcomeLayout = () => js(`(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return {left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height}; };
    return {title:rect('.workspace-empty-title'), composer:rect('#composer'), host:rect('.card.is-session'),
      footer:rect('.composer-workspace-tools'), input:rect('#chatInput'), viewport:{width:innerWidth,height:innerHeight},
      computed:{composerTop:getComputedStyle(document.getElementById('composer')).top,titleTop:getComputedStyle(document.getElementById('timelineEmpty')).top,titleParent:document.getElementById('timelineEmpty').offsetParent.tagName,composerParent:document.getElementById('composer').offsetParent.tagName},
      filesDisabled:document.getElementById('composerFiles').disabled,
      overflowing:document.documentElement.scrollWidth > innerWidth};
  })()`);
  const screenshot = async name => {
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  await js("document.getElementById('newChat').click()");
  await until("!document.getElementById('timelineEmpty').hidden");
  await pause(200);
  const welcome = await welcomeLayout();
  await screenshot('welcome-desktop');
  assert(welcome.title.bottom < welcome.composer.top, "Welcome title is above the centered composer");
  assert(welcome.composer.top < welcome.viewport.height * .6, "New Chat composer rests near the viewport center: " + JSON.stringify(welcome));
  assert(Math.abs((welcome.composer.left + welcome.composer.right - welcome.host.left - welcome.host.right) / 2) < 1, "Welcome composer centers in the chat column");
  assert(welcome.footer.top > welcome.input.bottom, "Workspace actions have their own footer below the input");
  assert.equal(welcome.filesDisabled, true, "Files requires a selected project");
  assert.equal(welcome.overflowing, false);
  await js("document.getElementById('chatInput').value = 'Review this project.\\n'.repeat(80); document.getElementById('chatInput').dispatchEvent(new Event('input', {bubbles:true}))");
  const longWelcome = await welcomeLayout();
  assert(Math.abs(longWelcome.title.top - welcome.title.top) < 1, "Growing a draft does not move the welcome title");
  assert(longWelcome.input.height <= 221, "A long draft keeps the native textarea bound");
  assert(longWelcome.composer.bottom <= longWelcome.viewport.height, "Long drafts keep workspace actions inside the window");
  await js("document.querySelector('.composer-workspace-tools [data-workspace-page=skills]').click()");
  await until("document.querySelector('.app').dataset.screen === 'library'");
  await js("document.querySelector('[data-workspace-page=chat]').click()");
  await until("document.querySelector('.app').dataset.screen === 'chat'");
  assert.equal(await js("document.getElementById('chatInput').value.startsWith('Review this project.')"), true, "Skills navigation preserves the authored draft");
  await js("document.getElementById('chatInput').value = ''; document.getElementById('chatInput').dispatchEvent(new Event('input', {bubbles:true}))");

  for (const size of [[1024, 768], [720, 600]]) {
    win.setContentSize(...size); await pause(100);
    const narrow = await welcomeLayout();
    assert.equal(narrow.overflowing, false, 'No horizontal overflow at ' + size.join('x'));
    assert(narrow.composer.left >= narrow.host.left && narrow.composer.right <= narrow.host.right, 'Composer fits the chat column');
    assert(narrow.composer.bottom <= narrow.viewport.height, 'Workspace footer fits a short window');
    await js("document.getElementById('chatInput').value = 'Long draft\\n'.repeat(80); document.getElementById('chatInput').dispatchEvent(new Event('input', {bubbles:true}))");
    const longEarrow = await welcomeLayout();
    assert(longEarrow.composer.bottom <= longEarrow.viewport.height, 'Long draft fits at ' + size.join('x'));
    await screenshot('welcome-' + size.join('x'));
    await js("document.getElementById('chatInput').value = ''; document.getElementById('chatInput').dispatchEvent(new Event('input', {bubbles:true}))");
  }
  win.setContentSize(1440, 960); await pause(100);

  await js("document.querySelector('#sessionList [data-id=\"composer-preview\"]').click()");
  await until("document.getElementById('contextMeterCompact').textContent === '38%'");

  const layout = await js(
    "(() => {" +
    "const composer = document.querySelector('.composer');" +
    "const primaryControls = composer.querySelector('.composer-primary-controls');" +
    "const primary = [...primaryControls.children]" +
    ".filter(element => ['attachmentMenu', 'composerAccess', 'toggleTerminal'].includes(element.id))" +
    ".map(element => element.id);" +
    "const model = document.getElementById('chatModelPicker');" +
    "const send = composer.querySelector('.send-control');" +
    "const bounds = element => { const rect = element.getBoundingClientRect(); return {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width}; };" +
    "const primaryBounds = bounds(primaryControls);" +
    "const accessBounds = bounds(document.getElementById('composerAccess'));" +
    "const terminalBounds = bounds(document.getElementById('toggleTerminal'));" +
    "const contextBounds = bounds(document.getElementById('contextMeter'));" +
    "const modelBounds = bounds(model);" +
    "const sendBounds = bounds(send);" +
    "return {primary, modelInRightControls: model.parentElement.id === 'composerModelControls'," +
    "modelBeforeSend: Boolean(model.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING)," +
    "modelName: document.getElementById('chatModelPickerName').textContent," +
    "primaryBounds, accessBounds, terminalBounds, contextBounds, modelBounds, sendBounds};" +
    "})()"
  );
  assert.deepEqual(layout.primary, ["attachmentMenu", "composerAccess"]);
  assert.equal(layout.modelInRightControls, true);
  assert.equal(layout.modelBeforeSend, true);
  assert.equal(layout.modelName, "DeepSeek Web");
  assert(layout.accessBounds.width > 0, "Access selector is visible in the left controls");
  assert(layout.primaryBounds.right < layout.contextBounds.left, "Attachment and access stay left of context");
  assert(layout.terminalBounds.top >= layout.sendBounds.bottom, "Terminal belongs to the workspace footer");
  assert(layout.contextBounds.right <= layout.modelBounds.left, "Model follows context on the right side");
  assert(layout.modelBounds.right <= layout.sendBounds.left, "Send stays to the right of the model");
  const primaryCenterY = (layout.primaryBounds.top + layout.primaryBounds.bottom) / 2;
  const modelCenterY = (layout.modelBounds.top + layout.modelBounds.bottom) / 2;
  assert(Math.abs(primaryCenterY - modelCenterY) < 1, "Composer controls share one visual baseline");

  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }]
  });
  await js("document.querySelector('#chatModelPicker > summary').click()");
  await pause(35);

  const picker = await js(
    "(() => {" +
    "const popover = document.querySelector('#chatModelPicker > .composer-popover');" +
    "const rect = popover.getBoundingClientRect();" +
    "return {open: document.getElementById('chatModelPicker').open, visible: rect.height > 0," +
    "withinWindow: rect.left >= 0 && rect.right <= innerWidth + .5," +
    "animation: getComputedStyle(popover).animationName," +
    "animationDuration: getComputedStyle(popover).animationDuration," +
    "providers: [...document.querySelectorAll('#webModelOptions [data-model-pick-web]')].map(button => button.textContent)," +
    "connectActions: document.querySelectorAll('#webModelOptions [data-model-connect]').length," +
    "apiChoice: document.querySelector('#apiModelOptions [data-model-pick-api]') !== null," +
    "manageAction: document.getElementById('manageModelsOpen').textContent};" +
    "})()"
  );

  assert.equal(picker.open, true);
  assert.equal(picker.visible, true);
  assert.equal(picker.withinWindow, true);
  assert.equal(picker.animation, "surface-in");
  assert.notEqual(picker.animationDuration, "0s");
  for (const provider of ["DeepSeek Web", "Kimi Web", "Qwen Web", "Z AI Web"]) {
    assert(picker.providers.some(label => label.includes(provider)), "Model picker includes " + provider + ": " + JSON.stringify({
      providers: picker.providers,
      modelName: layout.modelName,
      options: await js("document.getElementById('webModelOptions').innerHTML"),
      errors
    }));
  }
  assert.equal(picker.connectActions, 4);
  assert.equal(picker.apiChoice, true);
  assert.match(picker.manageAction, /Manage models/i);

  const originalTheme = await js("document.documentElement.dataset.theme");
  for (const theme of ['dark', 'light']) {
    await js(`import('/features/settings/appearance.ts').then(module => module.applyAppearance('${theme}'))`);
    await until(`Array.from(document.querySelectorAll('.provider-logo img')).every(img => img.complete && img.naturalWidth > 0)`);
    const marks = await js(`Array.from(document.querySelectorAll('#webModelOptions [data-model-pick-web]')).map(button => {
      const images = [...button.querySelectorAll('.provider-logo img')].filter(img => getComputedStyle(img).display !== 'none');
      const img = images[0];
      const bounds = img?.getBoundingClientRect();
      return {provider:button.dataset.modelPickWeb, count:images.length, variant:img?.className,
        width:bounds?.width, height:bounds?.height};
    })`);
    assert.equal(marks.length, 4);
    for (const mark of marks) {
      assert.equal(mark.count, 1, 'One visible logo for ' + mark.provider + ' in ' + theme);
      assert(mark.width > 0 && mark.height > 0, 'Logo has visible bounds');
      if (['kimi', 'glm'].includes(mark.provider)) {
        assert.equal(mark.variant === 'provider-logo-dark', theme === 'dark', 'Logo variant matches theme');
      }
    }
    assert.equal(await js("document.querySelectorAll('#chatModelPickerMark .provider-logo').length"), 1);
    await js("document.getElementById('chatModelPicker').open = true");
    await pause(250);
    await screenshot('provider-picker-' + theme);
  }
  await js(`import('/features/settings/appearance.ts').then(module => module.applyAppearance(${JSON.stringify(originalTheme)}))`);

  await js("document.getElementById('chatModelPicker').open = false");
  await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }]
  });
  await js("document.querySelector('#chatModelPicker > summary').click()");
  await pause(25);
  const reducedMotion = await js("getComputedStyle(document.querySelector('#chatModelPicker > .composer-popover')).animationDuration");
  assert(parseFloat(reducedMotion) < 0.001, "Reduced motion minimizes the model picker animation");
  await js("document.getElementById('chatModelPicker').open = false; window.api.terminalCreate = () => Promise.resolve({ok:true,data:{shell:'Fixture shell',cwd:'C:/preview'}}); window.api.terminalResize = () => Promise.resolve({ok:true,data:null}); document.getElementById('toggleTerminal').click()");
  await until("document.querySelector('.app').classList.contains('has-bottom-dock')");
  assert.equal(await js("document.getElementById('toggleTerminal').getAttribute('aria-expanded')"), 'true');
  await js("document.getElementById('terminalToggle').click()");
  await until("!document.querySelector('.app').classList.contains('has-bottom-dock')");
  assert.equal(await js("document.getElementById('toggleTerminal').getAttribute('aria-expanded')"), 'false', 'All terminal entry points project the dock owner');
  await js(`window.api.addProject = () => Promise.resolve({ok:true,data:{id:'reference-project',name:'NEURAFLOK',path:'C:/preview',createdAt:1}});
    window.api.listProjectFiles = () => Promise.resolve({ok:true,data:{projectId:'reference-project',projectName:'NEURAFLOK',directory:'',entries:[],truncated:false}});
    document.getElementById('addProject').click()`);
  await until("!document.getElementById('timelineEmpty').hidden && document.getElementById('chatProjectName').textContent === 'NEURAFLOK' && !document.getElementById('composerFiles').disabled");
  await pause(200);
  await screenshot('welcome-project');
  win.setContentSize(1920, 1080);
  await js("import('/shared/i18n.ts').then(module => module.setLanguage('es'))");
  await js("window.api.getState().then(reply => window.composerFixture.emit('onStateChanged', reply.data))");
  await pause(200);
  await screenshot('welcome-reference-es');
  await js("import('/shared/i18n.ts').then(module => module.setLanguage('en'))");
  win.setContentSize(720, 600);
  await js("document.getElementById('toggleTerminal').click(); document.getElementById('chatInput').value = 'Long draft\\n'.repeat(80); document.getElementById('chatInput').dispatchEvent(new Event('input', {bubbles:true}))");
  await until("document.querySelector('.app').classList.contains('has-bottom-dock')");
  await pause(200);
  const withTerminal = await welcomeLayout();
  assert(withTerminal.composer.bottom <= withTerminal.host.bottom + 1, 'Welcome composer fits above the terminal in a short window: ' + JSON.stringify(withTerminal));
  await js("document.getElementById('toggleTerminal').click(); document.getElementById('chatInput').value = ''; document.getElementById('chatInput').dispatchEvent(new Event('input', {bubbles:true}))");
  win.setContentSize(1440, 960); await pause(200);
  await js("document.getElementById('composerFiles').click()");
  await until("document.getElementById('rightDockToggle').getAttribute('aria-expanded') === 'true'");
  assert.equal(await js("!document.querySelector('.file-panel').hidden"), true, 'Files opens the existing project viewer');
  assert.deepEqual(errors, [], "Unexpected renderer errors: " + JSON.stringify({ errors, rejection: await js("window.__composerRejection || null") }));
  console.log("PASS centered welcome, bounded drafts, responsive workspace actions, provider picker and reduced motion");

  win.destroy();
  await server.close();
  app.quit();
}).catch(async error => {
  console.error(error);
  if (win && !win.isDestroyed()) win.destroy();
  if (server) await server.close();
  app.exit(1);
});
