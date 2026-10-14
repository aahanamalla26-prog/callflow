// Pure booking logic: no Redis, BullMQ or Mongoose imports, so it can be tested on its own
// (see scripts/test-booking-logic.js). The queue and worker in bookingQueue.js build on it.

export const SLOT_MINUTES = 30;
const FIRST_SLOT = 9 * 60; // 09:00, minutes after midnight
const LAST_SLOT = 16 * 60 + 30; // 16:30, so the last visit ends at 17:00
const PREFERRED_START = 10 * 60; // try 10:00 first

const pad = (n) => String(n).padStart(2, '0');

// 'YYYY-MM-DD' -> { y, m, d }, or null when the string is not a real calendar day.
export function parseDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof value === 'string' ? value : '');
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(y, m - 1, d);
  const real = probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d;
  return real ? { y, m, d } : null;
}

// Local-time start and end of a day, for querying the appointments already booked on it.
export function dayRange(value) {
  const day = parseDay(value);
  if (!day) return null;
  return { start: new Date(day.y, day.m - 1, day.d), end: new Date(day.y, day.m - 1, day.d + 1) };
}

// Slots in the order we try them: 10:00 through 16:30, then 09:00 and 09:30.
export function candidateSlots(value) {
  const day = parseDay(value);
  if (!day) return [];
  const minutes = [];
  for (let m = PREFERRED_START; m <= LAST_SLOT; m += SLOT_MINUTES) minutes.push(m);
  for (let m = FIRST_SLOT; m < PREFERRED_START; m += SLOT_MINUTES) minutes.push(m);
  return minutes.map((m) => new Date(day.y, day.m - 1, day.d, Math.floor(m / 60), m % 60));
}

// Picks the first free slot on the requested day. `booked` is a list of Dates already taken.
// Returns { slot, reason }: slot is null with reason 'invalid_date', 'past_date' or 'no_slots'.
export function pickSlot({ date, booked = [], now = new Date() }) {
  const range = dayRange(date);
  if (!range) return { slot: null, reason: 'invalid_date' };
  if (range.end <= now) return { slot: null, reason: 'past_date' };

  const taken = new Set(booked.map((d) => new Date(d).getTime()));
  const slot = candidateSlots(date).find((s) => s > now && !taken.has(s.getTime()));
  return slot ? { slot, reason: null } : { slot: null, reason: 'no_slots' };
}

// Which of the three things needed for a booking are still missing.
export function missingBookingFields({ name, serviceType, preferredDate } = {}) {
  const missing = [];
  if (!name) missing.push('name');
  if (!serviceType) missing.push('serviceType');
  if (!parseDay(preferredDate)) missing.push('preferredDate');
  return missing;
}

const slug = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

// The same caller asking for the same service on the same day maps to the same key, so a retried
// or repeated request can never create a second appointment. It is used both as the Appointment's
// idempotencyKey and as the BullMQ job id: it starts with a letter and has no colons, which
// BullMQ requires of custom ids.
export function buildIdempotencyKey({ conversationId, preferredDate, serviceType }) {
  return `appt-${conversationId}-${preferredDate}-${slug(serviceType) || 'service'}`;
}

// True when a failed job will not be retried: either the processor threw UnrecoverableError, or
// this was the last allowed attempt. `attemptsStarted` counts the attempt that just failed.
export function isFinalFailure({ err, attemptsStarted, attempts }) {
  if (err?.name === 'UnrecoverableError') return true;
  return (attemptsStarted || 1) >= (attempts || 1);
}

export function describeSlot(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
