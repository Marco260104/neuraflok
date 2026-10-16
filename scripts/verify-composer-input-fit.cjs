const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const { readRendererStyleSource } = require('./read-renderer-style-source.cjs');

const projectRoot = path.join(__dirname, '..');
const scrollLimit = 220;

function createFixtureMarkup(styles) {
  return `<style>${styles}</style>
    <section id="host" hidden><form id="composer" class="composer">
    <textarea id="chatInput" rows="1" dir="auto" placeholder="Ask anything…"></textarea>
    <div class="composer-toolbar"><button type="button">+</button></div>
    </form></section>`;
}

async function captureInputStates(window) {
  return window.webContents.executeJavaScript(`(() => {
    const input = document.getElementById('chatInput');
    const host = document.getElementById('host');
    const samples = [];
    const scenarios = [
      { label: 'initial reveal', apply: () => { host.hidden = false; } },
      { label: 'long paste', apply: () => {
        input.value = 'Pasted line\\n'.repeat(100);
        input.scrollTop = input.scrollHeight;
      } },
      { label: 'clear', apply: () => { input.value = ''; } },
      { label: 'short draft', apply: () => { input.value = 'one line'; } },
      { label: 'wide draft', apply: () => { input.value = 'wrapped words '.repeat(25); } },
      { label: 'narrow draft', apply: () => { host.style.width = '320px'; } },
      { label: 'wide again', apply: () => { host.style.width = ''; } },
      { label: 'hidden draft restore', apply: () => {
        host.hidden = true;
        input.value = 'restored line\\n'.repeat(5);
        host.hidden = false;
      } },
      { label: 'empty again', apply: () => { input.value = ''; } },
    ];

    for (const scenario of scenarios) {
      scenario.apply();
      samples.push({ name: scenario.label, height: input.clientHeight,
      scrollHeight: input.scrollHeight, scrollTop: input.scrollTop,
      overflow: input.scrollHeight > input.clientHeight });
    }

    return samples;
  })()`);
}

function verifyComposerStates(states) {
  const shouldFit = ['initial reveal', 'clear', 'short draft', 'wide draft', 'wide again',
    'hidden draft restore', 'empty again'];
  for (const name of shouldFit) {
    assert.equal(states.find(state => state.name === name).overflow, false,
      `${name} must fit without scrolling`);
  }

  const longPaste = states.find(state => state.name === 'long paste');
  assert.equal(longPaste.height, scrollLimit, 'Long input stays bounded');
  assert.equal(longPaste.overflow, true, 'Long input remains scrollable');
  assert.ok(longPaste.scrollTop > 0, 'Overflowing text can actually scroll');
  assert.equal(states.find(state => state.name === 'clear').scrollTop, 0,
    'Clearing also resets the scroll position');
  assert.ok(states.find(state => state.name === 'narrow draft').height >
    states.find(state => state.name === 'wide draft').height,
  'Width changes must recalculate wrapping without an input event');
  assert.equal(states.at(-1).height, states[0].height,
    'Empty input has stable initial and cleared geometry');
}

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 1100, height: 800,
    webPreferences: { sandbox: true, backgroundThrottling: false } });

  try {
    const styles = readRendererStyleSource(projectRoot);
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(createFixtureMarkup(styles))}`);
    const states = await captureInputStates(window);
    verifyComposerStates(states);
    console.log(JSON.stringify(states, null, 2));
  } finally {
    window.destroy();
    app.quit();
  }
}

run().catch(error => {
  console.error(error);
  app.exit(1);
});
