/**
 * Phase 3 Integration Test — Cards, Routing Rules, Escalation Gates
 *
 * Tests resolveCards(), validateCards(), card-aware options merge,
 * evaluateEscalationGate(), and flag_manual upgrade with deterministic mock data.
 *
 * Run: node server/tests/phase3-routing.test.mjs
 */

// ── Inline the functions we need to test ─────────────────────────
// (These match the implementations in routingHandler.js and autoExecutor.js)

const MAX_LOOPS = 3;

function resolveCards(qaScores, executionPlan, existingLoopConfig) {
  const rules = executionPlan?.routing_rules || {};
  const cards = executionPlan?.cards || {};
  const consumed = existingLoopConfig?.consumed_cards || [];
  const activeCards = {};
  const triggeredBy = [];
  const newlyActivated = [];

  for (const [check, result] of Object.entries(qaScores || {})) {
    if (result !== 'fail') continue;
    const rule = rules[`${check}:fail`];
    if (!rule) continue;
    triggeredBy.push(`${check}:fail`);
    for (const cardName of rule.target_cards) {
      if (consumed.includes(cardName)) continue;
      const card = cards[cardName];
      if (!card) continue;
      const step = String(card.step);
      if (!activeCards[step]) activeCards[step] = [];
      if (!activeCards[step].includes(cardName)) {
        activeCards[step].push(cardName);
        newlyActivated.push(cardName);
      }
    }
  }

  if (!Object.keys(activeCards).length) return null;
  return {
    active_cards: activeCards,
    consumed_cards: [...consumed, ...newlyActivated],
    triggered_by: triggeredBy,
  };
}

function validateCards(executionPlan, registeredSubmodules) {
  const warnings = [];
  const cards = executionPlan?.cards || {};
  const rules = executionPlan?.routing_rules || {};

  for (const [name, card] of Object.entries(cards)) {
    if (!card.submodule_id) warnings.push(`Card "${name}": missing submodule_id`);
    else if (registeredSubmodules && !registeredSubmodules.includes(card.submodule_id))
      warnings.push(`Card "${name}": submodule "${card.submodule_id}" not found`);
    if (card.step === undefined) warnings.push(`Card "${name}": missing step`);
  }

  for (const [ruleKey, rule] of Object.entries(rules)) {
    for (const cardName of rule.target_cards || []) {
      if (!cards[cardName]) warnings.push(`Rule "${ruleKey}": targets unknown card "${cardName}"`);
    }
  }

  const allRuleCards = new Set();
  for (const rule of Object.values(rules)) {
    for (const cardName of rule.target_cards || []) allRuleCards.add(cardName);
  }
  const slotMap = {};
  for (const cardName of allRuleCards) {
    const card = cards[cardName];
    if (!card) continue;
    const slot = `${card.step}:${card.submodule_id}`;
    if (!slotMap[slot]) slotMap[slot] = [];
    slotMap[slot].push(cardName);
  }
  for (const [slot, names] of Object.entries(slotMap)) {
    if (names.length > 1) {
      warnings.push(
        `Cards [${names.join(', ')}] target the same submodule at the same step (${slot}).`
      );
    }
  }

  return warnings;
}

// Card-aware options merge (from submoduleRuns.js)
function mergeEntityOptions(baseOptions, loopConfig, templateCards, stepIdx, submoduleId) {
  let entityOptions = baseOptions;
  if (loopConfig) {
    const lc = loopConfig;
    if (lc.active_cards) {
      const stepCards = lc.active_cards[String(stepIdx)] || [];
      for (const cardName of stepCards) {
        const card = templateCards[cardName];
        if (card && card.submodule_id === submoduleId) {
          entityOptions = { ...baseOptions, ...card.options_overrides };
          break;
        }
      }
    } else {
      entityOptions = { ...baseOptions, ...lc };
    }
  }
  return entityOptions;
}

// ── Test execution plan (matches Phase 7 SQL) ────────────────────

const EXECUTION_PLAN = {
  cards: {
    'pse-v2': {
      submodule_id: 'browser-crawler',
      step: 1,
      options_overrides: { max_pages: 30, depth: 3, follow_external: true },
      description: 'Broader discovery',
    },
    'scraper-deluxe-v2': {
      submodule_id: 'browser-scraper',
      step: 3,
      options_overrides: { use_unlocker: true, timeout: 30000 },
      description: 'Enhanced scraper',
    },
    'writer-v2': {
      submodule_id: 'content-writer',
      step: 5,
      options_overrides: { temperature: 0.2, require_citations: true },
      description: 'Strict citation writer',
    },
    'seo-writer-v2': {
      submodule_id: 'tone-seo-editor',
      step: 5,
      options_overrides: { temperature: 0.3, keyword_emphasis: 'aggressive' },
      description: 'Aggressive keyword writer',
    },
  },
  routing_rules: {
    'hallucination:fail': { target_cards: ['pse-v2', 'writer-v2'] },
    'citation:fail': { target_cards: ['pse-v2', 'writer-v2'] },
    'keyword:fail': { target_cards: ['seo-writer-v2'] },
    'meta:fail': { target_cards: ['seo-writer-v2'] },
    'structural:fail': { target_cards: ['writer-v2'] },
  },
};

