import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { Conversation, Message, Lead } from '../models/index.js';
import { analyzeTurn } from '../agent/analyzeTurn.js';
import { enqueueBooking } from '../queues/bookingQueue.js';
import { missingBookingFields } from '../queues/bookingLogic.js';
import { publish } from '../realtime/events.js';

const MAX_TEXT_LENGTH = 2000;
const HISTORY_LIMIT = 20; // how many past messages the agent sees
const QUALIFIED_SCORE = 70; // leads at or above this become "qualified"
const FALLBACK_REPLY = "Sorry, I'm having trouble right now. Could you say that again in a moment?";

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

function sessionIdFrom(req) {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    const last = pathname.split('/').filter(Boolean).pop();
    if (last) return decodeURIComponent(last).slice(0, 100);
  } catch {
    // malformed URL: fall through to a generated id
  }
  return `sess_${randomUUID()}`;
}

function send(ws, body) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(body));
}

// What a dashboard needs to show a conversation as a row (see realtime/events.js).
function conversationSnapshot(c) {
  return {
    id: String(c._id),
    sessionId: c.sessionId,
    status: c.status,
    currentIntent: c.currentIntent,
    callerName: c.caller?.name,
    messageCount: c.messageCount,
    startedAt: c.startedAt,
    lastMessageAt: c.lastMessageAt,
  };
}

function publishMessage(message, conversationId, role, content) {
  publish('message.created', {
    id: String(message._id),
    conversationId: String(conversationId),
    role,
    content,
    at: message.createdAt,
  });
}

async function getOrCreateConversation(sessionId) {
  const existing = await Conversation.findOne({ sessionId });
  if (existing) return existing;
  try {
    return await Conversation.create({ sessionId });
  } catch (err) {
    if (err.code === 11000) return Conversation.findOne({ sessionId }); // lost a race on the unique index
    throw err;
  }
}

// Leads only move forward: a booked, handed-off or lost lead keeps its status.
function nextLeadStatus(current, { score, escalated }) {
  if (['booked', 'handed_off', 'lost'].includes(current)) return current;
  if (escalated) return 'handed_off';
  return score >= QUALIFIED_SCORE ? 'qualified' : current;
}

// One lead per conversation (unique index on sourceConversation): create it, then keep updating it.
async function upsertLead(conversationId, fields, { score, escalated }) {
  const existing = await Lead.findOne({ sourceConversation: conversationId });
  if (existing) {
    existing.set({
      ...fields,
      qualificationScore: Math.max(existing.qualificationScore || 0, score), // an angry last message should not erase interest
      status: nextLeadStatus(existing.status, { score, escalated }),
    });
    return existing.save();
  }
  return Lead.create({
    sourceConversation: conversationId,
    ...fields,
    qualificationScore: score,
    status: nextLeadStatus('new', { score, escalated }),
  });
}

// Queues a booking job when the agent has decided to book and we hold everything a booking needs.
// Never throws: a Redis outage must not break the caller's turn.
async function requestBooking({ conversationId, fresh, lead, entities, phone }) {
  if (fresh.appointment || fresh.status === 'booked') return { queued: false, reason: 'already_booked' };

  const extracted = fresh.extracted || {};
  const details = {
    name: entities.name || extracted.name || fresh.caller?.name,
    serviceType: entities.serviceType || extracted.serviceType,
    preferredDate:
      entities.preferredDate || (extracted.preferredDate ? extracted.preferredDate.toISOString().slice(0, 10) : undefined),
  };

  const missing = missingBookingFields(details);
  if (missing.length) return { queued: false, reason: 'missing_info', missing };

  try {
    const job = await enqueueBooking({
      conversationId: String(conversationId),
      leadId: lead ? String(lead._id) : undefined,
      ...details,
      phone: phone || fresh.caller?.phone,
      email: entities.email || fresh.caller?.email,
    });
    return { queued: true, jobId: job.id };
  } catch (err) {
    console.error(`[booking] could not queue booking for ${conversationId}: ${err.message}`);
    return { queued: false, reason: 'queue_unavailable' };
  }
}

