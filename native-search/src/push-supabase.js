/**
 * Push chunked documentation to Supabase (ai_agent_docs table).
 *
 * Truncates the table, then reads chunks from a JSON file and upserts.
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 * Run config/supabase-schema.sql in Supabase first (creates table and truncate_ai_agent_docs function).
 *
 * Usage:
 *   node src/push-supabase.js [chunks.json]
 */

const fs = require('fs').promises;
const path = require('path');

const DEFAULT_CHUNKS_PATH = path.join(__dirname, '..', '..', 'build', 'site', 'chunks.json');
const BATCH_SIZE = 100;

async function loadChunks(chunksPath) {
  const raw = await fs.readFile(chunksPath, 'utf-8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error('Chunks file must be a JSON array of { id, content, metadata }');
  }
  return data;
}

async function pushToSupabase(chunks, options = {}) {
  const { createClient } = require('@supabase/supabase-js');
  const url = options.url || process.env.SUPABASE_URL;
  const key = options.key || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const table = options.table || 'ai_agent_docs';

  if (!url || !key) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or pass options.url / options.key)');
  }

  const supabase = createClient(url, key);

  console.log('Truncating', table, '...');
  const { error: truncateError } = await supabase.rpc('truncate_ai_agent_docs');
  if (truncateError) {
    throw new Error('Truncate failed. Run config/supabase-schema.sql in the Supabase SQL Editor. ' + truncateError.message);
  }

  const rows = chunks.map((ch) => ({
    id: ch.id,
    content: ch.content,
    metadata: ch.metadata || {}
  }));

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from(table).upsert(batch, {
      onConflict: 'id',
      ignoreDuplicates: false
    });
    if (error) throw error;
    const done = Math.min(i + BATCH_SIZE, rows.length);
    if (done % 500 < BATCH_SIZE || done === rows.length) {
      console.log(`   Upserted ${done} / ${rows.length} chunks...`);
    }
  }
  return rows.length;
}

async function run() {
  const startTime = Date.now();
  const chunksPath = process.argv[2] || DEFAULT_CHUNKS_PATH;

  console.log('📤 Push chunks to Supabase');
  console.log('==========================\n');
  console.log('Chunks file:', chunksPath);

  const chunks = await loadChunks(chunksPath);
  console.log('Chunks to push:', chunks.length);

  if (chunks.length === 0) {
    console.log('Nothing to push.');
    return;
  }

  await pushToSupabase(chunks);
  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log('\n==========================');
  console.log('📊 Summary');
  console.log('==========================');
  console.log('   Chunks upserted:', chunks.length);
  console.log('   Duration:       ', durationSec + 's');
  console.log('\n✅ Done.\n');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