// ── Test helpers ─────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual, null, 0);
  const b = JSON.stringify(expected, null, 0);
  if (a === b) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
    console.error(`    expected: ${b}`);
    console.error(`    actual:   ${a}`);
  }
}

// ── TEST: Entity A — All pass, no routing ────────────────────────

console.log('\n═══ Entity A: All QA pass — no routing needed ═══');
{
  const qaScores = {
    keyword: 'pass',
    meta: 'pass',
    citation: 'pass',
    hallucination: 'pass',
    structural: 'pass',
  };

  const result = resolveCards(qaScores, EXECUTION_PLAN, {});
  assert(result === null, 'resolveCards returns null when all checks pass');

  // Simulate routing decision — no card resolution means DECISION_TARGET_MAP fallback
  // For 'approve' decision, there's no target_step — entity is done
  assert(result === null, 'No card activation, no loops fire');
}

// ── TEST: Entity B — Hallucination only fails ────────────────────

console.log('\n═══ Entity B: Hallucination fails — pse-v2 + writer-v2 activate ═══');
{
  const qaScores = {
    keyword: 'pass',
    meta: 'pass',
    citation: 'pass',
    hallucination: 'fail',
    structural: 'pass',
  };

  const result = resolveCards(qaScores, EXECUTION_PLAN, {});
  assert(result !== null, 'Cards resolved for hallucination failure');
  assert(result.triggered_by.includes('hallucination:fail'), 'Triggered by hallucination:fail');
  assert(result.triggered_by.length === 1, 'Only one trigger (hallucination:fail)');

  // Check active_cards
  assertDeepEqual(result.active_cards['1'], ['pse-v2'], 'pse-v2 activates at step 1');
  assertDeepEqual(result.active_cards['5'], ['writer-v2'], 'writer-v2 activates at step 5');
  assert(!result.active_cards['3'], 'No cards at step 3 (scraper-deluxe not in hallucination rule)');

  // Check consumed_cards
  assert(result.consumed_cards.includes('pse-v2'), 'pse-v2 is consumed');
  assert(result.consumed_cards.includes('writer-v2'), 'writer-v2 is consumed');
  assert(!result.consumed_cards.includes('seo-writer-v2'), 'seo-writer-v2 NOT consumed');

  // Target step = earliest card step
  const cardSteps = Object.keys(result.active_cards).map(Number);
  const targetStep = Math.min(...cardSteps);
  assert(targetStep === 1, 'Target step is 1 (earliest card = pse-v2 at step 1)');

  // Verify loop_config structure for entity_run_meta
  assert(typeof result.active_cards === 'object', 'active_cards is an object (step → [cardNames])');
  assert(Array.isArray(result.consumed_cards), 'consumed_cards is an array');
  assert(Array.isArray(result.triggered_by), 'triggered_by is an array');

  // Test card-aware options merge — content-writer at step 5 gets writer-v2
  const baseOptions = { temperature: 0.7, max_tokens: 16384 };
  const mergedWriter = mergeEntityOptions(baseOptions, result, EXECUTION_PLAN.cards, 5, 'content-writer');
  assert(mergedWriter.temperature === 0.2, 'content-writer gets writer-v2 temperature (0.2)');
  assert(mergedWriter.require_citations === true, 'content-writer gets writer-v2 require_citations');
  assert(mergedWriter.max_tokens === 16384, 'content-writer preserves base max_tokens');

  // Test card-aware options merge — seo-planner at step 5 gets BASE options (no card targets it)
  const baseSeo = { temperature: 0.3 };
  const mergedSeo = mergeEntityOptions(baseSeo, result, EXECUTION_PLAN.cards, 5, 'seo-planner');
  assert(mergedSeo.temperature === 0.3, 'seo-planner keeps base options (no card for it)');
  assert(mergedSeo.keyword_emphasis === undefined, 'seo-planner does NOT get seo-writer-v2 options');

  // Test card-aware options merge — browser-crawler at step 1 gets pse-v2
  const baseCrawler = { max_pages: 10, depth: 1 };
  const mergedCrawler = mergeEntityOptions(baseCrawler, result, EXECUTION_PLAN.cards, 1, 'browser-crawler');
  assert(mergedCrawler.max_pages === 30, 'browser-crawler gets pse-v2 max_pages (30)');
  assert(mergedCrawler.depth === 3, 'browser-crawler gets pse-v2 depth (3)');
  assert(mergedCrawler.follow_external === true, 'browser-crawler gets pse-v2 follow_external');
}

