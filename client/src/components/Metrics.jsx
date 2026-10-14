const sum = (o) => Object.values(o || {}).reduce((a, b) => a + (Number(b) || 0), 0);

export default function Metrics({ stats }) {
  if (!stats) return <div className="h-14" />;
  const items = [
    { label: 'Confirmed appointments', value: sum(stats.appointments) },
    { label: 'Conversations', value: sum(stats.conversations) },
    { label: 'Booked from chat', value: stats.conversations?.booked ?? 0 },
    { label: 'Leads', value: sum(stats.leads) },
    { label: 'Failed jobs', value: stats.jobs?.dead ?? 0, alert: (stats.jobs?.dead ?? 0) > 0 },
    stats.agent?.avgLatencyMs != null && {
      label: 'Avg reply time',
      value: `${(stats.agent.avgLatencyMs / 1000).toFixed(1)} s`,
    },
  ].filter(Boolean);

  return (
    <dl className="flex flex-wrap gap-x-10 gap-y-3 border-y border-line py-4">
      {items.map((m) => (
        <div key={m.label}>
          <dd className={`text-2xl font-semibold tabular-nums leading-none ${m.alert ? 'text-bad' : ''}`}>
            {typeof m.value === 'number' ? m.value.toLocaleString() : m.value}
          </dd>
          <dt className="mt-1 text-sm text-steel">{m.label}</dt>
        </div>
      ))}
    </dl>
  );
}
