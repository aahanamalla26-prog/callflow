// REST API for the dashboard. Read-only, except for replaying a dead job.
//   GET  /api/stats                    counts per status, plus the agent's average reply time
//   GET  /api/conversations            ?status=&limit=
//   GET  /api/conversations/:id        the conversation with its lead, appointment and messages
//   GET  /api/leads                    ?status=&limit=
//   GET  /api/appointments             ?status=&when=upcoming|past&limit=
//   GET  /api/jobs                     ?status=&queue=&limit=
//   GET  /api/jobs/:id                 one job, including the error stack
//   POST /api/jobs/:id/replay          re-queue a dead job
// Lists answer { items: [...] }, newest first. `limit` defaults to 25 and is capped at 100.
import { Router } from 'express';
import {
  Appointment,
  APPOINTMENT_STATUS,
  Conversation,
  CONVERSATION_STATUS,
  JobLog,
  JOB_STATUS,
  Lead,
  LEAD_STATUS,
  Message,
} from '../models/index.js';
import { BOOKINGS, CONFIRMATIONS, JobError, replayJob } from '../queues/bookingQueue.js';
import { isObjectIdString, parseLimit, pickEnum } from './params.js';

const router = Router();

// Express 4 does not catch rejected promises from async handlers; this forwards them to the error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const ERROR_CODES = { 400: 'bad_request', 404: 'not_found', 409: 'conflict' };
const badRequest = (res, message) => res.status(400).json({ error: 'bad_request', message });

// Reads each optional filter from the query string. Sends the 400 itself and returns null when one is invalid.
function buildFilter(req, res, specs) {
  const filter = {};
  for (const { param, allowed } of specs) {
    const { value, error } = pickEnum(req.query[param], allowed);
    if (error) {
      badRequest(res, `${param} ${error}`);
      return null;
    }
    if (value !== undefined) filter[param] = value;
  }
  return filter;
}

router.get(
  '/stats',
  wrap(async (req, res) => {
    const countBy = (Model) => Model.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
    const [conversations, leads, appointments, jobs, latency] = await Promise.all([
      countBy(Conversation),
      countBy(Lead),
      countBy(Appointment),
      countBy(JobLog),
      Message.aggregate([
        { $match: { role: 'agent', 'llm.latencyMs': { $gt: 0 } } },
        { $group: { _id: null, avgLatencyMs: { $avg: '$llm.latencyMs' }, replies: { $sum: 1 } } },
      ]),
    ]);
    const toMap = (rows) => Object.fromEntries(rows.map((row) => [row._id, row.count]));
    res.json({
      conversations: toMap(conversations),
      leads: toMap(leads),
      appointments: toMap(appointments),
      jobs: toMap(jobs),
      agent: { replies: latency[0]?.replies || 0, avgLatencyMs: Math.round(latency[0]?.avgLatencyMs || 0) },
    });
  })
);

router.get(
  '/conversations',
  wrap(async (req, res) => {
    const filter = buildFilter(req, res, [{ param: 'status', allowed: CONVERSATION_STATUS }]);
    if (!filter) return;
    const items = await Conversation.find(filter)
      .sort({ lastMessageAt: -1, _id: -1 })
      .limit(parseLimit(req.query.limit))
      .populate('lead', 'name phone status qualificationScore')
      .lean();
    res.json({ items });
  })
);

router.get(
  '/conversations/:id',
  wrap(async (req, res) => {
    if (!isObjectIdString(req.params.id)) return badRequest(res, 'Invalid conversation id');
    const conversation = await Conversation.findById(req.params.id).populate('lead').populate('appointment').lean();
    if (!conversation) return res.status(404).json({ error: 'not_found' });
    const messages = await Message.find({ conversation: req.params.id }).sort({ createdAt: 1, _id: 1 }).limit(500).lean();
    res.json({ conversation, messages });
  })
);

router.get(
  '/leads',
  wrap(async (req, res) => {
    const filter = buildFilter(req, res, [{ param: 'status', allowed: LEAD_STATUS }]);
    if (!filter) return;
    const items = await Lead.find(filter).sort({ createdAt: -1, _id: -1 }).limit(parseLimit(req.query.limit)).lean();
    res.json({ items });
  })
);

router.get(
  '/appointments',
  wrap(async (req, res) => {
    const filter = buildFilter(req, res, [{ param: 'status', allowed: APPOINTMENT_STATUS }]);
    if (!filter) return;
    const when = pickEnum(req.query.when, ['upcoming', 'past']);
    if (when.error) return badRequest(res, `when ${when.error}`);

    const now = new Date();
    if (when.value === 'upcoming') filter.scheduledAt = { $gte: now };
    if (when.value === 'past') filter.scheduledAt = { $lt: now };

    const items = await Appointment.find(filter)
      .sort({ scheduledAt: when.value === 'upcoming' ? 1 : -1 })
      .limit(parseLimit(req.query.limit))
      .populate('lead', 'name phone')
      .lean();
    res.json({ items });
  })
);

router.get(
  '/jobs',
  wrap(async (req, res) => {
    const filter = buildFilter(req, res, [
      { param: 'status', allowed: JOB_STATUS },
      { param: 'queue', allowed: [BOOKINGS, CONFIRMATIONS] },
    ]);
    if (!filter) return;
    const items = await JobLog.find(filter)
      .select('-error.stack') // stacks are long; GET /jobs/:id returns them
      .sort({ updatedAt: -1, _id: -1 })
      .limit(parseLimit(req.query.limit))
      .lean();
    res.json({ items });
  })
);

router.get(
  '/jobs/:id',
  wrap(async (req, res) => {
    if (!isObjectIdString(req.params.id)) return badRequest(res, 'Invalid job id');
    const job = await JobLog.findById(req.params.id).lean();
    if (!job) return res.status(404).json({ error: 'not_found' });
    res.json({ job });
  })
);

router.post(
  '/jobs/:id/replay',
  wrap(async (req, res) => {
    if (!isObjectIdString(req.params.id)) return badRequest(res, 'Invalid job id');
    try {
      const jobId = await replayJob(req.params.id);
      res.status(202).json({ queued: true, jobId });
    } catch (err) {
      if (err instanceof JobError) {
        return res.status(err.status).json({ error: ERROR_CODES[err.status] || 'error', message: err.message });
      }
      throw err;
    }
  })
);

router.use((req, res) => res.status(404).json({ error: 'not_found' }));

export function apiErrorHandler(err, req, res, next) {
  console.error(`[api] ${req.method} ${req.originalUrl}: ${err.message}`);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'internal_error' });
}

export default router;
