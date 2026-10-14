import { field, clock, toneFor, who } from './util.js';

const startOf = (a) => field(a, 'startsAt', 'scheduledAt', 'slot', 'start', 'date');

export default function Schedule({ appointments }) {
  const rows = appointments
    .map((a) => ({ a, t: new Date(startOf(a)) }))
    .filter((r) => !isNaN(r.t))
    .sort((x, y) => x.t - y.t);

  const days = rows.reduce((acc, r) => {
    const key = r.t.toDateString();
    (acc[key] ||= []).push(r);
    return acc;
  }, {});

  return (
    <section aria-labelledby="sched">
      <h2 id="sched" className="mb-3 text-lg font-semibold">Appointments</h2>
      {!rows.length && (
        <p className="rounded border border-dashed border-line p-6 text-steel">
          Nothing booked yet. New bookings appear here as soon as a caller confirms a slot.
        </p>
      )}
      <div className="space-y-5">
        {Object.entries(days).map(([key, items]) => {
          const d = items[0].t;
          return (
            <div key={key} className="grid grid-cols-[4.5rem_1fr] gap-4">
              <div className="pt-1">
                <div className="text-3xl font-semibold leading-none tabular-nums">{d.getDate()}</div>
                <div className="mt-1 text-sm text-steel">{`${d.toLocaleDateString([], { weekday: 'short' })}, ${d.toLocaleDateString([], { month: 'short' })}`}</div>
              </div>
              <ul className="divide-y divide-line rounded bg-white">
                {items.map(({ a, t }, i) => (
                  <li key={a._id || a.id || i} className="flex items-center gap-4 px-4 py-3">
                    <span className="w-20 shrink-0 whitespace-nowrap font-medium tabular-nums">{clock(t)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{who(a) || 'Unnamed caller'}</div>
                      <div className="truncate text-sm text-steel">
                        {[field(a, 'serviceType', 'service'), field(a, 'vehicle')].filter(Boolean).join(' on ') || 'Service not captured'}
                        {a.durationMinutes ? `, ${a.durationMinutes} min` : ''}
                      </div>
                    </div>
                    {a.status && <span className={`rounded px-2 py-0.5 text-sm ${toneFor(a.status)}`}>{a.status}</span>}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
