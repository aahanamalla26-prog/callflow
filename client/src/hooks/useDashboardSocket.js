import { useEffect, useRef, useState } from 'react';

const url = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/dashboard`;

// Connects to the dashboard feed and reconnects with exponential backoff (1s -> 15s).
export function useDashboardSocket(onEvent) {
  const [status, setStatus] = useState('connecting'); // connecting | live | offline
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    let ws, timer, attempt = 0, stopped = false;

    const open = () => {
      setStatus(attempt === 0 ? 'connecting' : 'offline');
      ws = new WebSocket(url());
      ws.onopen = () => { attempt = 0; setStatus('live'); };
      ws.onmessage = (m) => {
        try { handler.current(JSON.parse(m.data)); } catch { /* ignore malformed frames */ }
      };
      ws.onclose = () => {
        if (stopped) return;
        setStatus('offline');
        timer = setTimeout(open, Math.min(1000 * 2 ** attempt++, 15000));
      };
      ws.onerror = () => ws.close();
    };

    open();
    return () => { stopped = true; clearTimeout(timer); ws?.close(); };
  }, []);

  return status;
}
