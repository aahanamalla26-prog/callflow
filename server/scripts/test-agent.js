// Offline tests for the agent module. No API key, Ollama, network or database needed.
//   node scripts/test-agent.js
import assert from 'node:assert/strict';
import {
  analyzeTurn,
  buildApiMessages,
  buildSystemPrompt,
  buildTool,
  normalizeAnalysis,
  AgentError,
} from '../src/agent/analyzeTurn.js';
import { buildCalendar, isPastDate, looksLikeDate, resolveRelativeDate, toISODate } from '../src/agent/dates.js';

delete process.env.ANTHROPIC_API_KEY; // the tests choose the model path themselves
delete process.env.ANTHROPIC_MODEL;
delete process.env.AGENT_STRICT_TOOLS;
delete process.env.OLLAMA_MODEL;
delete process.env.OLLAMA_URL;

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

const MON = new Date(2026, 9, 12, 10, 0); // Mon 12 Oct 2026, local time
const TUE = new Date(2026, 9, 13, 11, 0); // Tue 13 Oct 2026, local time

const toolUse = (input) => [{ type: 'tool_use', id: 'toolu_1', name: 'record_turn', input }];
function fakeClient(content) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (request) => {
        calls.push(request);
        return { model: 'fake-model', stop_reason: 'tool_use', usage: { input_tokens: 11, output_tokens: 7 }, content };
      },
    },
  };
}

// A stand-in for fetch() talking to Ollama. `content` is what the model "said".
function fakeOllama(content, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok, status, json: async () => ({ message: { content }, prompt_eval_count: 10, eval_count: 5 }) };
  };
  return { calls, fetchImpl };
}

const ollamaReply = (fields) =>
  JSON.stringify({
    intent: 'book_appointment',
    confidence: 0.9,
    next_action: 'ask_followup',
    qualification_score: 50,
    escalation_reason: '',
    entities: {},
    reply: 'Okay.',
    ...fields,
  });

const goodInput = {
  intent: 'book_appointment',
  confidence: 0.92,
  next_action: 'ask_followup',
  qualification_score: 55,
  escalation_reason: '',
  entities: { name: 'Asha', phone: '', email: '', serviceType: 'oil change', vehicle: '', preferredDate: '2026-10-16', notes: '' },
  reply: 'Sure, what name should I put it under?',
};

// --- dates -----------------------------------------------------------------

