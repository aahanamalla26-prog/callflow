// A tiny in-process event bus. The handler, the queue workers and the REST API call publish(); the
// dashboard hub subscribes and pushes each event to connected dashboards. Keeping it separate means
// none of those modules needs to know about the others.
//
// It works because the queue workers run in the same process as the server. If they ever move to
// their own process, swap this for Redis pub/sub: publish() and subscribe() are all anything else uses.
//
// Every event is { type, data, ts }. The data for each type:
//   message.created       { id, conversationId, role: 'caller' | 'agent', content, at }
//   message.updated       { id, conversationId, intent, confidence, nextAction }   analysis arrived for a caller message
//   conversation.updated  { id, ...changed fields }   partial: merge into the conversation with the same id
//   lead.updated          { id, conversationId, name?, status, ... }
//   appointment.updated   { id, conversationId, status?, scheduledAt?, serviceType?, failureReason? }
//   job.updated           { queue, jobId, name, status, attempts, maxAttempts, conversationId?, error? }
import { EventEmitter } from 'node:events';

export const EVENT_TYPES = [
  'message.created',
  'message.updated',
  'conversation.updated',
  'lead.updated',
  'appointment.updated',
  'job.updated',
];

const bus = new EventEmitter();
bus.setMaxListeners(50);

// Never throws: a broken listener must not break a caller's turn or a booking job.
export function publish(type, data) {
  try {
    bus.emit('event', { type, data, ts: new Date().toISOString() });
  } catch (err) {
    console.error(`[events] listener failed for ${type}: ${err.message}`);
  }
}

// Returns a function that removes the listener again.
export function subscribe(listener) {
  bus.on('event', listener);
  return () => bus.off('event', listener);
}
