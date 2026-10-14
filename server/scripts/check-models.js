// Offline sanity check: loads every model and runs schema validation, no MongoDB needed.
import mongoose from 'mongoose';
import { Conversation, Message, Lead, Appointment, JobLog } from '../src/models/index.js';

const id = () => new mongoose.Types.ObjectId();
let failures = 0;

function expect(label, doc, shouldPass) {
  const err = doc.validateSync();
  const ok = shouldPass ? !err : !!err;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${err && !shouldPass ? ` (rejected: ${Object.keys(err.errors).join(', ')})` : ''}`);
}

expect('Conversation valid', new Conversation({ sessionId: 's-1' }), true);
expect('Conversation missing sessionId', new Conversation({}), false);
expect('Conversation bad status', new Conversation({ sessionId: 's-2', status: 'nope' }), false);

expect('Message valid', new Message({ conversation: id(), role: 'caller', content: 'hi' }), true);
expect('Message bad role', new Message({ conversation: id(), role: 'bot', content: 'hi' }), false);
expect('Message confidence > 1', new Message({ conversation: id(), role: 'caller', content: 'hi', analysis: { confidence: 2 } }), false);

expect('Lead valid', new Lead({ sourceConversation: id(), name: 'Asha' }), true);
expect('Lead score > 100', new Lead({ sourceConversation: id(), qualificationScore: 150 }), false);

expect('Appointment valid', new Appointment({ lead: id(), conversation: id(), serviceType: 'oil change', scheduledAt: new Date(), idempotencyKey: 'k1' }), true);
expect('Appointment missing idempotencyKey', new Appointment({ lead: id(), conversation: id(), serviceType: 'x', scheduledAt: new Date() }), false);

expect('JobLog valid', new JobLog({ queue: 'confirmations', jobId: '1', name: 'send-confirmation' }), true);
expect('JobLog bad status', new JobLog({ queue: 'q', jobId: '2', name: 'n', status: 'stuck' }), false);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll model checks passed');
process.exit(failures ? 1 : 0);
