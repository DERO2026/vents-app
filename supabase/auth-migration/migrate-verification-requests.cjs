#!/usr/bin/env node
'use strict';

/**
 * Migrates InsForge's organizer_verification_requests (2 rows) into
 * Supabase, preserving exact UUIDs and all column values, except:
 *
 *   document_url is rewritten from InsForge's object URL to the Supabase
 *   Storage object path in the PRIVATE "verification-docs" bucket
 *   (storage_key preserved exactly). Unlike the public "events"/"avatars"
 *   buckets, this bucket holds sensitive ID documents and has no public
 *   read access - the stored value is the object path
 *   ("verification-docs/<key>"), meant to be resolved via a signed URL or
 *   authenticated download at read time, not a directly-fetchable public
 *   URL. This matches InsForge's own non-public handling of this bucket.
 *
 * Read-only audit already confirmed: both rows' user_id and reviewed_by
 * values exist in the 25 already-migrated public.users (not excluded test
 * accounts) - user_id=857d7606 (testerboy2@gmail.com, role=attendee),
 * reviewed_by=c9eb5eb6 (ventsappltd@gmail.com, role=admin). No FK
 * constraint exists on this column in either InsForge or the Supabase
 * schema (application-level reference only).
 *
 * Modes: --dry-run (default) prints row counts and a sample, no writes.
 * --apply requires CONFIRM_APPLY=YES-MIGRATE-VERIFICATION-REQUESTS.
 * Idempotent - INSERT carries ON CONFLICT (id) DO NOTHING.
 */

const { Client } = require('pg');

const BUCKET = 'verification-docs';

const ROWS = [
  {
    id: '17b5c1a6-3e37-4787-a913-aec0b468c1f6',
    user_id: '857d7606-f866-4895-864a-a39ea38b2aa3',
    company_name: 'VENTS',
    cac_number: 'RC1234567',
    business_address: 'FCT',
    storage_key: 'IMG_9468-1784217727029-1weowh.png',
    status: 'rejected',
    admin_note: 'Preview cannot be seen',
    reviewed_by: 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832',
    reviewed_at: '2026-07-17T08:08:38.144Z',
    created_at: '2026-07-16T16:02:07.867Z',
    owner_name: 'testerboy2',
    registration_date: '2026-07-16',
    business_email: 'testerboy2@gmail.com',
    business_phone: '+2348000000000',
  },
  {
    id: 'b70eb166-6615-483a-a61e-fbbe6bdca799',
    user_id: '857d7606-f866-4895-864a-a39ea38b2aa3',
    company_name: 'Testerboy',
    cac_number: 'RC1234567',
    business_address: 'FCT',
    storage_key: 'CFACD17D-7C70-47D7-BD27-E8658E71-1784276522007-9oh7nl.png',
    status: 'approved',
    admin_note: null,
    reviewed_by: 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832',
    reviewed_at: '2026-07-17T08:23:09.741Z',
    created_at: '2026-07-17T08:22:07.232Z',
    owner_name: 'TESTERBOY',
    registration_date: '2026-07-17',
    business_email: 'testerboy@gmail.com',
    business_phone: '+2349162337459',
  },
];

const COLS = [
  'id', 'user_id', 'company_name', 'cac_number', 'business_address',
  'document_url', 'status', 'admin_note', 'reviewed_by', 'reviewed_at',
  'created_at', 'owner_name', 'registration_date', 'business_email',
  'business_phone',
];

function parseArgs(argv) {
  return { apply: argv.includes('--apply') };
}

async function main() {
  const opts = parseArgs(process.argv);
  const targetUrl = process.env.TARGET_DATABASE_URL;
  if (!targetUrl) { console.error('FATAL: TARGET_DATABASE_URL not set.'); process.exit(1); }

  const rows = ROWS.map((r) => ({ ...r, document_url: `${BUCKET}/${r.storage_key}` }));

  console.log(`Mode: ${opts.apply ? 'APPLY (writes to target)' : 'DRY RUN (no writes)'}`);
  console.log(`Loaded ${rows.length} organizer_verification_requests rows (hardcoded from a read-only InsForge fetch).`);

  if (!opts.apply) {
    console.log('\n=== Rows (full - only 2) ===');
    console.log(JSON.stringify(rows, null, 1));
    console.log(`\n=== Summary ===\n${rows.length} rows would be inserted. No writes performed.`);
    process.exit(0);
  }

  if (process.env.CONFIRM_APPLY !== 'YES-MIGRATE-VERIFICATION-REQUESTS') {
    console.error('FATAL: --apply requires CONFIRM_APPLY=YES-MIGRATE-VERIFICATION-REQUESTS. Refusing to write.');
    process.exit(1);
  }

  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  try {
    const before = await client.query('SELECT count(*) AS c FROM organizer_verification_requests');
    console.log('Target before:', JSON.stringify(before.rows[0]));

    await client.query('BEGIN');

    let ins = 0, skip = 0;
    for (const row of rows) {
      const values = COLS.map((c) => row[c]);
      const ph = COLS.map((_, i) => `$${i + 1}`).join(', ');
      const res = await client.query(
        `INSERT INTO public.organizer_verification_requests (${COLS.join(', ')}) VALUES (${ph}) ON CONFLICT (id) DO NOTHING`,
        values
      );
      if (res.rowCount === 1) ins++; else skip++;
    }
    console.log(`Verification requests: ${ins} inserted, ${skip} skipped.`);

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
