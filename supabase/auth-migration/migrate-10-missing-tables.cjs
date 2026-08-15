#!/usr/bin/env node
'use strict';

/**
 * Migrates the 10 InsForge tables surfaced by the pre-cutover audit as
 * never having been touched by any prior migration pass:
 *   admin_action_requests (11), app_config (1), checkins (13),
 *   deleted_phones (1), event_reminder_log (10), organizer_requests (7),
 *   organizer_withdrawal_requests (8), pending_purchases (6),
 *   saved_events (1), scan_log (10).
 *
 * All UUIDs and column values preserved as-is, no exclusions - a full
 * read-only audit already confirmed every user_id/event_id/ticket_id/
 * bank_account_id reference across all 10 tables resolves to an
 * already-migrated row (11 distinct user ids checked individually against
 * public.users - none were excluded test accounts, none were among the 4
 * new signups InsForge has picked up since the original 25-user auth
 * migration snapshot).
 *
 * Prerequisite (already applied separately, see
 * supabase/migrations/0015_organizer_requests_withdrawal_fkeys.sql):
 * organizer_requests and organizer_withdrawal_requests were missing their
 * user_id/reviewed_by/organizer_id/resolved_by foreign keys to auth.users
 * - same category of gap as conversation_requests earlier, closed before
 * this data load.
 *
 * Rows are read from pre-fetched JSON snapshots (_10t_<table>.json) taken
 * read-only from InsForge via `insforge db query --unrestricted`, since
 * SOURCE_DATABASE_URL is not available in this shell.
 *
 * Order: independent tables first, then tables with FKs onto each other's
 * targets (all reference already-migrated users/events/tickets/bank
 * accounts, no interdependency among these 10 tables themselves) - order
 * doesn't matter here, kept alphabetical for clarity. All 10 tables in
 * ONE transaction (all-or-nothing across the whole batch).
 *
 * Modes: --dry-run (default) prints row counts and one sample per table,
 * no writes. --apply requires CONFIRM_APPLY=YES-MIGRATE-10-TABLES.
 * Idempotent - every INSERT carries ON CONFLICT DO NOTHING (on the
 * table's actual primary key - `id` for most, `phone` for
 * deleted_phones, `id` boolean for app_config).
 */

const fs = require('fs');
const { Client } = require('pg');

const TABLES = [
  {
    name: 'admin_action_requests',
    cols: ['id', 'action_type', 'target_type', 'target_id', 'target_label', 'payload', 'previous_values', 'requested_changes', 'requested_by', 'requested_by_role', 'status', 'reviewed_by', 'review_reason', 'device', 'ip', 'requested_at', 'reviewed_at', 'seen_at'],
    jsonbCols: ['payload', 'previous_values', 'requested_changes'],
    conflictCol: 'id',
    expectedCount: 11,
  },
  {
    name: 'app_config',
    cols: ['id', 'maintenance_mode', 'broadcast_message', 'updated_at', 'updated_by', 'vc_naira_per_1000', 'vc_min_ticket_price', 'vc_max_redemption_pct', 'min_client_version', 'voice_notes_enabled', 'image_sharing_enabled', 'disable_purchases', 'disable_scanning', 'disable_signups', 'disable_payouts', 'disable_location_sharing'],
    jsonbCols: [],
    conflictCol: 'id',
    expectedCount: 1,
  },
  {
    name: 'checkins',
    cols: ['id', 'ticket_id', 'event_id', 'scanned_by', 'checked_in_at', 'user_id', 'device_id', 'gate_name', 'created_at', 'is_manual_override'],
    jsonbCols: [],
    conflictCol: 'id',
    expectedCount: 13,
  },
  {
    name: 'deleted_phones',
    cols: ['phone', 'deleted_at'],
    jsonbCols: [],
    conflictCol: 'phone',
    expectedCount: 1,
  },
  {
    name: 'event_reminder_log',
    cols: ['id', 'ticket_id', 'kind', 'sent_at'],
    jsonbCols: [],
    conflictCol: 'id',
    expectedCount: 10,
  },
  {
    name: 'organizer_requests',
    cols: ['id', 'user_id', 'reason', 'status', 'admin_note', 'reviewed_by', 'reviewed_at', 'created_at'],
    jsonbCols: [],
    conflictCol: 'id',
    expectedCount: 7,
  },
  {
    name: 'organizer_withdrawal_requests',
    cols: ['id', 'organizer_id', 'amount_kobo', 'status', 'bank_account_id', 'admin_note', 'created_at', 'updated_at', 'paystack_reference', 'transfer_code', 'resolved_by', 'bank_name', 'bank_code', 'account_number', 'account_name'],
    jsonbCols: [],
    conflictCol: 'id',
    expectedCount: 8,
  },
  {
    name: 'pending_purchases',
    cols: ['id', 'event_id', 'user_id', 'ticket_type', 'attendees', 'attendees_hash', 'promo_code', 'amount_kobo', 'payment_ref', 'status', 'created_at'],
    jsonbCols: ['attendees'],
    conflictCol: 'id',
    expectedCount: 6,
  },
  {
    name: 'saved_events',
    cols: ['id', 'user_id', 'event_id', 'created_at'],
    jsonbCols: [],
    conflictCol: 'id',
    expectedCount: 1,
  },
  {
    name: 'scan_log',
    cols: ['id', 'event_id', 'ticket_id', 'scanned_by', 'result', 'reason', 'message', 'device_id', 'gate_name', 'is_manual_override', 'created_at'],
    jsonbCols: [],
    conflictCol: 'id',
    expectedCount: 10,
  },
];

