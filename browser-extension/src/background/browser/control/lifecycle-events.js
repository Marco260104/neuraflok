export function createBrowserControlEvents({ ready, tabs, initialize, invalidate, page, ingest, cut, save, cleanup, removeIndicator }) {
  async function event(source, method, params) {
    await ready(); const state = tabs.get(source.tabId); if (!state) return;
    if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'iframe') {
      if (state.sessions.size >= 32) return;
      state.sessions.add(params.sessionId);
      await initialize(state,params.sessionId).catch(() => state.sessions.delete(params.sessionId));
    } else if (method === 'Target.detachedFromTarget') {
      state.sessions.delete(params.sessionId); invalidate(state);
    } else if (method === 'Runtime.executionContextCreated') {
      const ctx = params.context;
      if (ctx?.auxData?.isDefault && ctx.auxData.frameId) state.contexts.set(`${ctx.auxData.frameId}:main`,{id:ctx.id,sessionId:source.sessionId});
    } else if (method === 'Runtime.executionContextsCleared') {
      for (const [key,ctx] of state.contexts) if (ctx.sessionId === source.sessionId) state.contexts.delete(key);
      invalidate(state);
    } else if (method === 'Runtime.executionContextDestroyed') {
      for (const [key,ctx] of state.contexts) if (ctx.id === params.executionContextId && ctx.sessionId === source.sessionId) state.contexts.delete(key);
    } else if (method === 'Page.frameNavigated') {
      invalidate(state);
      if (params.frame?.id) state.frames.set(params.frame.id,{...params.frame,sessionId:source.sessionId});
      // Reinstall the indicator after real document navigation, without a timer or page activation.
      if (!params.frame?.parentId && !source.sessionId && /^https?:/.test(params.frame?.url)) void page(state,'overlay').catch(() => {});
    } else if (method === 'Page.navigatedWithinDocument') {
      invalidate(state);
    } else if (method === 'Page.javascriptDialogOpening') {
      state.dialog = {type:params.type,message:cut(params.message,2000),defaultPrompt:cut(params.defaultPrompt,1000)};
    } else if (method === 'Page.javascriptDialogClosed') state.dialog = null;
    else ingest(state,source,method,params);
  }
  async function detached(source) {
    await ready(); const state = tabs.get(source.tabId); if (!state) return;
    tabs.delete(source.tabId); await save();
    await cleanup(removeIndicator(state));
  }
  return { event, detached };
}
