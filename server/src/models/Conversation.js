import mongoose from 'mongoose';

const { Schema } = mongoose;

export const CONVERSATION_STATUS = ['active', 'qualified', 'booked', 'escalated', 'completed', 'abandoned'];
export const INTENTS = ['book_appointment', 'general_question', 'escalate_to_human', 'unknown'];

const conversationSchema = new Schema(
  {
    sessionId: { type: String, required: true, unique: true }, // unique automatically creates an index
    channel: { type: String, enum: ['text', 'voice'], default: 'text' },
    status: { type: String, enum: CONVERSATION_STATUS, default: 'active' },

    caller: {
      name: { type: String, trim: true },
      phone: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
    },

    currentIntent: { type: String, enum: INTENTS, default: 'unknown' },

    extracted: {
      name: String,
      serviceType: String,
      preferredDate: Date,
      vehicle: String,
      notes: String,
    },

    lead: { type: Schema.Types.ObjectId, ref: 'Lead' },
    appointment: { type: Schema.Types.ObjectId, ref: 'Appointment' },

    escalation: {
      reason: String,
      escalatedAt: Date,
    },

    messageCount: { type: Number, default: 0 },
    startedAt: { type: Date, default: Date.now },
    lastMessageAt: { type: Date, default: Date.now },
    endedAt: Date,
  },
  { timestamps: true }
);

// Highly optimized compound index for status and timeline sorting
conversationSchema.index({ status: 1, lastMessageAt: -1 });

export const Conversation = mongoose.models.Conversation || mongoose.model('Conversation', conversationSchema);