function parseArgs(argv) {
  return { apply: argv.includes('--apply') };
}

function main() {
  return (async () => {
    const opts = parseArgs(process.argv);
    const scratchDir = process.env.SCRATCH_DIR;
    if (!scratchDir) { console.error('FATAL: SCRATCH_DIR not set.'); process.exit(1); }
    const targetUrl = process.env.TARGET_DATABASE_URL;
    if (!targetUrl) { console.error('FATAL: TARGET_DATABASE_URL not set.'); process.exit(1); }

    console.log(`Mode: ${opts.apply ? 'APPLY (writes to target)' : 'DRY RUN (no writes)'}`);

    const loaded = [];
    for (const t of TABLES) {
      const raw = JSON.parse(fs.readFileSync(`${scratchDir}/_10t_${t.name}.json`, 'utf8'));
      const rows = raw.rows;
      if (!Array.isArray(rows) || rows.length !== t.expectedCount) {
        console.error(`FATAL: expected exactly ${t.expectedCount} rows for ${t.name}, found ${Array.isArray(rows) ? rows.length : 'invalid'} - refusing to proceed with a stale/unexpected snapshot.`);
        process.exit(1);
      }
      loaded.push({ ...t, rows });
      console.log(`Loaded ${rows.length} rows for ${t.name}.`);
    }

    if (!opts.apply) {
      for (const t of loaded) {
        console.log(`\n=== ${t.name} sample ===`);
        console.log(JSON.stringify(t.rows[0], null, 1));
      }
      const total = loaded.reduce((s, t) => s + t.rows.length, 0);
      console.log(`\n=== Summary ===\n${total} rows across ${loaded.length} tables would be inserted. No writes performed.`);
      return;
    }

    if (process.env.CONFIRM_APPLY !== 'YES-MIGRATE-10-TABLES') {
      console.error('FATAL: --apply requires CONFIRM_APPLY=YES-MIGRATE-10-TABLES. Refusing to write.');
      process.exit(1);
    }

    const client = new Client({ connectionString: targetUrl });
    await client.connect();
    try {
      await client.query('BEGIN');

      for (const t of loaded) {
        let ins = 0, skip = 0;
        for (const row of t.rows) {
          const values = t.cols.map((c) => {
            const v = row[c];
            if (v == null) return null;
            return t.jsonbCols.includes(c) ? JSON.stringify(v) : v;
          });
          const ph = t.cols.map((_, i) => `$${i + 1}`).join(', ');
          const res = await client.query(
            `INSERT INTO public.${t.name} (${t.cols.join(', ')}) VALUES (${ph}) ON CONFLICT (${t.conflictCol}) DO NOTHING`,
            values
          );
          if (res.rowCount === 1) ins++; else skip++;
        }
        console.log(`${t.name}: ${ins} inserted, ${skip} skipped.`);
      }

      await client.query('COMMIT');
      console.log('\nCommitted.');
    } catch (err) {
      console.error('FATAL, rolling back entire batch:', err.message);
      await client.query('ROLLBACK').catch(() => {});
      process.exitCode = 1;
    } finally {
      await client.end();
    }
  })();
}

main().catch((err) => {
  console.error('FATAL (unhandled):', err);
  process.exit(1);
});
