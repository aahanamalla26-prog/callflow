// One HTTP server, two kinds of WebSocket client, told apart by path:
//   /dashboard   read-only live feed for the dashboard (events from realtime/events.js)
//   /<sessionId> a caller talking to the agent (handler.js)
// "dashboard" is therefore reserved and cannot be used as a caller session id.
import { WebSocketServer } from 'ws';
import { isAllowedOrigin } from '../api/origins.js';
import { subscribe } from '../realtime/events.js';
import { createHub, DASHBOARD_PATH } from '../realtime/hub.js';
import setupCallerSocket from './handler.js';

export function attachSockets(server) {
  const callers = new WebSocketServer({ noServer: true });
  const dashboards = new WebSocketServer({ noServer: true });
  setupCallerSocket(callers);

  const hub = createHub();
  hub.start();
  const unsubscribe = subscribe((event) => hub.broadcast(event));

  // The only 'upgrade' listener on the server, so each socket is handed to exactly one WebSocketServer.
  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname === DASHBOARD_PATH) {
      // Browsers always send an Origin, so a page from another site cannot quietly watch the feed.
      if (!isAllowedOrigin(req.headers.origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      dashboards.handleUpgrade(req, socket, head, (ws) => hub.add(ws));
      return;
    }

    callers.handleUpgrade(req, socket, head, (ws) => callers.emit('connection', ws, req));
  });

  return {
    callers,
    dashboards,
    hub,
    // Closes every open socket so server.close() does not wait on idle connections.
    close() {
      unsubscribe();
      hub.stop();
      hub.closeAll();
      for (const ws of callers.clients) ws.close(1001, 'server shutting down');
    },
  };
}
