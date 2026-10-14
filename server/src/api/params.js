// Query-string parsing for the REST API. Values from req.query can be arrays or objects
// (?status[$ne]=x), so each one is checked to be a plain string before it is used in a Mongo filter.

// Returns a whole number between 1 and `max`; falls back to `fallback` for anything else.
export function parseLimit(raw, fallback = 25, max = 100) {
  if (typeof raw !== 'string' || !/^\d{1,5}$/.test(raw)) return fallback;
  const n = Number(raw);
  return n >= 1 ? Math.min(n, max) : fallback;
}

// { value } when absent or one of `allowed`, { error } otherwise.
export function pickEnum(raw, allowed) {
  if (raw === undefined || raw === '') return { value: undefined };
  if (typeof raw === 'string' && allowed.includes(raw)) return { value: raw };
  return { error: `must be one of: ${allowed.join(', ')}` };
}

// 24 hex characters, which is what a Mongo ObjectId looks like.
export function isObjectIdString(value) {
  return typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
}
