import { createClient } from '@supabase/supabase-js';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_KEY environment variables');
}

// Safety guard: in production, verify we're pointing at the production database.
// Prevents accidentally running production code against a dev/staging database.
const PROD_DB_ID = 'fevxvwqjhndetktujeuu';
if (process.env.NODE_ENV === 'production' && !process.env.SUPABASE_URL.includes(PROD_DB_ID)) {
  throw new Error(`CRITICAL: Production env pointing to non-production database! Expected ${PROD_DB_ID} in SUPABASE_URL`);
}

// Safety guard: when running locally without NODE_ENV=production, warn if pointing at prod DB
if (process.env.NODE_ENV !== 'production' && process.env.SUPABASE_URL.includes(PROD_DB_ID)) {
  console.warn('\n⚠️  WARNING: Local dev is using the PRODUCTION database!');
  console.warn('   Set NODE_ENV=production or use .env.development with a staging DB.\n');
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export default supabase;
