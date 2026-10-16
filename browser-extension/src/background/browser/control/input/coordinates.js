import { browserFramePoint } from '../page-agent.js';

export function createBrowserPointResolver(dependencies) {
  const { authorize, send, page, frameList, context, cut, error } = dependencies;

  async function resolveFrameParents(state, frameId, command) {
    const frames = await frameList(state);
    const parents = [];
    let child = state.frames.get(frameId);
    while (child && child.id !== frames[0]?.frameId) {
      const parent = state.frames.get(child.parentId);
      if (!parent || parents.length >= 20) error('BROWSER_FRAME_UNAVAILABLE: snapshot again.');
      const executionContext = await context(state, parent.id);
      const owner = await send(state, 'DOM.getFrameOwner', { frameId: child.id }, parent.sessionId, command);
      const node = await send(state, 'DOM.resolveNode', {
        backendNodeId: owner.backendNodeId,
        executionContextId: executionContext.id
      }, parent.sessionId, command);
      parents.push({ objectId: node.object.objectId, sessionId: parent.sessionId });
      child = parent;
    }
    return parents;
  }

  async function transformFramePoint(state, parent, value, command) {
    const result = await send(state, 'Runtime.callFunctionOn', {
      objectId: parent.objectId,
      functionDeclaration: browserFramePoint.toString(),
      arguments: [{ value }],
      returnByValue: true
    }, parent.sessionId, command);
    if (result.exceptionDetails) {
      error(`BROWSER_FRAME_INPUT: ${cut(result.exceptionDetails.exception?.description || result.exceptionDetails.text)}`);
    }
    return result.result.value;
  }

  async function resolveRefPoint(state, args, command) {
    if (!args.ref.startsWith(`${state.pageId}:`)) error('BROWSER_REF_STALE');
    const frameId = state.refFrames?.get(args.ref);
    if (!frameId) error('BROWSER_REF_STALE: use a current snapshot ref.');
    const parents = await resolveFrameParents(state, frameId, command);
    try {
      if (!args.noScroll) {
        for (const parent of [...parents].reverse()) await transformFramePoint(state, parent, null, command);
      }
      let result = await page(state, 'point', { ref: args.ref, frameId, noScroll: args.noScroll }, command);
      const sessionId = state.frames.get(frameId)?.sessionId;
      let inputPoint = result;
      for (const parent of parents) {
        result = await transformFramePoint(state, parent, result, command);
        if (parent.sessionId === sessionId) inputPoint = result;
      }
      return sessionId ? { ...inputPoint, __sessionId: sessionId } : result;
    } finally {
      for (const parent of parents) {
        await send(state, 'Runtime.releaseObject', { objectId: parent.objectId }, parent.sessionId).catch(() => {});
      }
    }
  }

  async function resolveScreenshotPoint(state, args, command) {
    const screenshot = state.screenshot;
    if (!screenshot || screenshot.id !== args.screenshotId || screenshot.pageId !== state.pageId || screenshot.fullPage ||
        !Number.isFinite(args.x) || !Number.isFinite(args.y)) {
      error('BROWSER_SCREENSHOT_STALE: coordinate input needs a current viewport screenshotId and x/y.');
    }
    const metrics = (await send(state, 'Page.getLayoutMetrics', {}, undefined, command)).cssVisualViewport;
    if (!metrics || ['pageX', 'pageY', 'clientWidth', 'clientHeight', 'scale'].some(key => metrics[key] !== screenshot.viewport[key])) {
      error('BROWSER_VIEWPORT_CHANGED: take another screenshot.');
    }
    if (args.x >= screenshot.width || args.y >= screenshot.height) error('BROWSER_COORDINATES_OUTSIDE_IMAGE');
    return { x: args.x / screenshot.scale, y: args.y / screenshot.scale };
  }

  return async function point(state, args, command) {
    await authorize(command);
    return args.ref ? resolveRefPoint(state, args, command) : resolveScreenshotPoint(state, args, command);
  };
}
