// BullMQ queues and workers for CallFlow.
//
//   bookings        "book-appointment": picks a free slot, creates the Appointment, marks the lead and
//                   conversation as booked, then queues a confirmation.
//   confirmations   "send-confirmation": sends the (simulated) SMS/email and confirms the appointment.
//
// Every attempt is written to the JobLog collection. A job that runs out of retries, or fails in a way
// retrying cannot fix, is recorded as 'dead': that is the dead-letter queue, and replayJob() re-queues it.
import { Queue, Worker, UnrecoverableError } from 'bullmq';
import IORedis from 'ioredis';
import { Appointment, Conversation, JobLog, Lead } from '../models/index.js';
import { publish } from '../realtime/events.js';
import { buildIdempotencyKey, dayRange, describeSlot, isFinalFailure, pickSlot } from './bookingLogic.js';

export const BOOKINGS = 'bookings';
export const CONFIRMATIONS = 'confirmations';

// An error that carries the HTTP status the REST API should answer with.
export class JobError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'JobError';
    this.status = status;
  }
}

const REDIS_URL = () => process.env.REDIS_URL || 'redis://127.0.0.1:6379';

const JOB_OPTIONS = {
  [BOOKINGS]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 }, // waits 2s, then 4s
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
  [CONFIRMATIONS]: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 }, // waits 1s, 2s, 4s, 8s
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
};

// ---------------------------------------------------------------------------
// Connections and queues (created on first use)
// ---------------------------------------------------------------------------

let producerConnection = null;
let workerConnection = null;
const queues = new Map();
let workers = [];
let lastRedisErrorAt = 0;

function watch(connection) {
  // ioredis emits 'error' events, and an unhandled one would crash the process. Log at most one every 10s.
  connection.on('error', (err) => {
    if (Date.now() - lastRedisErrorAt > 10_000) {
      lastRedisErrorAt = Date.now();
      console.error(`[redis] ${err.message}`);
    }
  });
  return connection;
}

function getQueue(name) {
  if (!queues.has(name)) {
    // A producer should fail fast when Redis is down instead of hanging a caller's turn.
    producerConnection ||= watch(new IORedis(REDIS_URL(), { maxRetriesPerRequest: 1 }));
    queues.set(name, new Queue(name, { connection: producerConnection }));
  }
  return queues.get(name);
}

// ---------------------------------------------------------------------------
// Audit trail in MongoDB
// ---------------------------------------------------------------------------

async function logJob(queue, job, status, extra = {}) {
  try {
    const jobId = String(job.id);
    const refs = {};
    if (job.data?.conversationId) refs.conversation = job.data.conversationId;
    if (job.data?.appointmentId) refs.appointment = job.data.appointmentId;

    const onInsert = { name: job.name, payload: job.data, maxAttempts: job.opts?.attempts ?? 1 };
    const event = {
      queue,
      jobId,
      name: job.name,
      status,
      attempts: extra.attempts ?? 0,
      maxAttempts: onInsert.maxAttempts,
      conversationId: job.data?.conversationId ? String(job.data.conversationId) : undefined,
      error: extra.error?.message,
    };

    if (status === 'waiting') {
      // $setOnInsert only: re-adding a job with an id that already exists must not reset its history.
      const result = await JobLog.updateOne(
        { queue, jobId },
        { $setOnInsert: { ...onInsert, ...refs, status: 'waiting', attempts: 0 } },
        { upsert: true }
      );
      // A duplicate add is ignored by BullMQ, so only announce a job that is genuinely new.
      if (result.upsertedCount) publish('job.updated', event);
      return;
    }
    await JobLog.updateOne({ queue, jobId }, { $set: { status, ...refs, ...extra }, $setOnInsert: onInsert }, { upsert: true });
    publish('job.updated', event);
  } catch (err) {
    // The audit trail must never break the work itself.
    console.error(`[jobs] could not write JobLog for ${queue}/${job.id}: ${err.message}`);
  }
}

