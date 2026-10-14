import mongoose from 'mongoose';

const { Schema } = mongoose;

export const APPOINTMENT_STATUS = ['pending', 'confirmed', 'cancelled', 'completed', 'failed'];

const appointmentSchema = new Schema(
  {
    lead: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },

    serviceType: { type: String, required: true, trim: true },
    scheduledAt: { type: Date, required: true }, // Removed redundant inline index: true
    durationMinutes: { type: Number, default: 30 },

    status: { type: String, enum: APPOINTMENT_STATUS, default: 'pending', index: true },

    // Guards against double-booking when a queue job is retried.
    idempotencyKey: { type: String, required: true, unique: true },

    confirmation: {
      sentAt: Date,
      channel: { type: String, enum: ['sms', 'email'] },
    },
    failureReason: String,
  },
  { timestamps: true }
);

// Slot lookups: covers scheduledAt lookups efficiently via compound index
appointmentSchema.index({ scheduledAt: 1, status: 1 });

export const Appointment = mongoose.models.Appointment || mongoose.model('Appointment', appointmentSchema);