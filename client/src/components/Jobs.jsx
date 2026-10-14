import { useState } from 'react';
import { idOf, field, ago, toneFor } from './util.js';
import { api } from '../api/client.js';

const title = (n = '') => {
  const t = n.replace(/-/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export default function Jobs({ jobs }) {
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState('');

  const replay = async (id) => {
    setBusy(id); setNote('');
    try { await api.replayJob(id); setNote('Job queued again.'); }
    catch (e) { setNote(e.message); }
    finally { setBusy(null); }
  };

  return (
    <section aria-labelledby="jobs">
      <h2 id="jobs" className="mb-3 text-lg font-semibold">Background jobs</h2>
      {note && <p role="status" className="mb-2 text-sm text-steel">{note}</p>}
      <ul className="divide-y divide-line rounded bg-white">
        {jobs.slice(0, 8).map((j) => {
          const id = idOf(j);
          const dead = j.status === 'dead';
          return (
            <li key={id} className="px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{title(j.name || j.queue) || 'Job'}</div>
                  <div className="text-sm text-steel">
                    {ago(field(j, 'finishedAt', 'updatedAt', 'createdAt'))}
                    {j.maxAttempts ? `, ${j.attempts} of ${j.maxAttempts} tries` : ''}
                  </div>
                </div>
                <span className={`rounded px-2 py-0.5 text-sm ${toneFor(j.status)}`}>{j.status || 'queued'}</span>
                {dead && !j.replayedAt && (
                  <button
                    onClick={() => replay(id)}
                    disabled={busy === id}
                    className="rounded border border-bay px-2.5 py-1 text-sm font-medium text-bay hover:bg-bay hover:text-white disabled:opacity-50"
                  >
                    {busy === id ? 'Replaying' : 'Replay'}
                  </button>
                )}
              </div>
              {dead && (
                <p className="mt-1 text-sm text-bad">
                  {j.error?.message || 'Failed'}{j.replayedAt ? '. Already replayed.' : ''}
                </p>
              )}
            </li>
          );
        })}
        {!jobs.length && <li className="px-4 py-6 text-steel">No jobs have run yet.</li>}
      </ul>
    </section>
  );
}
