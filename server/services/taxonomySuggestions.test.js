import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTagSuggestions, writeTaxonomySuggestions } from './taxonomySuggestions.js';

// Fixtures are the REAL content-analyzer output shape, taken verbatim from prod run
// 94baa6f6 (Pocket Rockets Gaming) via MCP on 2026-09-12 — so these assert the actual
// analysis_json.tags.suggested_new[].{label, why, evidence[]} contract at $0.
const PRG_RESULT = {
  items: [
    {
      entity_name: 'Pocket Rockets Gaming',
      analysis_json: {
        tags: {
          existing: [{ slug: 'game-developers' }],
          suggested_new: [
            {
              label: 'remote game server',
              why: "Core product category 'Remote Game Server (RGS)' is a specific technical term not captured by any existing tag.",
              evidence: ['https://pocketrocketsgaming.com/', 'https://pocketrocketsgaming.com/searching-for-an-rgs/'],
            },
            {
              label: 'multiplayer games',
              why: "Product is explicitly branded 'Multiplayer-first Remote Game Server'.",
              evidence: ['https://pocketrocketsgaming.com/'],
            },
            {
              label: 'build vs buy advisory',
              why: 'A named specialty service is helping clients decide whether to build, buy, or license an RGS platform.',
              evidence: ['https://pocketrocketsgaming.com/searching-for-an-rgs/'],
            },
          ],
        },
      },
    },
  ],
};

// Mock db: only .from(table).upsert(rows, opts) is used. Records every call and can
// be told to return an error (the loud-fail path).
function mockDb({ upsertError = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        upsert: async (rows, opts) => {
          calls.push({ table, rows, opts });
          return { error: upsertError };
        },
      };
    },
  };
}

// ── extractTagSuggestions (pure) ──────────────────────────────────────────────
test('extract pulls {label, why, evidence} from analysis_json.tags.suggested_new', () => {
  const out = extractTagSuggestions(PRG_RESULT);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], {
    label: 'remote game server',
    why: "Core product category 'Remote Game Server (RGS)' is a specific technical term not captured by any existing tag.",
    evidence: ['https://pocketrocketsgaming.com/', 'https://pocketrocketsgaming.com/searching-for-an-rgs/'],
  });
  assert.equal(out[2].label, 'build vs buy advisory'); // labels stored VERBATIM (spaced, not slugified)
});

test('extract returns [] when nothing carries the proposal path', () => {
  assert.deepEqual(extractTagSuggestions({ items: [{ entity_name: 'X', analysis_json: { tags: { existing: [] } } }] }), []);
  assert.deepEqual(extractTagSuggestions({ items: [{ url: 'a' }] }), []); // non-analyzer output
  assert.deepEqual(extractTagSuggestions({ items: [] }), []);
  assert.deepEqual(extractTagSuggestions({}), []); // no items
  assert.deepEqual(extractTagSuggestions(undefined), []); // defensive
});

test('extract skips proposals with no usable label and trims whitespace', () => {
  const out = extractTagSuggestions({
    items: [{ analysis_json: { tags: { suggested_new: [
      { label: '  spaced-out  ', why: 'w', evidence: ['u'] },
      { why: 'no label', evidence: [] },   // dropped: label is NOT NULL
      { label: '', evidence: [] },          // dropped: empty
    ] } } }],
  });
  assert.deepEqual(out, [{ label: 'spaced-out', why: 'w', evidence: ['u'] }]);
});

test('extract normalizes missing/invalid why + evidence to null', () => {
  const out = extractTagSuggestions({ items: [{ analysis_json: { tags: { suggested_new: [
    { label: 'a' },                              // no why, no evidence
    { label: 'b', why: 42, evidence: 'notarray' }, // wrong types
  ] } } }] });
  assert.deepEqual(out, [
    { label: 'a', why: null, evidence: null },
    { label: 'b', why: null, evidence: null },
  ]);
});

// ── writeTaxonomySuggestions (db) ─────────────────────────────────────────────
test('write maps each proposal to a review-queue row and returns the count', async () => {
  const db = mockDb();
  const suggestions = extractTagSuggestions(PRG_RESULT);
  const n = await writeTaxonomySuggestions({ db, runId: 'run-1', entityName: 'Pocket Rockets Gaming', suggestions });
  assert.equal(n, 3);
  assert.equal(db.calls.length, 1);
  const { table, rows, opts } = db.calls[0];
  assert.equal(table, 'taxonomy_suggestions');
  assert.equal(opts.onConflict, 'run_id,entity_name,suggestion_type,label');
  assert.deepEqual(rows[0], {
    run_id: 'run-1',
    entity_name: 'Pocket Rockets Gaming',
    suggestion_type: 'tag',
    label: 'remote game server',
    why_suggested: "Core product category 'Remote Game Server (RGS)' is a specific technical term not captured by any existing tag.",
    evidence_refs: ['https://pocketrocketsgaming.com/', 'https://pocketrocketsgaming.com/searching-for-an-rgs/'],
  });
  // company_id / cms_id / status / timestamps deliberately omitted → defaults / null,
  // so an on-conflict upsert never resets a human's review state.
  assert.ok(!('company_id' in rows[0]));
  assert.ok(!('status' in rows[0]));
});

test('write dedups repeated labels within one entity (guards ON CONFLICT double-affect)', async () => {
  const db = mockDb();
  const n = await writeTaxonomySuggestions({
    db, runId: 'r', entityName: 'E',
    suggestions: [
      { label: 'dup', why: 'first', evidence: null },
      { label: 'dup', why: 'second', evidence: ['u'] }, // last wins
      { label: 'other', why: null, evidence: null },
    ],
  });
  assert.equal(n, 2);
  const labels = db.calls[0].rows.map(r => r.label);
  assert.deepEqual(labels, ['dup', 'other']);
  assert.equal(db.calls[0].rows.find(r => r.label === 'dup').why_suggested, 'second');
});

test('write throws LOUD on a db error (so the job retries → clean re-run)', async () => {
  const db = mockDb({ upsertError: { message: 'boom' } });
  await assert.rejects(
    () => writeTaxonomySuggestions({ db, runId: 'r', entityName: 'E', suggestions: [{ label: 'x', why: null, evidence: null }] }),
    /taxonomy_suggestions upsert failed for "E": boom/,
  );
});

test('write is a no-op with no suggestions or no db (test/inert paths)', async () => {
  const db = mockDb();
  assert.equal(await writeTaxonomySuggestions({ db, runId: 'r', entityName: 'E', suggestions: [] }), 0);
  assert.equal(db.calls.length, 0);
  assert.equal(await writeTaxonomySuggestions({ db: null, runId: 'r', entityName: 'E', suggestions: [{ label: 'x' }] }), 0);
});