// ── TEST: Entity C — Meta only fails ─────────────────────────────

console.log('\n═══ Entity C: Meta fails — seo-writer-v2 activates ═══');
{
  const qaScores = {
    keyword: 'pass',
    meta: 'fail',
    citation: 'pass',
    hallucination: 'pass',
    structural: 'pass',
  };

  const result = resolveCards(qaScores, EXECUTION_PLAN, {});
  assert(result !== null, 'Cards resolved for meta failure');
  assert(result.triggered_by.includes('meta:fail'), 'Triggered by meta:fail');
  assert(result.triggered_by.length === 1, 'Only one trigger');

  // Only seo-writer-v2 should activate
  assertDeepEqual(result.active_cards['5'], ['seo-writer-v2'], 'seo-writer-v2 activates at step 5');
  assert(!result.active_cards['1'], 'No cards at step 1');
  assert(!result.active_cards['3'], 'No cards at step 3');

  // Only seo-writer-v2 consumed
  assert(result.consumed_cards.length === 1, 'Only 1 card consumed');
  assert(result.consumed_cards.includes('seo-writer-v2'), 'seo-writer-v2 consumed');
  assert(!result.consumed_cards.includes('pse-v2'), 'pse-v2 NOT consumed');
  assert(!result.consumed_cards.includes('writer-v2'), 'writer-v2 NOT consumed');

  const targetStep = Math.min(...Object.keys(result.active_cards).map(Number));
  assert(targetStep === 5, 'Target step is 5');

  // tone-seo-editor gets card options
  const baseTone = { temperature: 0.5 };
  const merged = mergeEntityOptions(baseTone, result, EXECUTION_PLAN.cards, 5, 'tone-seo-editor');
  assert(merged.temperature === 0.3, 'tone-seo-editor gets seo-writer-v2 temperature');
  assert(merged.keyword_emphasis === 'aggressive', 'tone-seo-editor gets keyword_emphasis');
}

// ── TEST: Entity D — Multiple failures (hallucination + meta) ────

console.log('\n═══ Entity D: Multiple failures — flag_manual upgrade ═══');
{
  const qaScores = {
    keyword: 'pass',
    meta: 'fail',
    citation: 'pass',
    hallucination: 'fail',
    structural: 'pass',
  };

  const result = resolveCards(qaScores, EXECUTION_PLAN, {});
  assert(result !== null, 'Cards resolved for multiple failures');

  // Both triggers fire
  assert(result.triggered_by.includes('hallucination:fail'), 'hallucination:fail triggered');
  assert(result.triggered_by.includes('meta:fail'), 'meta:fail triggered');
  assert(result.triggered_by.length === 2, 'Two triggers');

  // Cards from ALL failures should activate
  assert(result.active_cards['1']?.includes('pse-v2'), 'pse-v2 at step 1 (from hallucination:fail)');
  assert(result.active_cards['5']?.includes('writer-v2'), 'writer-v2 at step 5 (from hallucination:fail)');
  assert(result.active_cards['5']?.includes('seo-writer-v2'), 'seo-writer-v2 at step 5 (from meta:fail)');

  // All 3 cards consumed
  assert(result.consumed_cards.length === 3, '3 cards consumed');

  // Target step = earliest = step 1
  const targetStep = Math.min(...Object.keys(result.active_cards).map(Number));
  assert(targetStep === 1, 'Target step is 1 (earliest card)');

  // Simulate flag_manual upgrade (loop-router Rule 2: 2+ failures → flag_manual)
  let decision = 'flag_manual'; // What loop-router produces
  if (decision === 'flag_manual' && result !== null) {
    decision = targetStep <= 1 ? 'loop_discovery' : 'loop_generation';
  }
  assert(decision === 'loop_discovery', 'flag_manual upgraded to loop_discovery (target_step=1)');
}

// ── TEST: Consumed cards — second loop pass ──────────────────────

console.log('\n═══ Second Loop: Consumed cards prevent re-activation ═══');
{
  const qaScores = {
    keyword: 'pass',
    meta: 'pass',
    citation: 'pass',
    hallucination: 'fail', // Still failing after first retry
    structural: 'pass',
  };

  // Entity already consumed pse-v2 and writer-v2 from first loop
  const existingLoopConfig = {
    consumed_cards: ['pse-v2', 'writer-v2'],
  };

  const result = resolveCards(qaScores, EXECUTION_PLAN, existingLoopConfig);
  assert(result === null, 'All matching cards consumed → returns null');

  // This means the entity stays flag_manual (needs human intervention)
  // max_loops backstop would also catch this
}

