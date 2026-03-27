/**
 * Pool blob utilities — store and hydrate large fields by reference.
 *
 * Write: extractToBlob(db, item, fieldNames) — strips large fields, stores in pool_item_blobs, sets _blob_ref
 * Read:  hydrateItems(db, items) — resolves _blob_ref on each item, merges blob content back
 *
 * Threshold is configurable via BLOB_THRESHOLD_BYTES env var (default: 10KB).
 */

import db from './db.js';

const BLOB_THRESHOLD_BYTES = parseInt(process.env.BLOB_THRESHOLD_BYTES || '10240', 10);

/**
 * Extract large fields from a pool item into pool_item_blobs.
 * Mutates the item in place: removes large fields and adds _blob_ref UUID.
 *
 * @param {object} item - Pool item (mutated in place)
 * @param {string[]} fieldNames - Fields to consider for extraction
 * @returns {string|null} blob UUID if created, null if no fields exceeded threshold
 */
export async function extractToBlob(item, fieldNames) {
  // Guard: never overwrite an existing blob ref (prevents double extraction)
  if (item._blob_ref) return null;

  const blobContent = {};
  for (const field of fieldNames) {
    if (item[field] == null) continue;
    const size = typeof item[field] === 'string'
      ? item[field].length
      : JSON.stringify(item[field]).length;
    if (size >= BLOB_THRESHOLD_BYTES) {
      blobContent[field] = item[field];
    }
  }
  if (Object.keys(blobContent).length === 0) return null;

  const { data, error } = await db
    .from('pool_item_blobs')
    .insert({ content: blobContent })
    .select('id')
    .single();

  if (error) {
    console.warn('[poolBlobs] Failed to store blob:', error.message);
    return null; // Keep fields inline as fallback
  }

  // Strip extracted fields from item, replace with ref
  for (const field of Object.keys(blobContent)) {
    delete item[field];
  }
  item._blob_ref = data.id;
  return data.id;
}

/**
 * Hydrate pool items by resolving _blob_ref UUIDs.
 * Merges blob content back into each item. Mutates items in place.
 *
 * @param {object[]} items - Array of pool items (mutated in place)
 * @returns {number} Number of items hydrated
 */
export async function hydrateItems(items) {
  const refs = items
    .filter(item => item?._blob_ref)
    .map(item => item._blob_ref);

  if (refs.length === 0) return 0;

  const uniqueRefs = [...new Set(refs)];

  const { data: blobs, error } = await db
    .from('pool_item_blobs')
    .select('id, content')
    .in('id', uniqueRefs);

  if (error || !blobs) {
    console.warn('[poolBlobs] Failed to hydrate blobs:', error?.message);
    return 0;
  }

  const blobMap = new Map(blobs.map(b => [b.id, b.content]));
  let hydrated = 0;

  for (const item of items) {
    if (!item?._blob_ref) continue;
    const content = blobMap.get(item._blob_ref);
    if (content) {
      Object.assign(item, content);
      delete item._blob_ref;
      hydrated++;
    } else {
      console.warn(`[poolBlobs] Blob not found for ref ${item._blob_ref} — item will retain _blob_ref`);
    }
  }

  return hydrated;
}
