export const idOf = (o) => o?._id || o?.id;
export const field = (o, ...keys) => keys.map((k) => o?.[k]).find((v) => v != null && v !== '');

export const clock = (d) =>
  new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export const ago = (d) => {
  if (!d) return '';
  const s = Math.max(0, (Date.now() - new Date(d)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' });
};

export const upsert = (list, item) => {
  const id = idOf(item);
  if (!id) return list;
  const i = list.findIndex((x) => idOf(x) === id);
  if (i === -1) return [item, ...list];
  const next = list.slice();
  next[i] = { ...next[i], ...item };
  return next;
};

const TONE = {
  booked: 'bg-ok/10 text-ok', confirmed: 'bg-ok/10 text-ok', completed: 'bg-ok/10 text-ok',
  qualified: 'bg-bay/10 text-bay', active: 'bg-bay/10 text-bay', waiting: 'bg-bay/10 text-bay',
  escalated: 'bg-warn/15 text-warn', failed: 'bg-bad/10 text-bad', dead: 'bg-bad/10 text-bad',
  'dead-lettered': 'bg-bad/10 text-bad',
};
export const toneFor = (s) => TONE[String(s || '').toLowerCase()] || 'bg-line/60 text-steel';

// Caller name/phone may sit on the record itself or on a nested `lead` object.
export const who = (o) =>
  field(o, 'customerName', 'name') || o?.caller?.name || o?.extracted?.name || o?.lead?.name;
export const phoneOf = (o) => field(o, 'phone') || o?.caller?.phone || o?.lead?.phone;
export const service = (o) =>
  [field(o, 'serviceType', 'service') || o?.extracted?.serviceType, o?.extracted?.vehicle || o?.vehicle]
    .filter(Boolean).join(', ');
