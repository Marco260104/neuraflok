export function buildWorkerSandboxSource(desktopMethods: readonly string[]): string {
  const methodList = JSON.stringify(desktopMethods);
  return String.raw`
  const setup = enter(() => vm.evalCode('(() => { ' +
    'const bridge = globalThis.__bridge; delete globalThis.__bridge; ' +
    'const stringify = JSON.stringify, parse = JSON.parse, String_ = String; ' +
    'const tools = Object.create(null); ' +
    'const entries = ' + JSON.stringify(workerData.tools) + '; ' +
    'for (const entry of entries) { Object.freeze(entry); tools[entry.name] = args => bridge("call", stringify({name:entry.name,args})).then(parse); } ' +
    'Object.defineProperties(globalThis, {' +
      'tools: {value:Object.freeze(tools)}, ALL_TOOLS:{value:Object.freeze(entries)}, ' +
      'text:{value:value => bridge("text", stringify(typeof value === "string" ? value : (stringify(value) ?? String_(value))))}, ' +
      'image:{value:value => bridge("image", stringify(value))}, ' +
      'exit:{value:() => { bridge("exit", "null"); throw undefined; }}' +
    '}); ' +
    (workerData.windowsDesktop ?
      'const sky = Object.create(null); ' +
      'for (const name of ${methodList}) { if (!tools[name]) continue; ' +
        'sky[name] = async (args = {}) => { const result = await tools[name](args); ' +
          'if (result.isError) { const message = (result.content || []).filter(item => item.type === "text").map(item => item.text).join("\\n"); ' +
            'text(message); throw new Error(message || "Desktop operation failed"); } ' +
          'if (!result.structuredContent || !("value" in result.structuredContent)) throw new Error("Invalid Desktop result"); ' +
          'const value = result.structuredContent.value; ' +
          'if (name === "get_window_state") { for (const part of result.content) { if (part.type === "image") image(part); } } ' +
          'return value === null ? undefined : value; }; } ' +
      'sky.target = "windows"; Object.defineProperties(globalThis, {sky:{value:Object.freeze(sky)}, nodeRepl:{value:Object.freeze({write:text})}}); '
      : '') +
    '})()'));
  if (setup.error) { setup.error.dispose(); finish('RUNTIME_ERROR'); return; }
  setup.value.dispose();
`;
}
