// Runs a short fake phone call through the real Claude API so you can check your key and the
// agent's behaviour without the WebSocket server or MongoDB.
//   node scripts/try-agent.js
import 'dotenv/config';
import { analyzeTurn } from '../src/agent/analyzeTurn.js';

const caller = [
  'Hi, I need an oil change for my Honda City. Could I come in this Friday?',
  "It's Asha, and my number is 98765 43210.",
  'Actually, this is ridiculous. I want to talk to a real person about my warranty claim.',
];

const history = [];
let known = {};

try {
  for (const text of caller) {
    console.log(`\nCaller: ${text}`);
    const result = await analyzeTurn({ text, history, known });

    console.log(`Agent:  ${result.reply}`);
    console.log(
      `        intent=${result.intent} (${result.confidence})  next=${result.nextAction}  score=${result.qualificationScore}`
    );
    console.log(`        entities=${JSON.stringify(result.entities)}`);
    if (result.escalationReason) console.log(`        escalation=${result.escalationReason}`);
    console.log(
      `        ${result.llm.model}  ${result.llm.inputTokens} in / ${result.llm.outputTokens} out  ${result.llm.latencyMs}ms`
    );

    history.push({ role: 'caller', content: text }, { role: 'agent', content: result.reply });
    known = { ...known, ...result.entities };
  }
} catch (err) {
  console.error(`\nAgent call failed: ${err.message}`);
  if (err.code) console.error(`(code: ${err.code})`);
  process.exit(1);
}
