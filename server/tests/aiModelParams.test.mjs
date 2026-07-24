/**
 * Unit tests for the AI temperature-capability gate (FIX A).
 *
 * Claude-5 models reject `temperature` with a 400; haiku-4-5 and older accept
 * it. No API, no DB. Pure function in, boolean out.
 *
 * Run: node server/tests/aiModelParams.test.mjs
 */
import { anthropicAcceptsTemperature, anthropicAcceptsThinking, anthropicAcceptsEffort } from '../lib/aiModelParams.js';

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

// BACKLOG #53 — explicit thinking control: 4.6+/5-gen Sonnet/Opus accept it;
// Fable/Mythos 5 400 on explicit "disabled" (always-on thinking) → omit.
assert(anthropicAcceptsThinking('claude-sonnet-5') === true, 'sonnet-5 → send thinking');
assert(anthropicAcceptsThinking('claude-sonnet-4-6') === true, 'sonnet-4-6 → send thinking');
assert(anthropicAcceptsThinking('claude-opus-4-8') === true, 'opus-4-8 → send thinking');
assert(anthropicAcceptsThinking('claude-fable-5') === false, 'fable-5 → omit thinking (400 on disabled)');
assert(anthropicAcceptsThinking('claude-mythos-5') === false, 'mythos-5 → omit thinking (400 on disabled)');
assert(anthropicAcceptsThinking('claude-haiku-4-5-20251001') === false, 'haiku-4-5 → omit thinking (fail-safe)');
assert(anthropicAcceptsThinking('gpt-4o') === false, 'gpt-4o → omit thinking');
assert(anthropicAcceptsThinking(undefined) === false, 'undefined → omit thinking (fail-safe)');

// BACKLOG #53 — output_config.effort: Opus 4.5+, Sonnet 4.6+, Fable/Mythos 5
// accept it; Haiku 4.5 rejects it → omit.
assert(anthropicAcceptsEffort('claude-sonnet-5') === true, 'sonnet-5 → send effort');
assert(anthropicAcceptsEffort('claude-opus-4-8') === true, 'opus-4-8 → send effort');
assert(anthropicAcceptsEffort('claude-fable-5') === true, 'fable-5 → send effort');
assert(anthropicAcceptsEffort('claude-haiku-4-5-20251001') === false, 'haiku-4-5 → omit effort (rejects it)');
assert(anthropicAcceptsEffort('gpt-4o') === false, 'gpt-4o → omit effort');
assert(anthropicAcceptsEffort(undefined) === false, 'undefined → omit effort (fail-safe)');

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
