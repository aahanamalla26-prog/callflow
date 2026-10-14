import { idOf, field, ago, toneFor, who, phoneOf, service } from './util.js';

const STATUSES = ['active', 'booked', 'abandoned', 'escalated'];

export default function Conversations({ rows, status, onStatus, error }) {
  return (
    <section aria-labelledby="conv">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="conv" className="text-lg font-semibold">Conversations</h2>
        <label className="flex items-center gap-2 text-sm text-steel">
          Show
          <select
            value={status}
            onChange={(e) => onStatus(e.target.value)}
            className="rounded border border-line bg-white px-2 py-1 text-ink"
          >
            <option value="">All</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>
      {error && <p role="alert" className="mb-3 rounded bg-warn/15 px-3 py-2 text-sm text-warn">{error}</p>}
      <div className="overflow-x-auto rounded bg-white">
        <table className="w-full text-left">
          <thead className="border-b border-line text-sm text-steel">
            <tr>
              <th className="px-4 py-2 font-medium">Caller</th>
              <th className="px-4 py-2 font-medium">Wants</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 text-right font-medium">Updated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((c) => (
              <tr key={idOf(c)}>
                <td className="px-4 py-3">
                  <div className="font-medium">{who(c) || (c.sessionId ? `Session ${c.sessionId}` : 'Unknown caller')}</div>
                  <div className="text-sm text-steel">{phoneOf(c) || (who(c) ? 'No phone yet' : 'No details yet')}</div>
                </td>
                <td className="px-4 py-3 text-sm">
                  {service(c) || <span className="text-steel">Not yet</span>}
                </td>
                <td className="px-4 py-3">
                  <span className={`rounded px-2 py-0.5 text-sm ${toneFor(c.status)}`}>{c.status || 'active'}</span>
                </td>
                <td className="px-4 py-3 text-right text-sm text-steel">{ago(field(c, 'lastMessageAt', 'updatedAt', 'createdAt'))}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan="4" className="px-4 py-8 text-center text-steel">No conversations match this filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
