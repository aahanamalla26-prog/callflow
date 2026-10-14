import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api/client.js';
import { useDashboardSocket } from './hooks/useDashboardSocket.js';
import { upsert } from './components/util.js';
import Metrics from './components/Metrics.jsx';
import Schedule from './components/Schedule.jsx';
import Conversations from './components/Conversations.jsx';
import Jobs from './components/Jobs.jsx';
import Feed from './components/Feed.jsx';

const BADGE = {
  live: ['bg-ok', 'Live'],
  connecting: ['bg-warn', 'Connecting'],
  offline: ['bg-bad', 'Disconnected, retrying'],
};

// Maps socket event names to the list they patch.
const TARGET = {
  'conversation.updated': 'conversations',
  'appointment.updated': 'appointments',
  'job.updated': 'jobs',
};

let seq = 0;

export default function App() {
  const [stats, setStats] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [appointments, setAppointments] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [events, setEvents] = useState([]);
  const [filter, setFilter] = useState('');
  const [filterError, setFilterError] = useState('');
  const [loadError, setLoadError] = useState('');
  const statsTimer = useRef();

  const refreshStats = useCallback(() => {
    clearTimeout(statsTimer.current);
    statsTimer.current = setTimeout(() => api.stats().then(setStats).catch(() => {}), 400);
  }, []);

  useEffect(() => {
    Promise.allSettled([api.stats(), api.appointments({ limit: 50 }), api.jobs()]).then(([s, a, j]) => {
      if (s.status === 'fulfilled') setStats(s.value);
      if (a.status === 'fulfilled') setAppointments(a.value);
      if (j.status === 'fulfilled') setJobs(j.value);
      if ([s, a, j].some((r) => r.status === 'rejected'))
        setLoadError('Some data could not be loaded. Check that the Node server is running on port 4000.');
    });
  }, []);

  useEffect(() => {
    setFilterError('');
    api.conversations({ status: filter, limit: 25 })
      .then(setConversations)
      .catch((e) => setFilterError(e.status === 400 ? `That filter was rejected: ${e.message}` : e.message));
  }, [filter]);

  const onEvent = useCallback((e) => {
    const type = e.type || e.event;
    const payload = e.data ?? e.payload ?? e;
    if (type === 'hello') return;
    setEvents((prev) => [{ key: ++seq, type, payload, at: e.ts || Date.now() }, ...prev].slice(0, 60));

    const t = TARGET[type];
    if (t === 'conversations') setConversations((l) => upsert(l, payload));
    if (t === 'appointments') setAppointments((l) => upsert(l, payload));
    if (t === 'jobs') setJobs((l) => upsert(l, payload));
    refreshStats();
  }, [refreshStats]);

  const status = useDashboardSocket(onEvent);
  const [dot, label] = BADGE[status];

  return (
    <div className="mx-auto max-w-7xl px-5 py-6 sm:px-8">
      <header className="mb-5 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Service desk</h1>
        <div className="flex items-center gap-2 text-sm" role="status">
          <span className={`h-2.5 w-2.5 rounded-full ${dot} ${status === 'live' ? 'animate-pulse' : ''}`} />
          {label}
        </div>
      </header>

      {loadError && <p role="alert" className="mb-4 rounded bg-bad/10 px-4 py-3 text-bad">{loadError}</p>}

      <Metrics stats={stats} />

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-10">
          <Schedule appointments={appointments} />
          <Conversations rows={conversations} status={filter} onStatus={setFilter} error={filterError} />
        </div>
        <aside className="space-y-10">
          <Feed events={events} />
          <Jobs jobs={jobs} />
        </aside>
      </div>
    </div>
  );
}
