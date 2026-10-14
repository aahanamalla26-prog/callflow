import mongoose from 'mongoose';

const { Schema } = mongoose;

export const JOB_STATUS = ['waiting', 'active', 'completed', 'failed', 'dead'];

// Audit trail for BullMQ jobs. Redis holds the live queue state; this collection
// keeps a durable history, and 'dead' rows are the dead-letter queue (jobs that
// exhausted their retries) so they can be inspected and replayed from the dashboard.
const jobLogSchema = new Schema(
  {
    queue: { type: String, required: true, index: true }, // e.g. "confirmations", "bookings"
    jobId: { type: String, required: true },
    name: { type: String, required: true }, // e.g. "send-confirmation"

    status: { type: String, enum: JOB_STATUS, default: 'waiting', index: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },

    payload: { type: Schema.Types.Mixed },
    result: { type: Schema.Types.Mixed },

    error: {
      message: String,
      stack: String,
      at: Date,
    },

    appointment: { type: Schema.Types.ObjectId, ref: 'Appointment' },
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation' },

    startedAt: Date,
    finishedAt: Date,
    // Set when a dead job is manually replayed.
    replayedAt: Date,
  },
  { timestamps: true }
);

jobLogSchema.index({ queue: 1, jobId: 1 }, { unique: true });
jobLogSchema.index({ status: 1, updatedAt: -1 });

export const JobLog = mongoose.models.JobLog || mongoose.model('JobLog', jobLogSchema);
