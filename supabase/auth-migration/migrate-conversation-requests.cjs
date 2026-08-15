#!/usr/bin/env node
'use strict';

/**
 * Migrates InsForge's conversation_requests (11 rows) into Supabase,
 * preserving exact UUIDs and all column values as-is.
 *
 * conversation_clears has 0 rows on InsForge - nothing to migrate there,
 * not included in this script.
 *
 * Prerequisite (already applied separately, see
 * supabase/migrations/0014_conversation_requests_fkeys.sql): Supabase's
 * conversation_requests table was missing the requester_id/recipient_id
 * foreign keys that InsForge has (REFERENCES auth.users(id) ON DELETE
 * CASCADE) - discovered during this migration's read-only audit, fixed
 * before this data load so the FK is enforced going forward.
 *
 * Read-only audit already confirmed: all 8 distinct user ids referenced
 * across the 11 rows (requester_id + recipient_id) exist in the 25
 * already-migrated public.users. conversation_requests_unique_pair
 * (requester_id, recipient_id) has no duplicates in the source data.
 *
 * Modes: --dry-run (default) prints rows, no writes. --apply requires
 * CONFIRM_APPLY=YES-MIGRATE-CONVERSATION-REQUESTS. Idempotent - INSERT
 * carries ON CONFLICT (id) DO NOTHING.
 */

const { Client } = require('pg');

const ROWS = [
  { id: '845ab18e-e13c-4b96-baf6-3344065a7270', requester_id: 'dfca505f-b2f6-449f-aa86-f7e7ece7d1dc', recipient_id: 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832', status: 'accepted', created_at: '2026-08-03T00:43:40.363Z', responded_at: '2026-08-03T00:47:16.119Z' },
  { id: 'b6b93b7b-c61e-4433-b5d7-160da079d349', requester_id: '91b0afb4-b5dc-4289-ae00-8e6e58c60f5f', recipient_id: 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832', status: 'accepted', created_at: '2026-08-03T00:45:46.022Z', responded_at: '2026-08-03T00:45:46.022Z' },
  { id: '90774912-adf0-4d38-a1a6-467d7d3cb043', requester_id: 'a4402494-d7a0-4537-a83c-362fe71ec44f', recipient_id: 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832', status: 'accepted', created_at: '2026-08-03T00:45:46.022Z', responded_at: '2026-08-03T00:45:46.022Z' },
  { id: '2abffe6e-150d-44fb-8793-381a93bec076', requester_id: 'fc45414e-6aef-494f-bbb4-b373dac5196b', recipient_id: 'a4402494-d7a0-4537-a83c-362fe71ec44f', status: 'accepted', created_at: '2026-08-03T00:45:46.022Z', responded_at: '2026-08-03T00:45:46.022Z' },
  { id: '14ca37be-1dc6-4824-aaf7-6935ecba1785', requester_id: 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832', recipient_id: 'aca99f3b-5d10-48c9-9efa-6eba901179dd', status: 'accepted', created_at: '2026-08-03T00:45:46.022Z', responded_at: '2026-08-03T00:45:46.022Z' },
  { id: '0c799565-fe37-44c1-bdce-b85d44623ed6', requester_id: 'fc45414e-6aef-494f-bbb4-b373dac5196b', recipient_id: 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832', status: 'accepted', created_at: '2026-08-03T00:45:46.022Z', responded_at: '2026-08-03T00:45:46.022Z' },
  { id: '95c8d79e-d761-4fb3-97c4-6c3232948228', requester_id: '5f98cdd7-c01e-4e58-8ce7-a52252152dd4', recipient_id: 'fc45414e-6aef-494f-bbb4-b373dac5196b', status: 'accepted', created_at: '2026-08-03T00:45:46.022Z', responded_at: '2026-08-03T00:45:46.022Z' },
  { id: 'c00f631f-a2e9-446b-9858-da2740b6769f', requester_id: 'dfca505f-b2f6-449f-aa86-f7e7ece7d1dc', recipient_id: 'fc45414e-6aef-494f-bbb4-b373dac5196b', status: 'accepted', created_at: '2026-08-03T02:04:14.417Z', responded_at: '2026-08-03T02:04:54.178Z' },
  { id: '1eb61a0b-09cf-4ed1-b620-4271ad54fb6b', requester_id: '5f98cdd7-c01e-4e58-8ce7-a52252152dd4', recipient_id: 'dfca505f-b2f6-449f-aa86-f7e7ece7d1dc', status: 'accepted', created_at: '2026-08-03T18:12:20.987Z', responded_at: '2026-08-03T18:12:41.851Z' },
  { id: '6739d867-7759-4aa6-b126-e06c5e1d9384', requester_id: 'dfca505f-b2f6-449f-aa86-f7e7ece7d1dc', recipient_id: 'a4402494-d7a0-4537-a83c-362fe71ec44f', status: 'accepted', created_at: '2026-08-06T15:39:53.135Z', responded_at: '2026-08-06T15:40:51.293Z' },
  { id: '1ac3eccd-d45c-4448-876c-457010a6fb09', requester_id: 'dfca505f-b2f6-449f-aa86-f7e7ece7d1dc', recipient_id: '00a75bc6-097a-40a6-96d5-966fdc54dc1f', status: 'accepted', created_at: '2026-08-13T11:24:56.144Z', responded_at: '2026-08-13T11:26:11.749Z' },
];

const COLS = ['id', 'requester_id', 'recipient_id', 'status', 'created_at', 'responded_at'];

function parseArgs(argv) {
  return { apply: argv.includes('--apply') };
}

async function main() {
  const opts = parseArgs(process.argv);
  const targetUrl = process.env.TARGET_DATABASE_URL;
  if (!targetUrl) { console.error('FATAL: TARGET_DATABASE_URL not set.'); process.exit(1); }

  console.log(`Mode: ${opts.apply ? 'APPLY (writes to target)' : 'DRY RUN (no writes)'}`);
  console.log(`Loaded ${ROWS.length} conversation_requests rows (hardcoded from a read-only InsForge fetch).`);

  if (!opts.apply) {
    console.log('\n=== Rows ===');
    console.log(JSON.stringify(ROWS, null, 1));
    console.log(`\n=== Summary ===\n${ROWS.length} rows would be inserted. No writes performed.`);
    process.exit(0);
  }

  if (process.env.CONFIRM_APPLY !== 'YES-MIGRATE-CONVERSATION-REQUESTS') {
    console.error('FATAL: --apply requires CONFIRM_APPLY=YES-MIGRATE-CONVERSATION-REQUESTS. Refusing to write.');
    process.exit(1);
  }

  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  try {
    const before = await client.query('SELECT count(*) AS c FROM conversation_requests');
    console.log('Target before:', JSON.stringify(before.rows[0]));

    await client.query('BEGIN');

    let ins = 0, skip = 0;
    for (const row of ROWS) {
      const values = COLS.map((c) => row[c]);
      const ph = COLS.map((_, i) => `$${i + 1}`).join(', ');
      const res = await client.query(
        `INSERT INTO public.conversation_requests (${COLS.join(', ')}) VALUES (${ph}) ON CONFLICT (id) DO NOTHING`,
        values
      );
      if (res.rowCount === 1) ins++; else skip++;
    }
    console.log(`Conversation requests: ${ins} inserted, ${skip} skipped.`);

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
