#!/usr/bin/env node
/**
 * Data Cleanup Script — wipes all pipeline run data from Supabase and Redis.
 * Does NOT touch code, submodules, or project definitions.
 *
 * Usage: node scripts/cleanup.js [--dry-run]
 *
 * Tables cleared (in FK-safe order):
 *   1. submodule_run_item_data
 *   2. entity_submodule_runs
 *   3. submodule_runs
 *   4. entity_stage_pool
 *   5. step_context
 *   6. run_submodule_config
 *   7. decision_log
 *   8. pipeline_stages
 *   9. pipeline_runs
 *
 * Redis: drains pipeline-stages-v2 and batch-finalization queues.
 * Projects table is preserved.
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import IORedis from 'ioredis';

// Force-load .env from the project root (override shell env vars)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env'), override: true });

const DRY_RUN = process.argv.includes('--dry-run');

console.log(`Supabase: ${process.env.SUPABASE_URL}`);
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const redis = new IORedis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
});

async function countTable(table) {
  const { count, error } = await db.from(table).select('*', { count: 'exact', head: true });
  if (error) return `error: ${JSON.stringify(error)}`;
  return count ?? 0;
}

async function clearTable(table) {
  if (DRY_RUN) {
    console.log(`  [dry-run] Would delete all rows from ${table}`);
    return;
  }
  // Supabase requires a filter for delete — use appropriate column per table
  const filterCol = table === 'submodule_run_item_data' ? 'submodule_run_id' : 'id';
  const { error } = await db.from(table).delete().gte(filterCol, '00000000-0000-0000-0000-000000000000');
  if (error) {
    console.error(`  FAILED: ${table} — ${error.message}`);
  } else {
    console.log(`  Cleared: ${table}`);
  }
}

async function drainRedisQueue(queueName) {
  // BullMQ stores jobs in Redis keys like bull:<queueName>:*
  const prefix = `bull:${queueName}`;
  const keys = await redis.keys(`${prefix}:*`);
  if (DRY_RUN) {
    console.log(`  [dry-run] Would delete ${keys.length} Redis keys for queue ${queueName}`);
    return;
  }
  if (keys.length > 0) {
    await redis.del(...keys);
    console.log(`  Cleared: ${keys.length} Redis keys for queue ${queueName}`);
  } else {
    console.log(`  Queue ${queueName}: already empty`);
  }
}

async function main() {
  console.log(DRY_RUN ? '\n=== DRY RUN — no data will be deleted ===\n' : '\n=== DATA CLEANUP ===\n');

  // 1. Count before
  console.log('Current row counts:');
  const tables = [
    'submodule_run_item_data',
    'entity_submodule_runs',
    'submodule_runs',
    'entity_stage_pool',
    'step_context',
    'run_submodule_config',
    'decision_log',
    'pipeline_stages',
    'pipeline_runs',
    'projects',
  ];
  for (const t of tables) {
    console.log(`  ${t}: ${await countTable(t)}`);
  }

  // 2. Clear tables (FK-safe order — children first)
  console.log('\nClearing pipeline data (preserving projects)...');
  const clearOrder = [
    'submodule_run_item_data',
    'entity_submodule_runs',
    'submodule_runs',
    'entity_stage_pool',
    'step_context',
    'run_submodule_config',
    'decision_log',
    'pipeline_stages',
    'pipeline_runs',
  ];
  for (const t of clearOrder) {
    await clearTable(t);
  }

  // 3. Clear Redis queues
  console.log('\nClearing Redis queues...');
  await drainRedisQueue('pipeline-stages-v2');
  await drainRedisQueue('batch-finalization');

  // 4. Count after
  if (!DRY_RUN) {
    console.log('\nPost-cleanup row counts:');
    for (const t of tables) {
      console.log(`  ${t}: ${await countTable(t)}`);
    }
  }

  console.log('\nDone.');
  process.exit(0);
}

main().catch(err => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
