/**
 * applyDataOperation — pure function that takes a working pool and approved
 * items, applies the data_operation semantic, and returns the new pool.
 *
 * Extracted from server/routes/submoduleRuns.js so the contract can be
 * exhaustively unit-tested without spinning up the API.
 *
 * Inputs:
 *   entityPool      — array of pool items currently associated with the entity
 *   approvedItems   — array of items approved from the submodule's output
 *   dataOperation   — 'add' | 'transform' | 'remove'
 *   itemKey         — string, the field used to identify items uniquely (e.g. 'url')
 *   approvedKeySet  — Set of String(item[itemKey]) values, prebuilt by caller
 *                     (used by 'remove' which also needs key-only matching)
 *
 * Returns:
 *   { pool: <new entityPool array>, ops: <stats for logging> }
 *
 * IDENTITY SEMANTICS (post 2026-06-06 fix):
 *   - `add` writes one row per composite `(itemKey, source_submodule)`. Multi-source
 *     provenance is preserved at Step 1 by design (same URL discovered by 3
 *     discovery submodules = 3 pool rows).
 *   - `remove` and `transform` COLLAPSE multi-source duplicates: after either
 *     operation, the pool has AT MOST ONE row per itemKey. First occurrence wins
 *     (matches url-dedup's documented "first occurrence wins" semantic).
 *     Subsequent rows sharing the same itemKey are dropped from the pool.
 *   - This is intentional: Step 2+ filters approve URLs (not URL-source pairs),
 *     so the pool surfaces one row per surviving URL. Downstream consumers
 *     (Step 3 scrapers) iterate per-pool-item and would otherwise scrape the
 *     same URL N times for N discovery sources, wasting bandwidth + LLM tokens.
 *
 * BUG HISTORY:
 *   - Before 2026-06-06: `remove` and `transform` only filtered by approvedKeySet
 *     membership. Multi-source duplicates from `add` survived all Step 2+ filters,
 *     leaving 20-30% redundant pool rows that propagated to Step 3 scraping.
 *     Filed as B054. Fix: add a `seen` Set tracking which itemKey values have
 *     already been kept; drop subsequent items with the same key.
 */
/**
 * Whether a submodule's per-entity output represents a module-level execution
 * failure. Modules that catch an internal error (e.g. content-writer on an
 * Anthropic 400) emit a contentless placeholder item and set
 * `output_data.meta.status = 'error'`. Under `add` (keyed by entity+source)
 * that placeholder would EVICT the prior round's good content and yield an
 * empty bundle — so the approval merge must preserve-on-failure and skip the
 * supersede for such runs. `meta.status === 'error'` fires only on genuine
 * module failure; QA-fail verdicts and normal outputs leave it unset.
 */
export function isFailedRun(outputData) {
  return outputData?.meta?.status === 'error';
}

export function applyDataOperation(entityPool, approvedItems, dataOperation, itemKey, approvedKeySet) {
  const ops = { added: 0, kept: 0, removed: 0, replaced: 0 };

  if (dataOperation === 'add') {
    // Upsert by composite (itemKey, source_submodule). Replace this submodule's
    // prior output if re-approved; preserve other submodules' items.
    const compositeKey = (item) => `${String(item[itemKey] ?? '')}::${item.source_submodule || ''}`;
    const approvedKeys = new Set(approvedItems.map(compositeKey));
    const before = entityPool.length;
    entityPool = entityPool.filter(item => !approvedKeys.has(compositeKey(item)));
    ops.replaced = before - entityPool.length;
    entityPool.push(...approvedItems);
    ops.added = approvedItems.length;
    return { pool: entityPool, ops };
  }

  if (dataOperation === 'remove') {
    // Filter to keep only approved items, AND merge any enriched fields from
    // the submodule output into the surviving items.
    //
    // Multi-source dedup (B054 fix, 2026-06-06): the pool may contain N rows
    // for the same itemKey (one per source_submodule from Step 1 `add`).
    // Approval is per-itemKey, not per-(itemKey, source_submodule). So after
    // `remove`, keep AT MOST ONE row per itemKey. First occurrence wins.
    const approvedItemMap = new Map(
      approvedItems.map(item => [String(item[itemKey] ?? ''), item])
    );
    const seen = new Set();
    entityPool = entityPool.filter(item => {
      const keyVal = String(item[itemKey] ?? '');
      if (!approvedKeySet.has(keyVal)) { ops.removed++; return false; }
      if (seen.has(keyVal)) { ops.removed++; return false; }
      seen.add(keyVal);
      const enriched = approvedItemMap.get(keyVal);
      if (enriched) {
        for (const [k, v] of Object.entries(enriched)) {
          if (k !== itemKey && k !== 'source_submodule' && !(k in item)) {
            item[k] = v;
          }
        }
      }
      ops.kept++;
      return true;
    });
    return { pool: entityPool, ops };
  }

  if (dataOperation === 'transform') {
    // Per 390e768: only push items whose key is already in the pool.
    // Items removed by an earlier 'remove' in the same step stay removed.
    // For empty pool: nothing happens — but pool_precondition: requires_items
    // should have prevented the module from running in the first place.
    const existingKeys = new Set(entityPool.map(item => String(item[itemKey] ?? '')));
    const removalSet = new Set();
    const toAdd = [];
    for (const item of approvedItems) {
      const key = String(item[itemKey] ?? '');
      const origKey = item.original_url != null && String(item.original_url) !== key
        ? String(item.original_url) : null;
      if (existingKeys.has(key) || (origKey && existingKeys.has(origKey))) {
        removalSet.add(key);
        if (origKey) { removalSet.add(origKey); }
        toAdd.push(item);
      }
    }
    const before = entityPool.length;
    entityPool = entityPool.filter(item => !removalSet.has(String(item[itemKey] ?? '')));
    ops.replaced = before - entityPool.length;
    entityPool.push(...toAdd);
    ops.added = toAdd.length;

    // Multi-source dedup (B054 fix, 2026-06-06): items that pass through
    // untouched (no transform applied to them) may still have N rows per
    // itemKey from Step 1 `add`. Collapse to first-occurrence-wins so the
    // pool surfaces one row per itemKey after `transform`, same contract
    // as `remove`. This affects e.g. url-canonicalizer's "unchanged" items
    // that aren't in removalSet/toAdd but still have multi-source copies.
    const seen = new Set();
    const dedupedPool = [];
    for (const item of entityPool) {
      const keyVal = String(item[itemKey] ?? '');
      if (seen.has(keyVal)) { ops.replaced++; continue; }
      seen.add(keyVal);
      dedupedPool.push(item);
    }
    entityPool = dedupedPool;

    return { pool: entityPool, ops };
  }

  throw new Error(`Unknown data_operation: ${dataOperation}`);
}
