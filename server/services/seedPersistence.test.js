import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSeedRows, persistSeedEntities, fillSeedFieldsForItems } from './seedPersistence.js';

// Hermetic — a mock db (DI convention). No env, no network.

function mockWriteDb(behavior = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        upsert: async (rows, opts) => {
          calls.push({ table, rows, opts });
          return { error: behavior.error || null };
        },
      };
    },
  };
}

// Read mock: from().select().eq().eq().maybeSingle() → { data, error }. Fresh builder per from().
function mockReadDb({ row = undefined, error = false } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const f = {};
      const b = {
        select() { return b; },
        eq(k, v) { f[k] = v; return b; },
        maybeSingle: async () => {
          calls.push({ table, ...f });
          if (error) return { data: null, error: { message: 'boom' } };
          return { data: row === undefined ? null : { entity_snapshot: row }, error: null };
        },
      };
      return b;
    },
  };
}

// ── buildSeedRows ────────────────────────────────────────────────────────────
test('buildSeedRows maps run_id/entity_name/entity_snapshot and keeps the whole seed row', () => {
  const rows = buildSeedRows('r1', [
    { name: 'ELK Studios', website: 'elk-studios.com', company_id: 'c1', cms_id: 'doc-elk' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].run_id, 'r1');
  assert.equal(rows[0].entity_name, 'ELK Studios');
  assert.equal(rows[0].entity_snapshot.company_id, 'c1');
  assert.equal(rows[0].entity_snapshot.website, 'elk-studios.com');
});

test('buildSeedRows tolerates entity_name key and drops nameless rows', () => {
  const rows = buildSeedRows('r1', [{ entity_name: 'X' }, { website: 'no-name.com' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity_name, 'X');
});

// ── persistSeedEntities (write at ingest) ─────────────────────────────────────
test('persistSeedEntities writes one row per entity, upserts on (run_id, entity_name)', async () => {
  const db = mockWriteDb();
  const n = await persistSeedEntities({ runId: 'r1', entities: [{ name: 'A', company_id: '1' }, { name: 'B' }], db });
  assert.equal(n, 2);
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].table, 'run_entities');
  assert.equal(db.calls[0].opts.onConflict, 'run_id,entity_name');
  assert.equal(db.calls[0].rows.length, 2);
});

test('persistSeedEntities is a no-op for an empty entity set (no write)', async () => {
  const db = mockWriteDb();
  const n = await persistSeedEntities({ runId: 'r1', entities: [], db });
  assert.equal(n, 0);
  assert.equal(db.calls.length, 0);
});

test('persistSeedEntities is LOUD on write error (throws, never swallows)', async () => {
  const db = mockWriteDb({ error: { message: 'permission denied' } });
  await assert.rejects(
    () => persistSeedEntities({ runId: 'r1', entities: [{ name: 'A' }], db }),
    /seed write failed.*permission denied/,
  );
});

test('persistSeedEntities is idempotent — same key upsert, safe to re-run', async () => {
  const db = mockWriteDb();
  await persistSeedEntities({ runId: 'r1', entities: [{ name: 'A' }], db });
  await persistSeedEntities({ runId: 'r1', entities: [{ name: 'A' }], db });
  // Both calls upsert on the same (run_id, entity_name) → the second is a DB no-op.
  assert.ok(db.calls.every((c) => c.opts.onConflict === 'run_id,entity_name'));
  assert.deepEqual(db.calls[0].rows[0], db.calls[1].rows[0]);
});

// ── fillSeedFieldsForItems (hydrate back) ─────────────────────────────────────
test('fillSeedFieldsForItems hydrates missing requires_columns from the seed row', async () => {
  const items = [{ entity_name: 'ELK Studios' }, { entity_name: 'ELK Studios' }];
  const db = mockReadDb({ row: { name: 'ELK Studios', company_id: 'c1', cms_id: 'doc-elk', website: 'elk-studios.com' } });
  const filled = await fillSeedFieldsForItems({ items, entityName: 'ELK Studios', runId: 'r1', wantedFields: ['company_id', 'cms_id', 'website'], db });
  assert.deepEqual([...filled].sort(), ['cms_id', 'company_id', 'website']);
  assert.equal(items[0].company_id, 'c1');
  assert.equal(items[1].cms_id, 'doc-elk');
});

test('fillSeedFieldsForItems does NOT overwrite an existing non-empty value', async () => {
  const items = [{ entity_name: 'ELK Studios', website: 'already-set.com' }];
  const db = mockReadDb({ row: { website: 'seed.com', company_id: 'c1' } });
  await fillSeedFieldsForItems({ items, entityName: 'ELK Studios', runId: 'r1', wantedFields: ['website', 'company_id'], db });
  assert.equal(items[0].website, 'already-set.com'); // preserved
  assert.equal(items[0].company_id, 'c1'); // filled
});

test('fillSeedFieldsForItems is a safe no-op when no seed row exists (warn, no throw)', async () => {
  const items = [{ entity_name: 'Nobody Ltd' }];
  const db = mockReadDb({ row: undefined });
  const filled = await fillSeedFieldsForItems({ items, entityName: 'Nobody Ltd', runId: 'r1', wantedFields: ['company_id'], db });
  assert.equal(filled.size, 0);
  assert.equal(items[0].company_id, undefined);
});

test('fillSeedFieldsForItems is LOUD on query error (throws)', async () => {
  const db = mockReadDb({ error: true });
  await assert.rejects(
    () => fillSeedFieldsForItems({ items: [{ entity_name: 'X' }], entityName: 'X', runId: 'r1', wantedFields: ['company_id'], db }),
    /seed hydrate failed/,
  );
});

test('fillSeedFieldsForItems no-ops with no db / no fields / no items (never queries)', async () => {
  const db = mockReadDb({ row: { company_id: 'c1' } });
  assert.equal((await fillSeedFieldsForItems({ items: [{}], entityName: 'X', runId: 'r1', wantedFields: [], db })).size, 0);
  assert.equal((await fillSeedFieldsForItems({ items: [], entityName: 'X', runId: 'r1', wantedFields: ['company_id'], db })).size, 0);
  assert.equal((await fillSeedFieldsForItems({ items: [{}], entityName: 'X', runId: 'r1', wantedFields: ['company_id'], db: undefined })).size, 0);
  assert.equal(db.calls.length, 0); // none of the above reached the query
});
