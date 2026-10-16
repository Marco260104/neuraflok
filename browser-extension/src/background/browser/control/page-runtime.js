import { browserPage } from './page-agent.js';

export function createBrowserPageRuntime(dependencies) {
  const { chrome, send, getTab, authorize, pageURL, cut, error, handle, id, currentEpoch } = dependencies;

  async function frameList(state) {
    const found = [];
    const observed = new Map();
    const visit = (tree, sessionId) => {
      if (!tree || found.length >= 100) return;
      const frame = tree.frame;
      if (frame?.id) {
        const previous = state.frames.get(frame.id);
        const row = {
          id: frame.id,
          parentId: frame.parentId || previous?.parentId,
          url: cut(frame.url, 2000),
          sessionId: sessionId || previous?.sessionId
        };
        observed.set(frame.id, row);
        found.push({ frameId: frame.id, parentId: row.parentId, url: row.url });
      }
      for (const child of tree.childFrames || []) visit(child, sessionId);
    };
    const root = await send(state, 'Page.getFrameTree');
    visit(root.frameTree);
    for (const sessionId of state.sessions) {
      const tree = await send(state, 'Page.getFrameTree', {}, sessionId).catch(() => null);
      if (tree) visit(tree.frameTree, sessionId);
    }
    state.frames = observed;
    return found.filter((frame, index) => found.findIndex(other => other.frameId === frame.frameId) === index);
  }

  async function context(state, frameId, main = false) {
    const frames = await frameList(state);
    const frame = state.frames.get(frameId || frames[0]?.frameId);
    if (!frame) error('BROWSER_FRAME_UNAVAILABLE: choose a frameId from a fresh snapshot.');
    pageURL(frame.url);
    const key = `${frame.id}:${main ? 'main' : 'isolated'}`;
    if (!main && !state.contexts.has(key)) {
      const pageId = state.pageId;
      const created = await send(state, 'Page.createIsolatedWorld', {
        frameId: frame.id,
        worldName: `integrated-browser-${state.lease}`,
        grantUniveralAccess: false
      }, frame.sessionId);
      if (state.pageId !== pageId) error('BROWSER_PAGE_STALE: frame changed while observing.');
      state.contexts.set(key, { id: created.executionContextId, sessionId: frame.sessionId });
    }
    const current = state.contexts.get(key);
    if (!current) error('BROWSER_FRAME_UNAVAILABLE: the frame has no current main-world execution context. Snapshot again after loading.');
    return current;
  }

  async function evaluate(state, expression, contextInfo, command) {
    const result = await send(state, 'Runtime.evaluate', {
      expression,
      contextId: contextInfo.id,
      returnByValue: true,
      awaitPromise: true,
      timeout: 5000
    }, contextInfo.sessionId, command);
    if (result.exceptionDetails) {
      error(`BROWSER_JAVASCRIPT_ERROR: ${cut(result.exceptionDetails.exception?.description || result.exceptionDetails.text, 1200)}`);
    }
    return result.result?.value;
  }

  async function page(state, operation, args = {}, command) {
    const pageId = state.pageId;
    const contextInfo = await context(state, args.frameId);
    if (state.pageId !== pageId) error('BROWSER_PAGE_STALE: snapshot again.');
    const result = await evaluate(
      state,
      `(${browserPage.toString()})(${JSON.stringify(operation)},${JSON.stringify({ ...args, pageId, lease: state.lease })})`,
      contextInfo,
      command
    );
    if (state.pageId !== pageId) error('BROWSER_PAGE_STALE: page changed while reading.');
    return result;
  }

  async function screenshot(state, args, command) {
    const pageId = state.pageId;
    const metrics = await send(state, 'Page.getLayoutMetrics');
    const viewport = metrics.cssVisualViewport;
    const rect = args.fullPage
      ? metrics.cssContentSize
      : { x: viewport.pageX, y: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight };
    if (!(rect.width > 0 && rect.height > 0) || rect.width > 100000 || rect.height > 100000) {
      error('BROWSER_CAPTURE_DIMENSIONS');
    }
    const scale = Math.min(1, 1600 / Math.max(rect.width, rect.height));
    const width = Math.round(rect.width * scale);
    const height = Math.round(rect.height * scale);
    const result = await send(state, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: 80,
      fromSurface: true,
      captureBeyondViewport: args.fullPage === true,
      clip: { ...rect, scale }
    }, undefined, command);
    if (state.pageId !== pageId) error('BROWSER_PAGE_STALE: screenshot crossed navigation.');
    if (!result.data || result.data.length > 1_600_000) error('BROWSER_SCREENSHOT_TOO_LARGE');
    const shot = { id: id(), pageId, width, height, scale, viewport, fullPage: args.fullPage === true };
    state.screenshot = shot;
    return {
      value: { tabId: handle(state.tabId), pageId, screenshotId: shot.id, width, height, scale, fullPage: shot.fullPage },
      image: { mimeType: 'image/jpeg', data: result.data }
    };
  }

  async function inspect(command) {
    const args = command.args;
    await authorize(command, false);
    const tab = await getTab(args.tabId);
    pageURL(tab.url);
    const documentId = args.frameId?.startsWith('document:') ? args.frameId.slice('document:'.length) : undefined;
    // Chrome document IDs are opaque values and must retain their original spelling.
    if (args.frameId && (!documentId || args.frameId.length > 100)) {
      error('BROWSER_FRAME_UNAVAILABLE: unattached inspection uses document: frameIds. Omit frameId to read the current top document.');
    }
    // This fixed reader does not attach a debugger, retain refs, change focus, or execute model-provided code.
    let result;
    let timer;
    try {
      result = await Promise.race([
        chrome.scripting.executeScript({
          target: { tabId: args.tabId, ...(documentId ? { documentIds: [documentId] } : { frameIds: [0] }) },
          world: 'ISOLATED',
          func: browserPage,
          args: ['inspect', {
            selector: args.selector,
            format: args.format,
            filter: args.filter,
            maxNodes: args.maxNodes || 300,
            maxChars: args.maxChars || 16000
          }]
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(
            'BROWSER_INSPECTION_TIMEOUT: Chrome did not return the DOM observation. The tab and its debugger were left unchanged.'
          )), Math.max(1, Math.min(8000, command.expiresAt - Date.now())));
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (command.epoch !== currentEpoch() || command.expiresAt <= Date.now()) {
      error('BROWSER_EXPIRED: the DOM inspection result expired. No input was dispatched.');
    }
    await authorize(command, false);
    const captured = result[0];
    if (documentId && captured?.documentId !== documentId) {
      error('BROWSER_FRAME_UNAVAILABLE: the requested document is no longer available. Omit frameId to inspect the current top document.');
    }
    if (typeof captured?.result?.error === 'string') error(cut(captured.result.error, 1000));
    if (!captured?.documentId || !captured.result || typeof captured.result.text !== 'string') {
      error('BROWSER_INSPECTION_UNAVAILABLE: Chrome returned no DOM observation for that document.');
    }
    const { refs: _refs, ...value } = captured.result;
    return {
      value: {
        ...value,
        tabId: handle(args.tabId),
        documentId: captured.documentId,
        frameId: `document:${captured.documentId}`,
        inspectionOnly: true,
        message: 'DOM inspection only; no action refs were created. Attach an eligible tab for browser input.'
      }
    };
  }

  return { frameList, context, evaluate, page, screenshot, inspect };
}
