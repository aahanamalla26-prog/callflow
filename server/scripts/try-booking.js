// Runs one booking through the real queue, workers, MongoDB and Redis, and prints what happened.
//   node scripts/try-booking.js                                  happy path
//   CONFIRMATION_FAILURE_RATE=1 node scripts/try-booking.js      shows retries, the dead-letter entry, then a replay
import 'dotenv/config';
import { connectDB, disconnectDB } from '../src/db/connect.js';
import { Appointment, Conversation, JobLog, Lead } from '../src/models/index.js';
import { enqueueBooking, replayJob, startWorkers, closeQueues } from '../src/queues/bookingQueue.js';

process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/callflow';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TERMINAL = ['completed', 'dead'];

async function rowsFor(conversationId) {
  return JobLog.find({ conversation: conversationId }).sort({ createdAt: 1 }).lean();
}

function printRows(rows) {
  for (const r of rows) {
    const note = r.error?.message ? `  <- ${r.error.message}` : '';
    console.log(`  ${r.queue.padEnd(14)} ${r.status.padEnd(10)} attempts ${r.attempts}/${r.maxAttempts}${note}`);
  }
}

// Waits until every job for the conversation has finished, including the confirmation the booking queues.
async function settle(conversationId, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await rowsFor(conversationId);
    const booking = rows.find((r) => r.queue === 'bookings');
    // The booking job logs its confirmation job before it reports completed, so once the booking has
    // finished, every job that will ever exist for it is already in `rows`.
    const bookingDone = booking && TERMINAL.includes(booking.status);
    if (bookingDone && (booking.status === 'dead' || rows.every((r) => TERMINAL.includes(r.status)))) return rows;
    await sleep(500);
  }
  return rowsFor(conversationId);
}

await connectDB();
startWorkers();

try {
  const conversation = await Conversation.create({ sessionId: `try-booking-${Date.now()}`, status: 'active' });
  const lead = await Lead.create({ sourceConversation: conversation._id, name: 'Asha', phone: '+91 98765 43210', status: 'qualified' });

  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('en-CA'); // YYYY-MM-DD, local
  const payload = {
    conversationId: String(conversation._id),
    leadId: String(lead._id),
    name: 'Asha',
    phone: lead.phone,
    serviceType: 'oil change',
    preferredDate: tomorrow,
  };

  console.log(`Queuing a booking for ${tomorrow} (failure rate ${process.env.CONFIRMATION_FAILURE_RATE || 0})...`);
  await enqueueBooking(payload);
  await enqueueBooking(payload); // same request again: must be ignored, not booked twice

  let rows = await settle(conversation._id);
  console.log('\nJobs:');
  printRows(rows);

  const appointments = await Appointment.find({ conversation: conversation._id }).lean();
  console.log(`\nAppointments created: ${appointments.length} (should be 1 even though the request was queued twice)`);
  for (const a of appointments) {
    console.log(`  ${a.serviceType} at ${a.scheduledAt.toLocaleString()}  status=${a.status}${a.failureReason ? `  (${a.failureReason})` : ''}`);
  }

  const dead = rows.find((r) => r.status === 'dead');
  if (dead) {
    console.log('\nA job ended up dead-lettered. Fixing the provider and replaying it...');
    process.env.CONFIRMATION_FAILURE_RATE = '0';
    const newId = await replayJob(dead._id);
    console.log(`  replayed as ${newId}`);
    rows = await settle(conversation._id);
    console.log('\nJobs after replay:');
    printRows(rows);
    const after = await Appointment.find({ conversation: conversation._id }).lean();
    for (const a of after) console.log(`  appointment status=${a.status}`);
  }

  const saved = await Conversation.findById(conversation._id).lean();
  console.log(`\nConversation status: ${saved.status}`);
} catch (err) {
  console.error('\ntry-booking failed:', err.message);
  process.exitCode = 1;
} finally {
  await closeQueues();
  await disconnectDB();
}
