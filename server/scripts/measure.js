// Measures reply latency and extraction accuracy of the agent, using the real analyzeTurn.
//
//   node scripts/measure.js baseline      # run BEFORE any speed changes
//   node scripts/measure.js tuned         # run AFTER; prints the change against the baseline
//
// Needs Ollama running. No database or Redis required.
import fs from 'node:fs';
import { analyzeTurn } from '../src/agent/analyzeTurn.js'; // <-- adjust to where your file lives

const RUNS = Number(process.env.RUNS || 3); // repeats of the whole script, for stable averages
const label = process.argv[2] || 'run';

// Independent of the app's own date code: the first Friday strictly after today, and tomorrow.
const iso = (d) => d.toLocaleDateString('en-CA');
const today = new Date();
const addDays = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return d; };
const nextFriday = addDays(((5 - today.getDay() + 7) % 7) || 7);

const SCENARIOS = [
  { name: 'greeting', turns: ['Hi, I want to book a service'],
    expect: (a) => a.intent === 'book_appointment' },
  { name: 'one-shot booking', turns: ['I need an oil change this Friday, my name is Ravi'],
    expect: (a, k) => /oil/i.test(k.serviceType || '') && k.name === 'Ravi' && k.preferredDate === iso(nextFriday) },
  { name: 'multi-turn booking', turns: ['I want to book a service', 'A brake service', 'Tomorrow', "I'm Meera"],
    expect: (a, k) => /brake/i.test(k.serviceType || '') && k.name === 'Meera' && k.preferredDate === iso(addDays(1)) },
  { name: 'general question', turns: ['What time do you open on Saturdays?'],
    expect: (a) => a.intent === 'general_question' },
  { name: 'escalation', turns: ['This is unacceptable, let me talk to a manager right now'],
    expect: (a) => a.intent === 'escalate_to_human' },
];

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const avg = (arr) => arr.reduce((a, b) => a + b, 0) / (arr.length || 1);

const latencies = [];
const inTok = [];
const outTok = [];
let cold = null;
let passed = 0;
let total = 0;
const failures = [];

for (let run = 0; run < RUNS; run++) {
  for (const sc of SCENARIOS) {
    const history = [];
    const known = {};
    let last;
    for (const text of sc.turns) {
      last = await analyzeTurn({ text, history, known });
      const ms = last.llm?.latencyMs ?? 0;
      if (cold === null) cold = ms; // very first call includes any model load time
      else latencies.push(ms);
      inTok.push(last.llm?.inputTokens || 0);
      outTok.push(last.llm?.outputTokens || 0);
      history.push({ role: 'caller', content: text }, { role: 'agent', content: last.reply });
      Object.assign(known, last.entities);
    }
    total++;
    if (sc.expect(last, known)) passed++;
    else failures.push(`${sc.name}: intent=${last.intent} known=${JSON.stringify(known)}`);
  }
  process.stdout.write(`run ${run + 1}/${RUNS} done\n`);
}

const result = {
  label,
  model: process.env.OLLAMA_MODEL || 'llama3.2',
  samples: latencies.length,
  coldStartMs: cold,
  avgMs: Math.round(avg(latencies)),
  medianMs: pct(latencies, 50),
  p95Ms: pct(latencies, 95),
  avgInputTokens: Math.round(avg(inTok)),
  avgOutputTokens: Math.round(avg(outTok)),
  accuracy: `${passed}/${total}`,
};

console.table(result);
if (failures.length) console.log('Failed checks:\n' + [...new Set(failures)].join('\n'));
fs.writeFileSync(`measure-${label}.json`, JSON.stringify(result, null, 2));

const basePath = 'measure-baseline.json';
if (label !== 'baseline' && fs.existsSync(basePath)) {
  const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
  const drop = (1 - result.avgMs / base.avgMs) * 100;
  console.log(
    `\nAverage reply time: ${base.avgMs} ms -> ${result.avgMs} ms (${drop.toFixed(0)}% faster)` +
      `\nAccuracy: ${base.accuracy} -> ${result.accuracy}`
  );
}