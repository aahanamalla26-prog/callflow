// Offline tests for the dashboard plumbing: query parsing, origin checks, the event bus and the
// WebSocket hub (with fake sockets). No MongoDB, Redis or network needed.
//   node scripts/test-dashboard.js
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { allowedOrigins, cors, isAllowedOrigin } from '../src/api/origins.js';
import { isObjectIdString, parseLimit, pickEnum } from '../src/api/params.js';
import { EVENT_TYPES, publish, subscribe } from '../src/realtime/events.js';
import { createHub, DASHBOARD_PATH } from '../src/realtime/hub.js';

delete process.env.DASHBOARD_ORIGINS;

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

// --- params ------------------------------------------------------------------

test('parseLimit accepts whole numbers, caps them, and falls back for anything else', () => {
  assert.equal(parseLimit('10'), 10);
  assert.equal(parseLimit('500'), 100); // capped
  assert.equal(parseLimit('100'), 100);
  assert.equal(parseLimit(undefined), 25);
  for (const bad of ['0', '-5', 'abc', '1.5', '', '1e3', ['10'], { $gt: 1 }]) assert.equal(parseLimit(bad), 25, JSON.stringify(bad));
  assert.equal(parseLimit('999999'), 25); // more than 5 digits is rejected outright
});

test('pickEnum: absent is fine, allowed passes, anything else is an error', () => {
  const allowed = ['new', 'booked'];
  assert.deepEqual(pickEnum(undefined, allowed), { value: undefined });
  assert.deepEqual(pickEnum('', allowed), { value: undefined });
  assert.deepEqual(pickEnum('booked', allowed), { value: 'booked' });
  assert.match(pickEnum('lost', allowed).error, /must be one of: new, booked/);
});

test('pickEnum rejects arrays and objects, which is how query-string injection arrives', () => {
  const allowed = ['new', 'booked'];
  assert.ok(pickEnum(['new', 'booked'], allowed).error); // ?status=new&status=booked
  assert.ok(pickEnum({ $ne: 'x' }, allowed).error); //      ?status[$ne]=x
});

test('isObjectIdString needs exactly 24 hex characters', () => {
  assert.equal(isObjectIdString('6acdbd1f77b87c6d817759ce'), true);
  for (const bad of ['6acdbd1f77b87c6d817759c', '6acdbd1f77b87c6d817759cez', '', null, undefined, 42, {}, ['6acdbd1f77b87c6d817759ce']]) {
    assert.equal(isObjectIdString(bad), false, JSON.stringify(bad));
  }
});

// --- origins and CORS --------------------------------------------------------

test('requests with no Origin are allowed, and the dashboard origins are allowed by default', () => {
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin('http://localhost:5173'), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:5173'), true);
  assert.equal(isAllowedOrigin('https://evil.example'), false);
});

test('DASHBOARD_ORIGINS overrides the default list', () => {
  process.env.DASHBOARD_ORIGINS = 'https://dash.example, https://other.example';
  assert.deepEqual(allowedOrigins(), ['https://dash.example', 'https://other.example']);
  assert.equal(isAllowedOrigin('https://dash.example'), true);
  assert.equal(isAllowedOrigin('http://localhost:5173'), false);
  delete process.env.DASHBOARD_ORIGINS;
});

function fakeRes() {
  const res = { headers: {}, statusCode: null, body: undefined };
  res.setHeader = (k, v) => (res.headers[k] = v);
  res.sendStatus = (code) => ((res.statusCode = code), res);
  res.status = (code) => ((res.statusCode = code), res);
  res.json = (body) => ((res.body = body), res);
  return res;
}
function runCors(method, origin) {
  const res = fakeRes();
  let nextCalled = false;
  cors({ method, headers: origin ? { origin } : {} }, res, () => (nextCalled = true));
  return { res, nextCalled };
}

test('cors: an allowed origin gets headers and goes through', () => {
  const { res, nextCalled } = runCors('GET', 'http://localhost:5173');
  assert.equal(res.headers['Access-Control-Allow-Origin'], 'http://localhost:5173');
  assert.equal(nextCalled, true);
});

test('cors: a preflight is answered 204 for an allowed origin and 403 for another', () => {
  assert.equal(runCors('OPTIONS', 'http://localhost:5173').res.statusCode, 204);
  assert.equal(runCors('OPTIONS', 'https://evil.example').res.statusCode, 403);
});

test('cors: a POST (job replay) from another site is refused, a GET is allowed but gets no headers', () => {
  const post = runCors('POST', 'https://evil.example');
  assert.equal(post.res.statusCode, 403);
  assert.equal(post.nextCalled, false);
  const get = runCors('GET', 'https://evil.example');
  assert.equal(get.nextCalled, true);
  assert.equal(get.res.headers['Access-Control-Allow-Origin'], undefined); // the browser will block reading it
});

