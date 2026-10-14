import mongoose from 'mongoose';
import { INTENTS } from './Conversation.js';

const { Schema } = mongoose;

const messageSchema = new Schema(
  {
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
    role: { type: String, enum: ['caller', 'agent', 'system'], required: true },
    content: { type: String, required: true },

    // Only populated on caller messages once the agent has processed them.
    analysis: {
      intent: { type: String, enum: INTENTS },
      confidence: { type: Number, min: 0, max: 1 },
      entities: { type: Schema.Types.Mixed },
      nextAction: {
        type: String,
        enum: ['reply', 'ask_followup', 'create_lead', 'book_appointment', 'escalate', 'end'],
      },
    },

    // Model telemetry, useful for cost and latency dashboards.
    llm: {
      model: String,
      inputTokens: Number,
      outputTokens: Number,
      latencyMs: Number,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

messageSchema.index({ conversation: 1, createdAt: 1 });

export const Message = mongoose.models.Message || mongoose.model('Message', messageSchema);