// `wss` is created in websocket/index.js, which routes upgrade requests: /dashboard goes to the dashboard
// hub and every other path comes here, with the last path segment as the caller's session id.
export default function setupCallerSocket(wss) {
  wss.on('connection', (ws, req) => {
    const sessionId = sessionIdFrom(req);
    let conversation = null;

    // Everything for this socket runs through one promise chain. Handlers are attached
    // synchronously, so a message sent right after connecting is not lost while we wait on
    // the DB, and two quick messages cannot race each other on the same conversation.
    let chain = Promise.resolve();
    const enqueue = (job) => {
      chain = chain.then(job).catch((err) => {
        console.error(`[ws:${sessionId}]`, err);
        send(ws, { status: 'error', error: 'internal_error' });
      });
    };

    // Without an 'error' listener, a socket error is thrown and can crash the process.
    ws.on('error', (err) => console.error(`[ws:${sessionId}] socket error:`, err.message));

    enqueue(async () => {
      conversation = await getOrCreateConversation(sessionId);
      if (conversation.status === 'abandoned') {
        // Client reconnected to a session whose socket had dropped.
        conversation.status = 'active';
        conversation.endedAt = undefined;
        await conversation.save();
      }
      publish('conversation.updated', conversationSnapshot(conversation));
      send(ws, { status: 'connected', sessionId, conversationId: conversation._id });
    });

    ws.on('message', (data) => {
      enqueue(async () => {
        if (!conversation) return send(ws, { status: 'error', error: 'session_not_ready' });

        let payload;
        try {
          payload = JSON.parse(data.toString());
        } catch {
          return send(ws, { status: 'error', error: 'invalid_json' });
        }

        const text = str(payload?.text);
        if (!text) return send(ws, { status: 'error', error: 'text_required' });
        if (text.length > MAX_TEXT_LENGTH) return send(ws, { status: 'error', error: 'text_too_long' });

        // What the agent needs: the conversation so far, and what we already know about the caller.
        const [recent, fresh] = await Promise.all([
          Message.find({ conversation: conversation._id })
            .sort({ createdAt: -1, _id: -1 })
            .limit(HISTORY_LIMIT)
            .lean(),
          Conversation.findById(conversation._id).lean(),
        ]);
        const history = recent.reverse();
        const extracted = fresh.extracted || {};
        const known = compact({
          name: extracted.name || fresh.caller?.name,
          phone: fresh.caller?.phone,
          email: fresh.caller?.email,
          serviceType: extracted.serviceType,
          vehicle: extracted.vehicle,
          preferredDate: extracted.preferredDate ? extracted.preferredDate.toISOString().slice(0, 10) : undefined,
        });

        // Save the caller's words before the agent runs: nothing a caller says is lost if the agent fails,
        // and a dashboard sees the message straight away instead of after the model has finished thinking.
        const callerMessage = await Message.create({
          conversation: conversation._id,
          role: 'caller',
          content: text,
          analysis: { intent: 'unknown', confidence: 0, nextAction: 'reply' },
        });
        publishMessage(callerMessage, conversation._id, 'caller', text);

        let analysis = null;
        try {
          analysis = await analyzeTurn({ text, history, known });
        } catch (err) {
          console.error(`[agent:${sessionId}] ${err.code || 'error'}: ${err.message}`);
        }

        if (!analysis) {
          const lastMessageAt = new Date();
          await Conversation.updateOne({ _id: conversation._id }, { $set: { lastMessageAt }, $inc: { messageCount: 1 } });
          publish('conversation.updated', {
            id: String(conversation._id),
            messageCount: (fresh.messageCount || 0) + 1,
            lastMessageAt,
          });
          return send(ws, {
            status: 'error',
            error: 'agent_unavailable',
            reply: FALLBACK_REPLY,
            messageId: callerMessage._id,
          });
        }

        await Message.updateOne(
          { _id: callerMessage._id },
          {
            $set: {
              analysis: {
                intent: analysis.intent,
                confidence: analysis.confidence,
                entities: analysis.entities,
                nextAction: analysis.nextAction,
              },
            },
          }
        );
        publish('message.updated', {
          id: String(callerMessage._id),
          conversationId: String(conversation._id),
          intent: analysis.intent,
          confidence: analysis.confidence,
          nextAction: analysis.nextAction,
        });

        const agentMessage = await Message.create({
          conversation: conversation._id,
          role: 'agent',
          content: analysis.reply,
          llm: analysis.llm,
        });
        publishMessage(agentMessage, conversation._id, 'agent', analysis.reply);

        const { entities } = analysis;
        const escalated = analysis.nextAction === 'escalate';
        const phone = str(payload.callerPhone)?.slice(0, 30) || entities.phone;

        let lead = null;
        if (entities.name || phone || fresh.lead) {
          lead = await upsertLead(
            conversation._id,
            compact({
              name: entities.name,
              phone,
              email: entities.email,
              serviceType: entities.serviceType,
              vehicleInterest: entities.vehicle,
            }),
            { score: analysis.qualificationScore, escalated }
          );
          publish('lead.updated', {
            id: String(lead._id),
            conversationId: String(conversation._id),
            name: lead.name,
            phone: lead.phone,
            serviceType: lead.serviceType,
            status: lead.status,
            qualificationScore: lead.qualificationScore,
          });
        }

        const set = { currentIntent: analysis.intent, lastMessageAt: new Date() };
        if (lead) set.lead = lead._id;
        if (entities.name) set['caller.name'] = entities.name;
        if (phone) set['caller.phone'] = phone;
        if (entities.email) set['caller.email'] = entities.email;
        for (const key of ['name', 'serviceType', 'vehicle', 'notes']) {
          if (entities[key]) set[`extracted.${key}`] = entities[key];
        }
        if (entities.preferredDate) set['extracted.preferredDate'] = new Date(entities.preferredDate);

        // Status only moves forward from active/qualified, so a finished conversation is not reopened.
        let status;
        if (escalated) status = 'escalated';
        else if (analysis.nextAction === 'end') status = 'completed';
        else if (lead?.status === 'qualified') status = 'qualified';
        if (status && ['active', 'qualified'].includes(fresh.status)) {
          set.status = status;
          if (escalated) {
            set['escalation.reason'] = analysis.escalationReason || 'Caller asked for a human';
            set['escalation.escalatedAt'] = new Date();
          }
        }

        // +2: the caller's message and the agent's reply.
        await Conversation.updateOne({ _id: conversation._id }, { $set: set, $inc: { messageCount: 2 } });
        publish('conversation.updated', {
          id: String(conversation._id),
          status: set.status || fresh.status,
          currentIntent: analysis.intent,
          callerName: entities.name || fresh.caller?.name,
          messageCount: (fresh.messageCount || 0) + 2,
          lastMessageAt: set.lastMessageAt,
          ...(set['escalation.reason'] ? { escalationReason: set['escalation.reason'] } : {}),
        });

        // Queue after the conversation is saved, so the worker always sees the latest state.
        const booking =
          analysis.nextAction === 'book_appointment'
            ? await requestBooking({ conversationId: conversation._id, fresh, lead, entities, phone })
            : undefined;

        send(ws, {
          status: 'success',
          messageId: callerMessage._id,
          reply: analysis.reply,
          intent: analysis.intent,
          confidence: analysis.confidence,
          nextAction: analysis.nextAction,
          entities,
          leadId: lead?._id,
          booking,
        });
      });
    });

    ws.on('close', () => {
      enqueue(async () => {
        if (!conversation) return;
        // Only an unfinished conversation counts as abandoned; booked/escalated ones keep their status.
        const abandoned = await Conversation.updateOne({ _id: conversation._id, status: 'active' }, { $set: { status: 'abandoned' } });
        const endedAt = new Date();
        await Conversation.updateOne({ _id: conversation._id }, { $set: { endedAt } });
        if (abandoned.modifiedCount) publish('conversation.updated', { id: String(conversation._id), status: 'abandoned', endedAt });
      });
    });
  });

  return wss;
}
