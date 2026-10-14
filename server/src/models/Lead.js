import mongoose from 'mongoose';

const { Schema } = mongoose;

export const LEAD_STATUS = ['new', 'qualified', 'booked', 'handed_off', 'lost'];

const leadSchema = new Schema(
  {
    name: { type: String, trim: true },
    phone: { type: String, trim: true, index: true },
    email: { type: String, trim: true, lowercase: true },

    serviceType: { type: String, trim: true }, // e.g. "oil change", "test drive", "trade-in quote"
    vehicleInterest: { type: String, trim: true },

    status: { type: String, enum: LEAD_STATUS, default: 'new', index: true },
    // 0-100, set by the agent from how complete and intent-rich the conversation was.
    qualificationScore: { type: Number, min: 0, max: 100, default: 0 },

    // Removed redundant inline index: true since unique index is declared below
    sourceConversation: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    notes: String,
  },
  { timestamps: true }
);

// One lead per conversation: unique index handles both uniqueness and indexing
leadSchema.index({ sourceConversation: 1 }, { unique: true });

export const Lead = mongoose.models.Lead || mongoose.model('Lead', leadSchema);