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
 */
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
    const approvedItemMap = new Map(
      approvedItems.map(item => [String(item[itemKey] ?? ''), item])
    );
    entityPool = entityPool.filter(item => {
      const keyVal = String(item[itemKey] ?? '');
      if (!approvedKeySet.has(keyVal)) { ops.removed++; return false; }
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
    return { pool: entityPool, ops };
  }

  throw new Error(`Unknown data_operation: ${dataOperation}`);
}
