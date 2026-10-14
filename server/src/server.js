import 'dotenv/config';
import http from 'http';
import express from 'express';
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from './db/connect.js';
import { cors } from './api/origins.js';
import apiRouter, { apiErrorHandler } from './api/routes.js';
import { attachSockets } from './websocket/index.js';
import { startWorkers, closeQueues } from './queues/bookingQueue.js';

const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  const dbUp = mongoose.connection.readyState === 1;
  res.status(dbUp ? 200 : 503).json({
    status: dbUp ? 'ok' : 'degraded',
    db: dbUp,
    timestamp: new Date(),
  });
});

// The dashboard's REST API. `cors` allows the dashboard's origin and refuses state-changing requests from others.
app.use('/api', cors, apiRouter, apiErrorHandler);

const server = http.createServer(app);
const sockets = attachSockets(server); // callers at /<sessionId>, the dashboard feed at /dashboard

const PORT = process.env.PORT || 4000;

async function start() {
  await connectDB();
  startWorkers();
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down`);
  // Open WebSocket connections keep server.close() waiting, so force exit after 10s.
  setTimeout(() => process.exit(1), 10_000).unref();
  sockets.close(); // closes every caller and dashboard socket so server.close() can finish
  server.close(async () => {
    // Each closed caller socket marks its conversation abandoned; give those last writes a moment.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await closeQueues(); // lets an in-flight job finish before the worker stops
    await disconnectDB();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
