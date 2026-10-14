import { clock } from './util.js';

const COPY = {
  'message.created': 'New message',
  'message.updated': 'Message analysed',
  'conversation.updated': 'Conversation changed',
  'lead.updated': 'Lead changed',
  'appointment.updated': 'Appointment changed',
  'job.updated': 'Job changed',
};

const summary = (e) => {
  const p = e.payload || {};
  switch (e.type) {
    case 'message.created': return `${p.role === 'agent' ? 'Agent' : 'Caller'}: ${p.content}`;
    case 'message.updated': return [p.intent?.replace(/_/g, ' '), p.confidence != null && `${Math.round(p.confidence * 100)}% sure`].filter(Boolean).join(', ');
    case 'conversation.updated': return [p.sessionId, p.status].filter(Boolean).join(', ');
    default: return p.status || p.name || '';
  }
};

export default function Feed({ events }) {
  return (
    <section aria-labelledby="feed">
      <h2 id="feed" className="mb-3 text-lg font-semibold">Live activity</h2>
      <ol className="max-h-[26rem] divide-y divide-line overflow-y-auto rounded bg-white" aria-live="polite">
        {events.map((e) => (
          <li key={e.key} className="px-4 py-2.5">
            <div className="flex justify-between gap-3 text-sm">
              <span className="font-medium">{COPY[e.type] || e.type}</span>
              <span className="tabular-nums text-steel">{clock(e.at)}</span>
            </div>
            {summary(e) && <p className="truncate text-sm text-steel">{summary(e)}</p>}
          </li>
        ))}
        {!events.length && <li className="px-4 py-6 text-steel">Waiting for the first event. Start a chat session to see it here.</li>}
      </ol>
    </section>
  );
}
