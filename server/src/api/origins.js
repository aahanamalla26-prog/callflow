// Which web origins may call the API and open the dashboard WebSocket.
//
// Browsers do not apply CORS to WebSockets, and a plain POST needs no preflight, so without these checks
// any website the user happens to visit could read live call data from localhost or trigger a replay.
// Requests with no Origin header (curl, wscat, scripts) are not browsers, so they are allowed.

const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4000', 'http://127.0.0.1:4000'];

// Read on every call so DASHBOARD_ORIGINS (comma-separated) can be set in .env or in tests.
export function allowedOrigins() {
  const configured = (process.env.DASHBOARD_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_ORIGINS;
}

export function isAllowedOrigin(origin) {
  if (!origin) return true;
  return allowedOrigins().includes(origin);
}

// Express middleware: CORS headers for allowed origins, and a hard 403 for state-changing requests from others.
export function cors(req, res, next) {
  const origin = req.headers.origin;
  const allowed = isAllowedOrigin(origin);

  if (origin && allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(allowed ? 204 : 403);
  if (!allowed && req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(403).json({ error: 'origin_not_allowed' });
  }
  next();
}
