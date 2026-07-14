/**
 * Unit tests for the AI temperature-capability gate (FIX A).
 *
 * Claude-5 models reject `temperature` with a 400; haiku-4-5 and older accept
 * it. No API, no DB. Pure function in, boolean out.
 *
 * Run: node server/tests/aiModelParams.test.mjs
 */
import { anthropicAcceptsTemperature } from '../lib/aiModelParams.js';

let passed = 0, failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else           { failed++; console.log(`  ❌ ${label}`); }
}

// Claude-5-generation ids reject temperature → omit it.
assert(anthropicAcceptsTemperature('claude-sonnet-5') === false, 'sonnet-5 → omit temperature');
assert(anthropicAcceptsTemperature('claude-opus-4-8') === false, 'opus-4-8 → omit temperature');
assert(anthropicAcceptsTemperature('claude-opus-4-7') === false, 'opus-4-7 → omit temperature');
assert(anthropicAcceptsTemperature('claude-fable-5') === false, 'fable-5 → omit temperature');
assert(anthropicAcceptsTemperature('claude-mythos-5') === false, 'mythos-5 → omit temperature');

// Haiku 4.5 (dated) and the 4.6-and-older line still accept temperature → send it.
assert(anthropicAcceptsTemperature('claude-haiku-4-5-20251001') === true, 'haiku-4-5 → send temperature');
assert(anthropicAcceptsTemperature('claude-opus-4-6') === true, 'opus-4-6 → send temperature');
assert(anthropicAcceptsTemperature('claude-sonnet-4-6') === true, 'sonnet-4-6 → send temperature');
assert(anthropicAcceptsTemperature('claude-opus-4-1') === true, 'opus-4-1 → send temperature');

// Non-Claude resolved ids (OpenAI/Perplexity) — predicate returns true; the
// caller only applies it on the anthropic branch anyway.
assert(anthropicAcceptsTemperature('gpt-4o') === true, 'gpt-4o → send temperature');
assert(anthropicAcceptsTemperature('sonar-pro') === true, 'sonar-pro → send temperature');
assert(anthropicAcceptsTemperature(undefined) === true, 'undefined → safe default (send)');

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
