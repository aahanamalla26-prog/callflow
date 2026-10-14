// Accepts either a bare array or a wrapped list ({ items }, { data }, { conversations }, ...).
const unwrap = (b) =>
  Array.isArray(b)
    ? b
    : b?.items || b?.data || b?.results || b?.conversations || b?.leads || b?.appointments || b?.jobs || [];

async function request(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.message || body?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

const qs = (params = {}) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
  return s ? `?${s}` : '';
};

export const api = {
  stats: () => request('/api/stats'),
  conversations: (p) => request(`/api/conversations${qs(p)}`).then(unwrap),
  leads: (p) => request(`/api/leads${qs(p)}`).then(unwrap),
  appointments: (p) => request(`/api/appointments${qs(p)}`).then(unwrap),
  jobs: (p) => request(`/api/jobs${qs(p)}`).then(unwrap),
  replayJob: (id) => request(`/api/jobs/${id}/replay`, { method: 'POST' }),
};
