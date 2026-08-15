#!/usr/bin/env node
'use strict';

/**
 * Migrates InsForge's search_synonyms (21 rows) into Supabase, preserving
 * all column values as-is. Static reference data - no user_id, no FK, no
 * timestamps.
 *
 * NOTE: rate_limits was explicitly excluded from this migration pass per
 * user decision - it holds live sliding-window rate-limiter counters
 * (key + window_start + count), ephemeral by design, same reasoning
 * already applied to the ticket-QR codes during the storage audit.
 *
 * Modes: --dry-run (default) prints rows, no writes. --apply requires
 * CONFIRM_APPLY=YES-MIGRATE-SEARCH-SYNONYMS. Idempotent - INSERT carries
 * ON CONFLICT (term) DO NOTHING (term is the primary key).
 */

const { Client } = require('pg');

const ROWS = [
  { term: 'afrobeat', synonym: 'afrobeats' },
  { term: 'afrobeats', synonym: 'afrobeat' },
  { term: 'bootcamp', synonym: 'workshop' },
  { term: 'clubbing', synonym: 'party' },
  { term: 'comedy', synonym: 'standup' },
  { term: 'concert', synonym: 'gig' },
  { term: 'conference', synonym: 'seminar' },
  { term: 'deejay', synonym: 'dj' },
  { term: 'dj', synonym: 'deejay' },
  { term: 'exhibition', synonym: 'expo' },
  { term: 'expo', synonym: 'exhibition' },
  { term: 'fest', synonym: 'festival' },
  { term: 'festival', synonym: 'fest' },
  { term: 'gig', synonym: 'concert' },
  { term: 'owambe', synonym: 'party' },
  { term: 'party', synonym: 'rave' },
  { term: 'rave', synonym: 'party' },
  { term: 'seminar', synonym: 'conference' },
  { term: 'show', synonym: 'concert' },
  { term: 'standup', synonym: 'comedy' },
  { term: 'workshop', synonym: 'bootcamp' },
];

const COLS = ['term', 'synonym'];

function parseArgs(argv) {
  return { apply: argv.includes('--apply') };
}

async function main() {
  const opts = parseArgs(process.argv);
  const targetUrl = process.env.TARGET_DATABASE_URL;
  if (!targetUrl) { console.error('FATAL: TARGET_DATABASE_URL not set.'); process.exit(1); }

  console.log(`Mode: ${opts.apply ? 'APPLY (writes to target)' : 'DRY RUN (no writes)'}`);
  console.log(`Loaded ${ROWS.length} search_synonyms rows (hardcoded from a read-only InsForge fetch).`);

  if (!opts.apply) {
    console.log('\n=== Rows ===');
    console.log(JSON.stringify(ROWS, null, 1));
    console.log(`\n=== Summary ===\n${ROWS.length} rows would be inserted. No writes performed.`);
    process.exit(0);
  }

  if (process.env.CONFIRM_APPLY !== 'YES-MIGRATE-SEARCH-SYNONYMS') {
    console.error('FATAL: --apply requires CONFIRM_APPLY=YES-MIGRATE-SEARCH-SYNONYMS. Refusing to write.');
    process.exit(1);
  }

  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  try {
    const before = await client.query('SELECT count(*) AS c FROM search_synonyms');
    console.log('Target before:', JSON.stringify(before.rows[0]));

    await client.query('BEGIN');

    let ins = 0, skip = 0;
    for (const row of ROWS) {
      const values = COLS.map((c) => row[c]);
      const ph = COLS.map((_, i) => `$${i + 1}`).join(', ');
      const res = await client.query(
        `INSERT INTO public.search_synonyms (${COLS.join(', ')}) VALUES (${ph}) ON CONFLICT (term) DO NOTHING`,
        values
      );
      if (res.rowCount === 1) ins++; else skip++;
    }
    console.log(`Search synonyms: ${ins} inserted, ${skip} skipped.`);

    await client.query('COMMIT');
    console.log('\nCommitted.');
  } catch (err) {
    console.error('FATAL, rolling back:', err.message);
    await client.query('ROLLBACK').catch(() => {});
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('FATAL (unhandled):', err);
  process.exit(1);
});
