#!/usr/bin/env node
'use strict';

/**
 * Migrates InsForge's device_push_tokens (4 rows) into Supabase,
 * preserving exact UUIDs and all column values as-is.
 *
 * Read-only audit already confirmed: all 4 user_id values exist in the 25
 * already-migrated public.users (fedrickemmanuel329@gmail.com,
 * helenuwemedemidiong@gmail.com, sonofgrace2622@gmail.com - the latter
 * appears twice, one row per device). All 4 tokens are distinct (no
 * unique-constraint conflict). device_push_tokens.user_id has a real FK
 * (ON DELETE CASCADE to users) in both InsForge and the Supabase schema.
 *
 * Modes: --dry-run (default) prints rows (tokens redacted), no writes.
 * --apply requires CONFIRM_APPLY=YES-MIGRATE-DEVICE-PUSH-TOKENS.
 * Idempotent - INSERT carries ON CONFLICT (id) DO NOTHING.
 */

const { Client } = require('pg');

const ROWS = [
  { id: '29729cc4-50f9-41d2-a1ae-dd5bf28120f1', user_id: '00a75bc6-097a-40a6-96d5-966fdc54dc1f', token: 'fedmeTkcTk2h99G3cVojJ5:APA91bGszrE_o0SoGPc-EzEscqmhIZYCbB8WuojnE4JmoA7-ktrdMoHYoVb3tLeB_x6ZZAbI-7X3GdtVRgVcKJUCNOxLCENaMIQ56tsBk_RZsV4v3vrpAW0', platform: 'android', created_at: '2026-08-13T11:14:00.746Z', last_seen: '2026-08-13T11:14:47.276Z' },
  { id: 'e35af677-921e-4052-83a7-36dfd71583e6', user_id: 'b0339ff2-eaab-499e-a36a-980f6636a806', token: 'fHO8uMdITiaTNVRNqxhYvH:APA91bFU1PPZN7KM9OdQ9lWpzNVdxcpQpNFMcpjgpqTe_HEU_87guDxcTI0CKNzUEuPu6ynO987uq5MNYZWY0xb7JKIPUEUqPddCYLN_6W7RhlJjIysv8Gs', platform: 'android', created_at: '2026-08-13T11:25:00.477Z', last_seen: '2026-08-13T11:25:00.477Z' },
  { id: 'ee6c52cf-3f1a-4666-a379-9d326872a4bb', user_id: 'f42b637f-c69f-489d-8ca0-2b056bf94511', token: 'cicQFADYTEqln55vb4Zu9z:APA91bEqbC8PWnn1tv1WI1lqsY52kFOeYo59HwWUFyVtdsPYEycmnau89x4dTpCzpU-UvnpzW1PbB6SaHn-TE1k---pRAoDJxoGPODX5R_u0CYxrMfQvyu0', platform: 'android', created_at: '2026-08-13T13:20:55.143Z', last_seen: '2026-08-13T13:20:55.145Z' },
  { id: '7213b87a-aff7-46ee-ab04-6bdf4dc52f77', user_id: 'f42b637f-c69f-489d-8ca0-2b056bf94511', token: 'fmFFYXTXQeSBcz8SEpq2uj:APA91bH9kPoZcLpDkrLNWOS9RdpddjEYC8y2WWcNJLKsNwPHGRHXwdCgSiIL6RFtxlYX-NAT5jkZQgmMFIOdsfQe3VK-cXRAPN47wMdKTIRVA4EzwZdZIUU', platform: 'android', created_at: '2026-08-14T01:37:49.275Z', last_seen: '2026-08-14T01:37:49.275Z' },
];

const COLS = ['id', 'user_id', 'token', 'platform', 'created_at', 'last_seen'];

function parseArgs(argv) {
  return { apply: argv.includes('--apply') };
}

function redact(t) {
  return t.slice(0, 6) + '...' + t.slice(-4);
}

async function main() {
  const opts = parseArgs(process.argv);
  const targetUrl = process.env.TARGET_DATABASE_URL;
  if (!targetUrl) { console.error('FATAL: TARGET_DATABASE_URL not set.'); process.exit(1); }

  console.log(`Mode: ${opts.apply ? 'APPLY (writes to target)' : 'DRY RUN (no writes)'}`);
  console.log(`Loaded ${ROWS.length} device_push_tokens rows (hardcoded from a read-only InsForge fetch).`);

  if (!opts.apply) {
    console.log('\n=== Rows (tokens redacted) ===');
    for (const r of ROWS) console.log(`  ${r.id}: user_id=${r.user_id} token=${redact(r.token)} platform=${r.platform}`);
    console.log(`\n=== Summary ===\n${ROWS.length} rows would be inserted. No writes performed.`);
    process.exit(0);
  }

  if (process.env.CONFIRM_APPLY !== 'YES-MIGRATE-DEVICE-PUSH-TOKENS') {
    console.error('FATAL: --apply requires CONFIRM_APPLY=YES-MIGRATE-DEVICE-PUSH-TOKENS. Refusing to write.');
    process.exit(1);
  }

  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  try {
    const before = await client.query('SELECT count(*) AS c FROM device_push_tokens');
    console.log('Target before:', JSON.stringify(before.rows[0]));

    await client.query('BEGIN');

    let ins = 0, skip = 0;
    for (const row of ROWS) {
      const values = COLS.map((c) => row[c]);
      const ph = COLS.map((_, i) => `$${i + 1}`).join(', ');
      const res = await client.query(
        `INSERT INTO public.device_push_tokens (${COLS.join(', ')}) VALUES (${ph}) ON CONFLICT (id) DO NOTHING`,
        values
      );
      if (res.rowCount === 1) ins++; else skip++;
    }
    console.log(`Device push tokens: ${ins} inserted, ${skip} skipped.`);

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
