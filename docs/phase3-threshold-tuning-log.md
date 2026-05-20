# Phase 3 QA Threshold Tuning Log

**Date:** 2026-05-20
**Template:** "30 april" (3442873e-921d-4c97-9f0f-39395c676b35)
**Data source:** 3 Phase 2 runs, 11 entity-runs per QA module
**Target:** 30-60% first-pass fail rate per QA module

> These are calibration values for Phase 3 validation, not production-final values.
> Will need re-tuning after 50-entity validation run (Batch 8b).

## Summary of Changes

| Module | Old Threshold | New Threshold | Old Fail Rate | Expected Fail Rate |
|--------|--------------|---------------|---------------|-------------------|
| hallucination-detector | 0.9 | **0.7** | 73% | ~36% |
| citation-coverage-checker | 0.7 | 0.7 (unchanged) | 18% | ~18% |
| keyword-sufficiency-checker | 0.6 | 0.6 (unchanged) | 27% | ~27% |
| meta-compliance-checker | 1.0 | **0.7** | 100% | ~36% |

## Detailed Analysis

### hallucination-detector: 0.9 → 0.7

**Problem:** 73% fail rate. Scores cluster between 0.47 and 0.85 — the 0.9 threshold
rejects entities at 0.855 which have borderline-acceptable hallucination levels.

**Score distribution (n=11):**
- <0.5: 3 entities (0.313, 0.472, 0.492) — genuine issues
- 0.5-0.7: 1 entity (0.677) — borderline
- 0.7-0.8: 3 entities (0.714, 0.739, 0.75) — acceptable with minor issues
- 0.8-0.9: 1 entity (0.855) — good quality, shouldn't fail
- ≥0.9: 3 entities (0.902, 0.906, 1.0) — excellent

**Decision:** Set to 0.7. Only entities with genuine hallucination problems (score <0.7)
get routed to writer-v2 card. Entities in the 0.7-0.9 range are acceptable for company
profiles where some claims may lack direct source verification.

**Expected at 0.7:** 4/11 fail = 36% ✓

### citation-coverage-checker: 0.7 → 0.7 (no change)

**Score distribution (n=11):**
- 0: 1 entity (zero citations — genuinely broken)
- 0.5: 1 entity
- 0.75-1.0: 9 entities (all pass)

**Decision:** Keep at 0.7. The 18% fail rate is reasonable — only content with truly
insufficient citations fails. The `require_at_least_one_citation` option handles the
zero-citation edge case independently.

### keyword-sufficiency-checker: 0.6 → 0.6 (no change)

**Score distribution (n=11):**
- <0.5: 1 entity (0.39)
- 0.5-0.6: 2 entities (0.51, 0.53)
- 0.6-0.8: 4 entities (0.62, 0.72, 0.73, 0.78)
- ≥0.8: 4 entities (0.82, 0.88, 0.88, 1.0)

**Decision:** Keep at 0.6. The 27% fail rate sits in the target range. Entities below
0.6 have measurably poor keyword integration.

### meta-compliance-checker: 1.0 → 0.7

**Problem:** 100% fail rate. The all-or-nothing threshold (1.0 = 7/7 checks pass) is
broken because head-term matching almost always fails. SEO-planned head terms like
"igaming platform provider" or "online casino reviews and comparisons" rarely appear
verbatim in 60-character meta titles or 160-character meta descriptions.

**Common violations (11 entities, 3 runs):**
- "No head_term found in description" — 11/11 entities (universal)
- "No head_term found in title" — 4/11 entities
- "Description too short/long" — 6/11 entities
- "Title too long" — 3/11 entities
- "Truncation indicator" — 2/11 entities

**Decision:** Set to 0.7 (5/7 checks must pass = max 2 violations allowed).
- Entities with only head_term violations (2/7 fail): 5/7 = 0.714 → PASS
- Entities with head_term + 1 other violation (3/7 fail): 4/7 = 0.571 → FAIL
- This correctly separates "minor formatting issues" from "real meta problems"

**Expected at 0.7:** ~4/11 fail = 36% ✓

**Future improvement:** The head_term matching logic should support partial/fuzzy
matching. Long multi-word phrases rarely appear verbatim — checking for individual
keywords from the head term would be more practical. Deferred to Phase 4+.

## How Applied

Thresholds are set in the template's `preset_map` JSONB column as `fallback_values`:
```json
{
  "hallucination-detector": { "preset_name": "phase3-tuned", "fallback_values": { "pass_threshold": 0.7 } },
  "meta-compliance-checker": { "preset_name": "phase3-tuned", "fallback_values": { "pass_threshold": 0.7 } }
}
```

Modules with unchanged thresholds (citation-coverage-checker at 0.7, keyword-sufficiency-checker
at 0.6) use their manifest defaults — no preset_map entry needed.
