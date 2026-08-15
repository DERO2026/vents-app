#!/usr/bin/env node
'use strict';

/**
 * Migrates InsForge's highlights (1 row) into Supabase, preserving the
 * exact UUID and all column values, except:
 *
 *   media_url is rewritten from InsForge's object URL to the equivalent
 *   Supabase Storage public URL - the file was already uploaded to
 *   Supabase's public "highlights" bucket under the exact same object key
 *   (see the read-only download + upload steps immediately before this
 *   script).
 *
 * Read-only audit already confirmed: user_id (31bda20f, raphaeldidel@
 * gmail.com, role=attendee) exists in the 25 already-migrated
 * public.users. No FK constraint exists on this column in either
 * InsForge or the Supabase schema (application-level reference only).
 * group_id has no FK either (self-contained grouping key) and is copied
 * as-is.
 *
 * Modes: --dry-run (default) prints the row, no writes. --apply requires
 * CONFIRM_APPLY=YES-MIGRATE-HIGHLIGHTS. Idempotent - INSERT carries
 * ON CONFLICT (id) DO NOTHING.
 */

const { Client } = require('pg');

const SUPABASE_URL = 'https://slrtjxtzhowhwhebjprv.supabase.co';
const BUCKET = 'highlights';
const STORAGE_KEY = '698ea160-7913-4d47-907f-ec39ed26-1782052375422-n9nbwu.jpeg';

const ROW = {
  id: '90ad9c3e-0173-41dc-ad06-b75d35a129dd',
  user_id: '31bda20f-5973-4306-be2e-58f3203896c1',
  media_url: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${encodeURIComponent(STORAGE_KEY)}`,
  media_type: 'image',
  caption: null,
  created_at: '2026-06-21T14:32:57.115Z',
  group_id: '031704fa-8516-4882-b039-f214cf4ed82d',
  sort_order: 0,
};

const COLS = ['id', 'user_id', 'media_url', 'media_type', 'caption', 'created_at', 'group_id', 'sort_order'];

function parseArgs(argv) {
  return { apply: argv.includes('--apply') };
}

async function main() {
  const opts = parseArgs(process.argv);
  const targetUrl = process.env.TARGET_DATABASE_URL;
  if (!targetUrl) { console.error('FATAL: TARGET_DATABASE_URL not set.'); process.exit(1); }

  console.log(`Mode: ${opts.apply ? 'APPLY (writes to target)' : 'DRY RUN (no writes)'}`);
  console.log('Row (hardcoded from a read-only InsForge fetch):');
  console.log(JSON.stringify(ROW, null, 1));

  if (!opts.apply) {
    console.log('\n=== Summary ===\n1 highlight row would be inserted. No writes performed.');
    process.exit(0);
  }

  if (process.env.CONFIRM_APPLY !== 'YES-MIGRATE-HIGHLIGHTS') {
    console.error('FATAL: --apply requires CONFIRM_APPLY=YES-MIGRATE-HIGHLIGHTS. Refusing to write.');
    process.exit(1);
  }

  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  try {
    const before = await client.query('SELECT count(*) AS c FROM highlights');
    console.log('Target before:', JSON.stringify(before.rows[0]));

    await client.query('BEGIN');
    const values = COLS.map((c) => ROW[c]);
    const ph = COLS.map((_, i) => `$${i + 1}`).join(', ');
    const res = await client.query(
      `INSERT INTO public.highlights (${COLS.join(', ')}) VALUES (${ph}) ON CONFLICT (id) DO NOTHING`,
      values
    );
    console.log(`Highlights: ${res.rowCount === 1 ? 1 : 0} inserted, ${res.rowCount === 1 ? 0 : 1} skipped.`);
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
