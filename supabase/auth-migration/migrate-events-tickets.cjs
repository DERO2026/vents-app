#!/usr/bin/env node
'use strict';

/**
 * Migrates InsForge's events (43) and tickets (43) into Supabase, preserving
 * exact UUIDs, FKs, and all column values, except:
 *
 *   events.payout_account_id is ALWAYS set to NULL, regardless of the
 *   InsForge source value. organizer_bank_accounts (the FK target) is out
 *   of scope for this pass and has zero rows on Supabase - passing through
 *   a non-null source value would make set_event_payout_account()'s trigger
 *   validation fail with "payout_account_id must be one of your own active
 *   bank accounts" (confirmed by reading the trigger body). Only 3 of 43
 *   events have a non-null value on InsForge; this is a deliberate,
 *   documented scope boundary, not data loss - the value can be restored
 *   once organizer_bank_accounts is migrated in a later pass.
 *
 * Read-only audit already confirmed (see chat): 0 organizer_id / user_id /
 * deleted_by / hidden_by / scanner_id / refund_initiated_by values fall
 * outside the 25 already-migrated users. All 43 tickets are
 * status='active', payment_status='paid'. All event text fields pass
 * validate_events_input()'s length/format checks.
 *
 * Order: events inserted before tickets (tickets.event_id -> events.id),
 * both in ONE transaction (all-or-nothing across both tables) - a ticket
 * referencing an event that failed to insert must never be possible.
 *
 * Modes: --dry-run (default) prints row counts and a sample, no writes.
 * --apply requires CONFIRM_APPLY=YES-MIGRATE-EVENTS-TICKETS. Idempotent -
 * every INSERT carries ON CONFLICT (id) DO NOTHING.
 */

const { Client } = require('pg');

const EVENT_COLS = [
  'id','title','description','image_url','location','event_date','price','category',
  'organizer_id','created_at','ticket_types','ticket_goal','status','is_featured',
  'hidden_by_admin','hidden_at','hidden_by','is_18_plus','start_time','end_time',
  'categories','featured_until','deleted_at','deleted_by','reason','gallery_urls',
  /* payout_account_id intentionally excluded - always NULL, see header */
  'latitude','longitude','place_id','end_date','contact_phone','show_phone',
];

const TICKET_COLS = [
  'id','event_id','user_id','quantity','status','created_at','payment_ref',
  'payment_status','amount','ticket_type','checked_in','checked_in_at','scanner_id',
  'holder_name','holder_email','promo_code','discount_percentage','refund_id',
  'refund_reason','refund_initiated_by','holder_phone',
];

function parseArgs(argv) {
  return { apply: argv.includes('--apply') };
}

async function fetchRows(sourceUrl, table, cols) {
  const client = new Client({ connectionString: sourceUrl });
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT ${cols.join(', ')} FROM ${table} ORDER BY created_at`);
    return rows;
  } finally {
    await client.end();
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const targetUrl = process.env.TARGET_DATABASE_URL;
  if (!sourceUrl) { console.error('FATAL: SOURCE_DATABASE_URL not set.'); process.exit(1); }
  if (!targetUrl) { console.error('FATAL: TARGET_DATABASE_URL not set.'); process.exit(1); }

  console.log(`Mode: ${opts.apply ? 'APPLY (writes to target)' : 'DRY RUN (no writes)'}`);
  console.log('Fetching InsForge events and tickets (read-only)...');
  const events = await fetchRows(sourceUrl, 'events', EVENT_COLS);
  const tickets = await fetchRows(sourceUrl, 'tickets', TICKET_COLS);
  console.log(`Fetched ${events.length} events, ${tickets.length} tickets.`);

  // payout_account_id is deliberately excluded from EVENT_COLS/the SELECT
  // above (always inserted as NULL - see header), so it's checked with its
  // own small query here purely for an accurate informational count.
  const payoutClient = new Client({ connectionString: sourceUrl });
  await payoutClient.connect();
  const { rows: payoutRows } = await payoutClient.query('SELECT count(*) FROM events WHERE payout_account_id IS NOT NULL');
  await payoutClient.end();
  console.log(`${payoutRows[0].count} event(s) have a non-null payout_account_id on InsForge - will be inserted as NULL regardless (see header comment).`);

  if (!opts.apply) {
    console.log('\n=== Sample event ===');
    console.log(JSON.stringify(events[0], null, 1));
    console.log('\n=== Sample ticket ===');
    console.log(JSON.stringify(tickets[0], null, 1));
    console.log(`\n=== Summary ===\n${events.length} events + ${tickets.length} tickets would be inserted. No writes performed.`);
    process.exit(0);
  }

  if (process.env.CONFIRM_APPLY !== 'YES-MIGRATE-EVENTS-TICKETS') {
    console.error('FATAL: --apply requires CONFIRM_APPLY=YES-MIGRATE-EVENTS-TICKETS. Refusing to write.');
    process.exit(1);
  }

  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  try {
    const beforeE = await client.query('SELECT count(*) FROM events');
    const beforeT = await client.query('SELECT count(*) FROM tickets');
    console.log(`Target before: events=${beforeE.rows[0].count} tickets=${beforeT.rows[0].count}`);

    await client.query('BEGIN');

    let eventsInserted = 0, eventsSkipped = 0;
    for (const row of events) {
      const cols = [...EVENT_COLS, 'payout_account_id'];
      const values = EVENT_COLS.map((c) => {
        if (c === 'ticket_types') return JSON.stringify(row[c]);
        return row[c];
      });
      values.push(null); // payout_account_id always NULL
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const res = await client.query(
        `INSERT INTO public.events (${cols.join(', ')}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`,
        values
      );
      if (res.rowCount === 1) eventsInserted++; else eventsSkipped++;
    }
    console.log(`Events: ${eventsInserted} inserted, ${eventsSkipped} skipped (already present).`);

    let ticketsInserted = 0, ticketsSkipped = 0;
    for (const row of tickets) {
      const values = TICKET_COLS.map((c) => row[c]);
      const placeholders = TICKET_COLS.map((_, i) => `$${i + 1}`).join(', ');
      const res = await client.query(
        `INSERT INTO public.tickets (${TICKET_COLS.join(', ')}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`,
        values
      );
      if (res.rowCount === 1) ticketsInserted++; else ticketsSkipped++;
    }
    console.log(`Tickets: ${ticketsInserted} inserted, ${ticketsSkipped} skipped (already present).`);

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