await test('toISODate uses the local calendar day', () => {
  assert.equal(toISODate(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

await test('buildCalendar lists 14 days with weekday names, today and tomorrow marked', () => {
  const lines = buildCalendar(TUE, 14).split('\n');
  assert.equal(lines.length, 14);
  assert.equal(lines[0], '- Tuesday 2026-10-13 (today)');
  assert.equal(lines[1], '- Wednesday 2026-10-14 (tomorrow)');
  assert.ok(lines.includes('- Friday 2026-10-16'));
  assert.ok(lines.includes('- Friday 2026-10-23'));
});

await test('resolveRelativeDate turns what the caller said into the right day', () => {
  const cases = [
    ['I need an oil change this Friday', '2026-10-16'],
    ['friday works', '2026-10-16'],
    ['next Friday please', '2026-10-23'],
    ['tomorrow morning', '2026-10-14'],
    ['the day after tomorrow', '2026-10-15'],
    ['today if possible', '2026-10-13'],
    ['Tuesday', '2026-10-20'], // today is Tuesday, so a bare "Tuesday" means next week's
    ['on Saturday', '2026-10-17'],
    ['next Tuesday', '2026-10-20'],
    ['Monday or Friday', ''], // two different days: do not guess
    ['no day mentioned', ''],
    ['', ''],
  ];
  for (const [text, expected] of cases) assert.equal(resolveRelativeDate(text, TUE), expected, text);
});

await test('resolveRelativeDate does not match inside other words', () => {
  assert.equal(resolveRelativeDate('Fridays are busy for me', TUE), '');
  assert.equal(resolveRelativeDate(undefined, TUE), '');
});

await test('looksLikeDate recognises explicit dates only', () => {
  for (const yes of ['on Oct 20', '20th', '20/10', '2026-10-20', 'October 20']) assert.equal(looksLikeDate(yes), true, yes);
  for (const no of ['My name is Asha', 'tomorrow', 'oil change']) assert.equal(looksLikeDate(no), false, no);
});

await test('isPastDate compares calendar days', () => {
  assert.equal(isPastDate('2026-10-12', TUE), true);
  assert.equal(isPastDate('2026-10-13', TUE), false);
  assert.equal(isPastDate('2026-10-14', TUE), false);
});

// --- prompt, tool, messages ------------------------------------------------

await test('buildApiMessages merges same-side turns, drops a leading agent turn, ends with the new text', () => {
  const messages = buildApiMessages(
    [
      { role: 'agent', content: 'Welcome!' },
      { role: 'caller', content: 'hi' },
      { role: 'caller', content: 'I need an oil change' },
      { role: 'agent', content: 'Which day?' },
      { role: 'system', content: 'ignored' },
    ],
    'Friday'
  );
  assert.deepEqual(messages, [
    { role: 'user', content: 'hi\nI need an oil change' },
    { role: 'assistant', content: 'Which day?' },
    { role: 'user', content: 'Friday' },
  ]);
});

await test('buildSystemPrompt includes today, the calendar, the booking rules and what is already known', () => {
  const prompt = buildSystemPrompt({ known: { name: 'Asha', phone: '' }, now: MON });
  assert.match(prompt, /Monday, October 12, 2026/);
  assert.match(prompt, /- Friday 2026-10-16/);
  assert.match(prompt, /never calculate a date yourself/);
  assert.match(prompt, /Do not say the appointment is booked, noted or confirmed until you have all three/);
  assert.match(prompt, /- name: Asha/);
  assert.doesNotMatch(prompt, /- phone:/);
});

await test('buildTool is strict by default, with every field required and no extra properties', () => {
  const tool = buildTool();
  assert.equal(tool.strict, true);
  assert.equal(tool.input_schema.additionalProperties, false);
  assert.deepEqual([...tool.input_schema.required].sort(), Object.keys(tool.input_schema.properties).sort());
  const entities = tool.input_schema.properties.entities;
  assert.equal(entities.additionalProperties, false);
  assert.deepEqual([...entities.required].sort(), Object.keys(entities.properties).sort());
  assert.equal('strict' in buildTool(false), false);
});

// --- normalizeAnalysis -----------------------------------------------------

await test('normalizeAnalysis keeps good values and drops empty entities', () => {
  const result = normalizeAnalysis(goodInput);
  assert.equal(result.intent, 'book_appointment');
  assert.equal(result.nextAction, 'ask_followup');
  assert.equal(result.qualificationScore, 55);
  assert.deepEqual(result.entities, { name: 'Asha', serviceType: 'oil change', preferredDate: '2026-10-16' });
});

await test('normalizeAnalysis repairs bad values instead of passing them on', () => {
  const result = normalizeAnalysis({
    intent: 'make_coffee',
    confidence: 7,
    next_action: 'dance',
    qualification_score: 140.6,
    entities: { phone: 'abc', email: 'not-an-email', preferredDate: '2026-02-31', name: '  Ravi  ' },
    reply: '   ',
  });
  assert.equal(result.intent, 'unknown');
  assert.equal(result.nextAction, 'reply');
  assert.equal(result.confidence, 1);
  assert.equal(result.qualificationScore, 100);
  assert.deepEqual(result.entities, { name: 'Ravi' });
  assert.ok(result.reply.length > 0);
});

await test('normalizeAnalysis keeps intent and next action consistent on escalation', () => {
  const a = normalizeAnalysis({ intent: 'general_question', next_action: 'escalate', entities: {} });
  assert.deepEqual([a.intent, a.nextAction], ['escalate_to_human', 'escalate']);
  const b = normalizeAnalysis({ intent: 'escalate_to_human', next_action: 'reply', entities: {} });
  assert.deepEqual([b.intent, b.nextAction], ['escalate_to_human', 'escalate']);
});

await test('normalizeAnalysis survives garbage input', () => {
  for (const input of [null, undefined, 'x', 42, [], { entities: 'nope' }]) {
    const result = normalizeAnalysis(input);
    assert.equal(result.intent, 'unknown');
    assert.deepEqual(result.entities, {});
  }
});

// --- Anthropic path --------------------------------------------------------

await test('Anthropic path sends the expected request and parses the tool call', async () => {
  const client = fakeClient(toolUse(goodInput));
  const result = await analyzeTurn(
    { text: 'oil change friday', history: [{ role: 'caller', content: 'hello' }, { role: 'agent', content: 'Hi, how can I help?' }], known: {} },
    { client, now: MON }
  );

  const request = client.calls[0];
  assert.equal(request.model, 'claude-haiku-5-5');
  assert.equal(request.tools[0].name, 'record_turn');
  assert.equal(request.tools[0].strict, true);
  assert.deepEqual(request.tool_choice, { type: 'auto' });
  assert.deepEqual(
    request.messages.map((m) => m.role),
    ['user', 'assistant', 'user']
  );
  assert.equal(request.messages.at(-1).content, 'oil change friday');

  assert.equal(result.intent, 'book_appointment');
  assert.equal(result.reply, 'Sure, what name should I put it under?');
  assert.deepEqual(result.llm, { model: 'fake-model', inputTokens: 11, outputTokens: 7, latencyMs: result.llm.latencyMs });
});

await test('ANTHROPIC_MODEL and AGENT_STRICT_TOOLS=false are respected', async () => {
  process.env.ANTHROPIC_MODEL = 'some-other-model';
  process.env.AGENT_STRICT_TOOLS = 'false';
  const client = fakeClient(toolUse(goodInput));
  await analyzeTurn({ text: 'hi' }, { client, now: MON });
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.AGENT_STRICT_TOOLS;
  assert.equal(client.calls[0].model, 'some-other-model');
  assert.equal('strict' in client.calls[0].tools[0], false);
});

await test('Anthropic path throws no_tool_call when the model answers with plain text', async () => {
  const client = fakeClient([{ type: 'text', text: 'Hello there' }]);
  await assert.rejects(
    analyzeTurn({ text: 'hi' }, { client }),
    (err) => err instanceof AgentError && err.code === 'no_tool_call'
  );
});

// --- Ollama path -----------------------------------------------------------

await test('with no key and no client, the local Ollama model is used', async () => {
  const ollama = fakeOllama(ollamaReply({ intent: 'general_question', next_action: 'reply', reply: 'We open at nine.' }));
  const result = await analyzeTurn({ text: 'When do you open?' }, { fetchImpl: ollama.fetchImpl, now: MON });

  const call = ollama.calls[0];
  assert.equal(call.url, 'http://localhost:11434/api/chat');
  assert.equal(call.body.model, 'llama3.2');
  assert.equal(call.body.format, 'json');
  assert.equal(call.body.stream, false);
  assert.equal(call.body.messages[0].role, 'system');
  assert.match(call.body.messages[0].content, /- Friday 2026-10-16/); // the calendar reaches the local model too
  assert.equal(result.reply, 'We open at nine.');
  assert.deepEqual(result.llm, { model: 'llama3.2', inputTokens: 10, outputTokens: 5, latencyMs: result.llm.latencyMs });
});

await test('Ollama output wrapped in a code fence still parses', async () => {
  const ollama = fakeOllama('```json\n' + ollamaReply({ reply: 'Fenced reply.' }) + '\n```');
  const result = await analyzeTurn({ text: 'hi' }, { fetchImpl: ollama.fetchImpl, now: MON });
  assert.equal(result.reply, 'Fenced reply.');
});

await test('Ollama output that is not JSON becomes a plain reply', async () => {
  const ollama = fakeOllama('Sure, I can help with that.');
  const result = await analyzeTurn({ text: 'hi' }, { fetchImpl: ollama.fetchImpl, now: MON });
  assert.equal(result.reply, 'Sure, I can help with that.');
  assert.equal(result.intent, 'unknown');
});

await test('an Ollama HTTP error gives the fallback reply instead of throwing', async () => {
  const ollama = fakeOllama('', { ok: false, status: 500 });
  const result = await analyzeTurn({ text: 'hi' }, { fetchImpl: ollama.fetchImpl, now: MON });
  assert.match(result.reply, /didn't catch that/);
  assert.equal(result.llm.inputTokens, 0);
});

// --- corrections applied to the model's output -----------------------------

await test("the caller's own words fix a wrong date from the model (Friday, not Thursday)", async () => {
  const ollama = fakeOllama(ollamaReply({ entities: { serviceType: 'oil change', preferredDate: '2026-10-15' } }));
  const result = await analyzeTurn({ text: 'I need an oil change this Friday' }, { fetchImpl: ollama.fetchImpl, now: MON });
  assert.equal(result.entities.preferredDate, '2026-10-16');
});

await test('a date we already hold is kept when the model re-emits a wrong one on a later turn', async () => {
  const ollama = fakeOllama(
    ollamaReply({ next_action: 'book_appointment', entities: { name: 'Asha', preferredDate: '2026-10-15' }, reply: 'Noted, a confirmation will follow.' })
  );
  const known = { serviceType: 'oil change', preferredDate: '2026-10-16' };
  const result = await analyzeTurn({ text: 'My name is Asha', known }, { fetchImpl: ollama.fetchImpl, now: MON });
  assert.equal(result.entities.preferredDate, '2026-10-16');
  assert.equal(result.nextAction, 'book_appointment');
});

await test('a new explicit date from the caller replaces the one we hold', async () => {
  const ollama = fakeOllama(ollamaReply({ entities: { preferredDate: '2026-10-20' } }));
  const result = await analyzeTurn(
    { text: 'Actually make it October 20', known: { preferredDate: '2026-10-16' } },
    { fetchImpl: ollama.fetchImpl, now: MON }
  );
  assert.equal(result.entities.preferredDate, '2026-10-20');
});

await test('a date in the past is dropped', async () => {
  const ollama = fakeOllama(ollamaReply({ entities: { serviceType: 'brake service', preferredDate: '2026-10-01' } }));
  const result = await analyzeTurn({ text: 'brake service on 1 October' }, { fetchImpl: ollama.fetchImpl, now: MON });
  assert.equal(result.entities.preferredDate, undefined);
});

await test('a premature "booked" reply is replaced by a question and the action becomes ask_followup', async () => {
  const ollama = fakeOllama(
    ollamaReply({ next_action: 'book_appointment', entities: { serviceType: 'oil change' }, reply: 'Your appointment is confirmed.' })
  );
  const result = await analyzeTurn({ text: 'Book me an oil change tomorrow' }, { fetchImpl: ollama.fetchImpl, now: MON });
  assert.equal(result.nextAction, 'ask_followup');
  assert.equal(result.reply, 'Could I have your name for the booking?');
  assert.equal(result.entities.preferredDate, '2026-10-13');
});

await test('a natural follow-up question from the model is kept as it is', async () => {
  const ollama = fakeOllama(
    ollamaReply({ next_action: 'book_appointment', entities: { serviceType: 'oil change' }, reply: 'Sure, what name should I put it under?' })
  );
  const result = await analyzeTurn({ text: 'oil change on Friday' }, { fetchImpl: ollama.fetchImpl, now: MON });
  assert.equal(result.nextAction, 'ask_followup');
  assert.equal(result.reply, 'Sure, what name should I put it under?');
});

await test('a complete booking request stays a booking', async () => {
  const ollama = fakeOllama(
    ollamaReply({
      next_action: 'book_appointment',
      entities: { name: 'Asha', serviceType: 'oil change', preferredDate: '2026-10-15' },
      reply: 'Noted, Asha. A confirmation will follow shortly.',
    })
  );
  const result = await analyzeTurn({ text: "I'm Asha, oil change this Friday" }, { fetchImpl: ollama.fetchImpl, now: MON });
  assert.equal(result.nextAction, 'book_appointment');
  assert.equal(result.entities.preferredDate, '2026-10-16');
  assert.equal(result.reply, 'Noted, Asha. A confirmation will follow shortly.');
});

console.log(failures ? `\n${failures} test(s) failed` : '\nAll agent tests passed');
process.exit(failures ? 1 : 0);
