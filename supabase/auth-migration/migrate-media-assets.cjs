#!/usr/bin/env node
'use strict';

/**
 * Migrates InsForge's media_assets (39 rows) into Supabase, preserving
 * exact UUIDs and all column values, except:
 *
 *   url / thumbnail_url are rewritten from InsForge object URLs to the
 *   equivalent Supabase Storage public URLs, since the underlying files
 *   were already uploaded to Supabase's "events" bucket under the exact
 *   same storage_key/thumbnail_key (see _upload_media_assets_files.cjs).
 *   storage_key / thumbnail_key themselves are copied as-is (raw object
 *   keys, no transformation needed).
 *
 * Read-only audit already confirmed: 0 user_id and 0 event_id values
 * fall outside the already-migrated 25 users / 43 events.
 *
 * Rows are read from a pre-fetched JSON snapshot (_ma_full.json) taken
 * read-only from InsForge via `insforge db query --unrestricted`, since
 * SOURCE_DATABASE_URL is not available in this shell.
 *
 * Modes: --dry-run (default) prints row counts and a sample, no writes.
 * --apply requires CONFIRM_APPLY=YES-MIGRATE-MEDIA-ASSETS. Idempotent -
 * every INSERT carries ON CONFLICT (id) DO NOTHING.
 */

const fs = require('fs');
const { Client } = require('pg');

const SUPABASE_URL = 'https://slrtjxtzhowhwhebjprv.supabase.co';
const BUCKET = 'events';

const COLS = [
  'id', 'url', 'storage_key', 'thumbnail_url', 'thumbnail_key',
  'width', 'height', 'file_size', 'mime_type', 'user_id', 'event_id',
  'uploaded_at', 'created_at',
];

function parseArgs(argv) {
  return { apply: argv.includes('--apply') };
}

function toSupabaseUrl(key) {
  if (!key) return null;
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${encodeURIComponent(key)}`;
}

async function main() {
  const opts = parseArgs(process.argv);
  const snapshotPath = process.argv[2] && !process.argv[2].startsWith('--')
    ? process.argv[2]
    : process.env.MA_SNAPSHOT_PATH;
  if (!snapshotPath) { console.error('FATAL: pass the media_assets JSON snapshot path as the first arg.'); process.exit(1); }

  const targetUrl = process.env.TARGET_DATABASE_URL;
  if (!targetUrl) { console.error('FATAL: TARGET_DATABASE_URL not set.'); process.exit(1); }

  const raw = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const sourceRows = raw.rows;
  if (!Array.isArray(sourceRows) || sourceRows.length !== 39) {
    console.error(`FATAL: expected exactly 39 media_assets rows in snapshot, found ${Array.isArray(sourceRows) ? sourceRows.length : 'invalid'} - refusing to proceed with a stale/unexpected snapshot.`);
    process.exit(1);
  }

  const rows = sourceRows.map((r) => ({
    ...r,
    url: toSupabaseUrl(r.storage_key),
    thumbnail_url: toSupabaseUrl(r.thumbnail_key),
  }));

  console.log(`Mode: ${opts.apply ? 'APPLY (writes to target)' : 'DRY RUN (no writes)'}`);
  console.log(`Loaded ${rows.length} media_assets rows from snapshot.`);

  if (!opts.apply) {
    console.log('\n=== Sample (rewritten URLs) ===');
    console.log(JSON.stringify(rows[0], null, 1));
    console.log(`\n=== Summary ===\n${rows.length} media_assets rows would be inserted. No writes performed.`);
    process.exit(0);
  }

  if (process.env.CONFIRM_APPLY !== 'YES-MIGRATE-MEDIA-ASSETS') {
    console.error('FATAL: --apply requires CONFIRM_APPLY=YES-MIGRATE-MEDIA-ASSETS. Refusing to write.');
    process.exit(1);
  }

  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  try {
    const before = await client.query('SELECT count(*) AS c FROM media_assets');
    console.log('Target before:', JSON.stringify(before.rows[0]));

    await client.query('BEGIN');

    let ins = 0, skip = 0;
    for (const row of rows) {
      const values = COLS.map((c) => row[c]);
      const ph = COLS.map((_, i) => `$${i + 1}`).join(', ');
      const res = await client.query(
        `INSERT INTO public.media_assets (${COLS.join(', ')}) VALUES (${ph}) ON CONFLICT (id) DO NOTHING`,
        values
      );
      if (res.rowCount === 1) ins++; else skip++;
    }
    console.log(`Media assets: ${ins} inserted, ${skip} skipped.`);

    await client.query('COMMIT');
    console.log('\nCommitted.');
  } catch (err) {
    console.error('FATAL, rolling back entire batch:', err.message);
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