test('cors: a POST with no Origin (curl, scripts) goes through', () => {
  assert.equal(runCors('POST', undefined).nextCalled, true);
});

// --- event bus ---------------------------------------------------------------

test('publish delivers { type, data, ts } to subscribers, and unsubscribe stops delivery', () => {
  const seen = [];
  const off = subscribe((event) => seen.push(event));
  publish('job.updated', { jobId: 'j1' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'job.updated');
  assert.deepEqual(seen[0].data, { jobId: 'j1' });
  assert.ok(!Number.isNaN(Date.parse(seen[0].ts)));
  off();
  publish('job.updated', { jobId: 'j2' });
  assert.equal(seen.length, 1);
});

test('publish never throws, even when a listener does, so a broken dashboard cannot break a booking', () => {
  const quiet = console.error;
  console.error = () => {};
  const offBad = subscribe(() => {
    throw new Error('boom');
  });
  try {
    assert.doesNotThrow(() => publish('lead.updated', { id: 'l1' }));
  } finally {
    console.error = quiet;
    offBad();
  }
});

test('EVENT_TYPES lists the six events the dashboard understands', () => {
  assert.deepEqual(EVENT_TYPES, [
    'message.created',
    'message.updated',
    'conversation.updated',
    'lead.updated',
    'appointment.updated',
    'job.updated',
  ]);
});

// --- hub ---------------------------------------------------------------------

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.pings = 0;
    this.terminated = false;
    this.closeArgs = null;
  }
  send(message) {
    this.sent.push(JSON.parse(message));
  }
  ping() {
    this.pings++;
  }
  terminate() {
    this.terminated = true;
    this.readyState = 3;
  }
  close(code, reason) {
    this.closeArgs = [code, reason];
    this.readyState = 3;
  }
}

test('the dashboard path is /dashboard', () => {
  assert.equal(DASHBOARD_PATH, '/dashboard');
});

test('hub: a new client gets a hello, and broadcast reaches every open client', () => {
  const hub = createHub();
  const a = new FakeSocket();
  const b = new FakeSocket();
  hub.add(a);
  hub.add(b);
  assert.equal(a.sent[0].type, 'hello');
  hub.broadcast({ type: 'message.created', data: { content: 'hi' } });
  assert.equal(a.sent.at(-1).data.content, 'hi');
  assert.equal(b.sent.at(-1).data.content, 'hi');
  assert.equal(hub.size(), 2);
});

test('hub: closed sockets are skipped and removed, and a send error is contained', () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const hub = createHub();
    const closed = new FakeSocket();
    const broken = new FakeSocket();
    const fine = new FakeSocket();
    for (const ws of [closed, broken, fine]) hub.add(ws);
    closed.readyState = 3;
    closed.emit('close');
    broken.send = () => {
      throw new Error('socket exploded');
    };
    assert.equal(hub.size(), 2);
    assert.doesNotThrow(() => hub.broadcast({ type: 'x', data: {} }));
    assert.equal(fine.sent.at(-1).type, 'x');
    assert.equal(closed.sent.length, 1); // only its hello
  } finally {
    console.error = quiet;
  }
});

test('hub: a socket error removes the client instead of crashing', () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const hub = createHub();
    const ws = new FakeSocket();
    hub.add(ws);
    assert.doesNotThrow(() => ws.emit('error', new Error('reset')));
    assert.equal(hub.size(), 0);
  } finally {
    console.error = quiet;
  }
});

test('hub heartbeat: pings a live client, keeps it after a pong, terminates it after a missed pong', () => {
  const hub = createHub();
  const ws = new FakeSocket();
  hub.add(ws);

  hub.heartbeat(); // first round: ping
  assert.equal(ws.pings, 1);
  assert.equal(ws.isAlive, false);

  ws.emit('pong'); // answered
  hub.heartbeat();
  assert.equal(ws.pings, 2);
  assert.equal(ws.terminated, false);

  hub.heartbeat(); // no pong since the last ping: dead
  assert.equal(ws.terminated, true);
  assert.equal(hub.size(), 0);
});

test('hub: closeAll closes every client with 1001 and empties the set', () => {
  const hub = createHub();
  const ws = new FakeSocket();
  hub.add(ws);
  hub.closeAll();
  assert.equal(ws.closeArgs[0], 1001);
  assert.equal(hub.size(), 0);
});

test('hub: start and stop manage the timer without keeping the process alive', () => {
  const hub = createHub({ heartbeatMs: 5 });
  hub.start();
  hub.start(); // second call is a no-op
  hub.stop();
  hub.stop(); // stopping twice is fine
});

console.log(failures ? `\n${failures} test(s) failed` : '\nAll dashboard tests passed');
process.exit(failures ? 1 : 0);