// Wraps a processor so every attempt is logged, and a final failure is recorded as 'dead'.
function withAudit(queue, handler, onDead) {
  return async (job) => {
    const attempts = job.attemptsStarted ?? (job.attemptsMade || 0) + 1;
    await logJob(queue, job, 'active', { attempts, startedAt: new Date() });
    try {
      const result = await handler(job);
      await logJob(queue, job, 'completed', { attempts, result, finishedAt: new Date() });
      return result;
    } catch (err) {
      const final = isFinalFailure({ err, attemptsStarted: attempts, attempts: job.opts?.attempts });
      await logJob(queue, job, final ? 'dead' : 'failed', {
        attempts,
        error: { message: err.message, stack: err.stack, at: new Date() },
        ...(final ? { finishedAt: new Date() } : {}),
      });
      if (final && onDead) {
        try {
          await onDead(job, err);
        } catch (deadErr) {
          console.error(`[jobs] onDead hook failed for ${queue}/${job.id}: ${deadErr.message}`);
        }
      }
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// Producer
// ---------------------------------------------------------------------------

// payload: { conversationId, leadId?, name, phone?, email?, serviceType, preferredDate: 'YYYY-MM-DD' }
export async function enqueueBooking(payload) {
  const idempotencyKey = buildIdempotencyKey(payload);
  const job = await getQueue(BOOKINGS).add('book-appointment', { ...payload, idempotencyKey }, { ...JOB_OPTIONS[BOOKINGS], jobId: idempotencyKey });
  await logJob(BOOKINGS, job, 'waiting');
  return job;
}

// Re-queues a dead job under a fresh id. The Appointment's idempotency key still protects against double booking.
export async function replayJob(jobLogId) {
  const row = await JobLog.findById(jobLogId);
  if (!row) throw new JobError('Job log entry not found', 404);
  if (row.status !== 'dead') throw new JobError(`Only dead jobs can be replayed (this one is ${row.status})`, 409);
  if (!JOB_OPTIONS[row.queue]) throw new JobError(`Unknown queue: ${row.queue}`, 400);

  const newId = `${row.jobId}-replay-${Date.now()}`;
  const job = await getQueue(row.queue).add(row.name, row.payload, { ...JOB_OPTIONS[row.queue], jobId: newId });
  await logJob(row.queue, job, 'waiting');
  await JobLog.updateOne({ _id: row._id }, { $set: { replayedAt: new Date() } });
  return newId;
}

// ---------------------------------------------------------------------------
// Processors
// ---------------------------------------------------------------------------

async function processBooking(job) {
  const { conversationId, leadId, preferredDate, serviceType, idempotencyKey } = job.data;

  // A retry of a job that already did its work (for example it crashed after saving) finishes quietly.
  const existing = await Appointment.findOne({ idempotencyKey });
  if (existing) return { appointmentId: String(existing._id), scheduledAt: existing.scheduledAt.toISOString(), duplicate: true };

  const lead = (leadId && (await Lead.findById(leadId))) || (await Lead.findOne({ sourceConversation: conversationId }));
  if (!lead) throw new UnrecoverableError('No lead exists for this conversation');

  const range = dayRange(preferredDate);
  if (!range) throw new UnrecoverableError(`Invalid preferred date: ${preferredDate}`);
  const booked = await Appointment.find({ scheduledAt: { $gte: range.start, $lt: range.end }, status: { $in: ['pending', 'confirmed'] } })
    .select('scheduledAt')
    .lean();

  const { slot, reason } = pickSlot({ date: preferredDate, booked: booked.map((b) => b.scheduledAt) });
  if (!slot) {
    // Retrying cannot fix a past date or a full day, so skip straight to the dead-letter log.
    throw new UnrecoverableError(reason === 'past_date' ? `${preferredDate} is in the past` : `No free slots on ${preferredDate}`);
  }

  let appointment;
  try {
    appointment = await Appointment.create({
      lead: lead._id,
      conversation: conversationId,
      serviceType,
      scheduledAt: slot,
      status: 'pending',
      idempotencyKey,
    });
  } catch (err) {
    if (err.code !== 11000) throw err;
    appointment = await Appointment.findOne({ idempotencyKey }); // another attempt created it first
  }

  // Do not overwrite a conversation that has already been escalated to a human.
  const conversationUpdate = await Conversation.updateOne(
    { _id: conversationId, status: { $in: ['active', 'qualified', 'abandoned'] } },
    { $set: { status: 'booked', appointment: appointment._id } }
  );
  await Conversation.updateOne({ _id: conversationId, appointment: { $exists: false } }, { $set: { appointment: appointment._id } });
  await Lead.updateOne({ _id: lead._id }, { $set: { status: 'booked', ...(serviceType ? { serviceType } : {}) } });

  publish('appointment.updated', {
    id: String(appointment._id),
    conversationId: String(conversationId),
    leadName: lead.name,
    serviceType: appointment.serviceType,
    scheduledAt: appointment.scheduledAt,
    status: appointment.status,
  });
  publish('lead.updated', { id: String(lead._id), conversationId: String(conversationId), name: lead.name, status: 'booked' });
  if (conversationUpdate.modifiedCount) publish('conversation.updated', { id: String(conversationId), status: 'booked' });

  const confirmation = await getQueue(CONFIRMATIONS).add(
    'send-confirmation',
    {
      appointmentId: String(appointment._id),
      conversationId: String(conversationId),
      phone: job.data.phone || lead.phone,
      email: job.data.email || lead.email,
    },
    { ...JOB_OPTIONS[CONFIRMATIONS], jobId: `confirm-${appointment._id}` }
  );
  await logJob(CONFIRMATIONS, confirmation, 'waiting');

  return { appointmentId: String(appointment._id), scheduledAt: slot.toISOString(), slot: describeSlot(slot) };
}

// Stand-in for a real SMS or email provider. CONFIRMATION_FAILURE_RATE (0 to 1) makes it fail on purpose,
// which is how the retry and dead-letter behaviour is demonstrated.
async function sendConfirmation({ channel, to, appointment }) {
  const rate = Number(process.env.CONFIRMATION_FAILURE_RATE) || 0;
  if (Math.random() < rate) throw new Error(`Simulated ${channel} provider outage`);
  const when = appointment.scheduledAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  console.log(`[confirm] ${channel} to ${to}: your ${appointment.serviceType} is booked for ${when}`);
}

async function processConfirmation(job) {
  const { appointmentId, phone, email } = job.data;
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw new UnrecoverableError('Appointment not found');
  if (appointment.status === 'cancelled') return { skipped: 'cancelled' };
  if (appointment.confirmation?.sentAt) return { skipped: 'already_sent' };

  const channel = phone ? 'sms' : email ? 'email' : null;
  const update = { status: 'confirmed' };
  if (channel) {
    await sendConfirmation({ channel, to: phone || email, appointment });
    update['confirmation.sentAt'] = new Date();
    update['confirmation.channel'] = channel;
  }
  // With no phone or email there is nothing to send, but the booking itself stands.
  // $unset clears the failure note left by an earlier dead attempt, for example before a replay.
  await Appointment.updateOne({ _id: appointmentId }, { $set: update, $unset: { failureReason: '' } });
  publish('appointment.updated', {
    id: String(appointmentId),
    conversationId: String(appointment.conversation),
    status: 'confirmed',
    failureReason: null,
  });
  return { channel: channel || 'none' };
}

// ---------------------------------------------------------------------------
// Dead-letter hooks: make sure a human can see what went wrong.
// ---------------------------------------------------------------------------

async function onBookingDead(job, err) {
  const reason = `Booking failed: ${err.message}`.slice(0, 300);
  const result = await Conversation.updateOne(
    { _id: job.data.conversationId, status: { $in: ['active', 'qualified', 'abandoned'] } },
    { $set: { status: 'escalated', 'escalation.reason': reason, 'escalation.escalatedAt': new Date() } }
  );
  if (result.modifiedCount) publish('conversation.updated', { id: String(job.data.conversationId), status: 'escalated', escalationReason: reason });
}

async function onConfirmationDead(job, err) {
  const failureReason = `Confirmation failed: ${err.message}`.slice(0, 300);
  await Appointment.updateOne({ _id: job.data.appointmentId }, { $set: { failureReason } });
  publish('appointment.updated', { id: String(job.data.appointmentId), conversationId: String(job.data.conversationId), failureReason });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function startWorkers() {
  if (workers.length) return workers;
  // Workers need maxRetriesPerRequest: null so they keep waiting through a Redis restart.
  workerConnection ||= watch(new IORedis(REDIS_URL(), { maxRetriesPerRequest: null }));

  const make = (queue, processor, onDead, concurrency) => {
    const worker = new Worker(queue, withAudit(queue, processor, onDead), { connection: workerConnection, concurrency });
    worker.on('error', (err) => console.error(`[worker:${queue}] ${err.message}`));
    worker.on('failed', (job, err) => console.warn(`[worker:${queue}] job ${job?.id} failed: ${err.message}`));
    return worker;
  };

  // Concurrency 1 on bookings: two jobs must not pick the same free slot at the same moment.
  workers = [make(BOOKINGS, processBooking, onBookingDead, 1), make(CONFIRMATIONS, processConfirmation, onConfirmationDead, 5)];
  console.log('[queue] workers started (bookings, confirmations)');
  return workers;
}

export async function closeQueues() {
  await Promise.allSettled(workers.map((w) => w.close()));
  workers = [];
  await Promise.allSettled([...queues.values()].map((q) => q.close()));
  queues.clear();
  await Promise.allSettled([producerConnection?.quit(), workerConnection?.quit()]);
  producerConnection = null;
  workerConnection = null;
}
