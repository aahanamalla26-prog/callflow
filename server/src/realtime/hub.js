// Fan-out of events to connected dashboards at ws://host/dashboard. This file has no imports on purpose,
// so it can be tested with fake sockets (see scripts/test-dashboard.js). The actual upgrade handling
// lives in websocket/index.js, which owns the HTTP server's single 'upgrade' listener: two listeners
// would both try to take the same socket, and ws throws when handleUpgrade runs twice on one socket.
export const DASHBOARD_PATH = '/dashboard';

const OPEN = 1; // the same value as WebSocket.OPEN in the ws package

export function createHub({ heartbeatMs = 30_000 } = {}) {
  const clients = new Set();
  let timer = null;

  function send(ws, event) {
    if (ws.readyState !== OPEN) return;
    try {
      ws.send(JSON.stringify(event));
    } catch (err) {
      console.error(`[dashboard] send failed: ${err.message}`);
    }
  }

  return {
    add(ws) {
      clients.add(ws);
      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });
      ws.on('close', () => clients.delete(ws));
      // Without an 'error' listener a socket error is thrown and can crash the process.
      ws.on('error', (err) => {
        console.error('[dashboard] socket error:', err.message);
        clients.delete(ws);
      });
      send(ws, { type: 'hello', data: {}, ts: new Date().toISOString() });
    },

    broadcast(event) {
      for (const ws of clients) send(ws, event);
    },

    // Drops dashboards whose connection died without a close (laptop sleep, wifi change): one that has
    // not answered the previous ping is terminated, the rest are pinged again.
    heartbeat() {
      for (const ws of clients) {
        if (!ws.isAlive) {
          clients.delete(ws);
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch {
          clients.delete(ws);
          ws.terminate();
        }
      }
    },

    start() {
      if (!timer) {
        timer = setInterval(() => this.heartbeat(), heartbeatMs);
        timer.unref(); // the timer alone must not keep the process alive
      }
    },

    stop() {
      clearInterval(timer);
      timer = null;
    },

    closeAll() {
      for (const ws of clients) ws.close(1001, 'server shutting down');
      clients.clear();
    },

    size: () => clients.size,
  };
}
