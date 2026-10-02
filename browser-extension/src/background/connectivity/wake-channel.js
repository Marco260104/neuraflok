const RECONNECT_DELAY_MS = 2000;

export function createWakeChannel(readConnection) {
  let socket = null;
  let reconnectTimer = null;
  let handler = () => undefined;

  function currentConnection() {
    return readConnection() || {};
  }

  function close() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    const current = socket;
    socket = null;
    try {
      current?.close();
    } catch {}
  }

  function scheduleReconnect() {
    const connection = currentConnection();
    if (socket !== null || !connection.token || connection.disconnected || !connection.port) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (socket === null) connect();
    }, RECONNECT_DELAY_MS);
  }

  function connect() {
    const connection = currentConnection();
    const WebSocketApi = globalThis.WebSocket;
    if (!connection.token || connection.disconnected || !connection.port || typeof WebSocketApi === 'undefined') return;
    const host = connection.host === 'integrated' ? 'integrated' : 'browser';
    const address = `ws://127.0.0.1:${connection.port}/wake?host=${host}`;
    if (socket?.url === address && socket.readyState <= 1) return;

    const previous = socket;
    socket = null;
    try {
      previous?.close();
    } catch {}

    let next;
    try {
      next = new WebSocketApi(address);
    } catch {
      return;
    }
    socket = next;
    next.onopen = () => {
      const latest = currentConnection();
      if (socket !== next || !latest.token || latest.disconnected) {
        next.close();
        return;
      }
      next.send(latest.token);
    };
    next.onmessage = event => {
      if (socket !== next) return;
      if (event.data === 'ping') {
        next.send('pong');
        return;
      }
      if (event.data !== 'wake' && event.data !== 'browser-control') return;
      try {
        Promise.resolve(handler(event.data)).catch(() => undefined);
      } catch {}
    };
    next.onerror = () => {
      try {
        next.close();
      } catch {
        next.onclose?.();
      }
    };
    next.onclose = () => {
      if (socket !== next) return;
      socket = null;
      scheduleReconnect();
    };
  }

  function setHandler(next) {
    handler = typeof next === 'function' ? next : () => undefined;
  }

  return { connect, close, setHandler };
}