// ── TEST: validateCards — clean configuration ────────────────────

console.log('\n═══ validateCards: Clean configuration ═══');
{
  const warnings = validateCards(EXECUTION_PLAN);
  assert(warnings.length === 0, `No warnings for valid config (got ${warnings.length})`);
}

// ── TEST: validateCards — missing submodule_id ───────────────────

console.log('\n═══ validateCards: Broken configurations ═══');
{
  const brokenPlan = {
    cards: {
      'bad-card': { step: 5, options_overrides: {} },
      'orphan-target': { submodule_id: 'content-writer', step: 5, options_overrides: {} },
    },
    routing_rules: {
      'keyword:fail': { target_cards: ['bad-card', 'nonexistent-card'] },
    },
  };

  const warnings = validateCards(brokenPlan);
  assert(warnings.some(w => w.includes('missing submodule_id')), 'Detects missing submodule_id');
  assert(warnings.some(w => w.includes('unknown card "nonexistent-card"')), 'Detects unknown card reference');
}

// ── TEST: validateCards — same-submodule collision ───────────────

console.log('\n═══ validateCards: Same-submodule collision detection ═══');
{
  const collisionPlan = {
    cards: {
      'writer-v2': { submodule_id: 'content-writer', step: 5, options_overrides: { temp: 0.2 } },
      'writer-v3': { submodule_id: 'content-writer', step: 5, options_overrides: { temp: 0.1 } },
    },
    routing_rules: {
      'hallucination:fail': { target_cards: ['writer-v2'] },
      'citation:fail': { target_cards: ['writer-v3'] },
    },
  };

  const warnings = validateCards(collisionPlan);
  assert(
    warnings.some(w => w.includes('target the same submodule at the same step')),
    'Detects same-submodule collision'
  );
}

// ── TEST: Backward compatibility — old flat loop_config ──────────

console.log('\n═══ Backward compat: Old flat loop_config format ═══');
{
  const oldLoopConfig = { temperature: 0.1, max_retries: 2 };
  const baseOptions = { temperature: 0.7, max_tokens: 16384 };

  const merged = mergeEntityOptions(baseOptions, oldLoopConfig, {}, 5, 'content-writer');
  assert(merged.temperature === 0.1, 'Old format: flat merge overrides temperature');
  assert(merged.max_retries === 2, 'Old format: flat merge adds max_retries');
  assert(merged.max_tokens === 16384, 'Old format: base options preserved');
}

// ── TEST: No routing_rules → no card resolution ─────────────────

console.log('\n═══ Fallback: No routing_rules → returns null ═══');
{
  const qaScores = { hallucination: 'fail' };
  const emptyPlan = { cards: {}, routing_rules: {} };

  const result = resolveCards(qaScores, emptyPlan, {});
  assert(result === null, 'No routing_rules → resolveCards returns null');

  const result2 = resolveCards(qaScores, {}, {});
  assert(result2 === null, 'Empty execution plan → resolveCards returns null');
}

// ── TEST: max_loops backstop ─────────────────────────────────────

console.log('\n═══ max_loops backstop ═══');
{
  // Simulate entity that keeps failing after MAX_LOOPS
  const qaScores = { hallucination: 'fail' };
  const result = resolveCards(qaScores, EXECUTION_PLAN, {});
  assert(result !== null, 'Cards resolve normally');

  // But max_loops check happens AFTER card resolution in routingHandler
  const loopCount = 3;
  let decision = 'loop_discovery';
  if (decision.startsWith('loop_') && loopCount >= MAX_LOOPS) {
    decision = 'failed';
  }
  assert(decision === 'failed', 'max_loops exceeded → decision becomes failed');
}

// ── TEST: Structural failure → writer-v2 activates ──────────────

console.log('\n═══ Structural failure → writer-v2 card ═══');
{
  const qaScores = {
    keyword: 'pass',
    meta: 'pass',
    citation: 'pass',
    hallucination: 'pass',
    structural: 'fail',
  };

  const result = resolveCards(qaScores, EXECUTION_PLAN, {});
  assert(result !== null, 'Cards resolve for structural failure');
  assert(result.triggered_by.includes('structural:fail'), 'structural:fail triggered');
  assertDeepEqual(result.active_cards['5'], ['writer-v2'], 'writer-v2 activates for structural failure');
}

// ── Summary ──────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(50)}`);

process.exit(failed > 0 ? 1 : 0);
