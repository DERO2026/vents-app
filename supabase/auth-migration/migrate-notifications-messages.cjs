#!/usr/bin/env node
'use strict';

/**
 * Migrates InsForge's notifications (133), direct_messages (51), and
 * message_reactions (1) into Supabase, preserving exact UUIDs and all
 * column values, except:
 *
 *   3 notifications belonging to michael.tomakpan@gmail.com
 *   (5eca7da6-c253-4782-84ad-772644f5ad59) are SKIPPED - this is the
 *   account already excluded throughout the entire migration (auth,
 *   profile backfill) for having status='deleted' but deleted_at/
 *   deleted_by/reason all NULL, an anomalous deletion state found during
 *   the auth-migration phase. This isn't a new decision, just the same
 *   established exclusion applying naturally to this table too (the user
 *   was never imported into auth.users/public.users, so their
 *   notifications would violate the FK regardless).
 *
 * Read-only audit already confirmed: 0 direct_messages sender_id/
 * recipient_id/event_id values fall outside the migrated sets. 0 rows
 * currently use reply_to_id (the self-referencing FK on direct_messages),
 * so insert order within that table is not a live concern, but rows are
 * still inserted in created_at order defensively.
 *
 * Order: notifications, then direct_messages, then message_reactions
 * (reactions reference messages). All in ONE transaction.
 *
 * Modes: --dry-run (default) prints row counts and a sample, no writes.
 * --apply requires CONFIRM_APPLY=YES-MIGRATE-NOTIFICATIONS-MESSAGES.
 * Idempotent - every INSERT carries ON CONFLICT (id) DO NOTHING.
 */

const { Client } = require('pg');

const EXCLUDED_USER_ID = '5eca7da6-c253-4782-84ad-772644f5ad59'; // michael.tomakpan@gmail.com

const NOTIF_COLS = ['id','user_id','type','title','body','read','icon','created_at','push_sent','push_data'];
const DM_COLS = ['id','sender_id','recipient_id','event_id','body','read_at','created_at','image_url','media_type','deleted_by_sender','duration_seconds','reply_to_id'];
const REACTION_COLS = ['id','message_id','user_id','emoji','created_at'];

function parseArgs(argv) {
  return { apply: argv.includes('--apply') };
}

async function fetchRows(sourceUrl, table, cols, orderCol) {
  const client = new Client({ connectionString: sourceUrl });
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT ${cols.join(', ')} FROM ${table} ORDER BY ${orderCol}`);
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
  console.log('Fetching InsForge notifications, direct_messages, message_reactions (read-only)...');
  const notifsAll = await fetchRows(sourceUrl, 'notifications', NOTIF_COLS, 'created_at');
  const dms = await fetchRows(sourceUrl, 'direct_messages', DM_COLS, 'created_at');
  const reactions = await fetchRows(sourceUrl, 'message_reactions', REACTION_COLS, 'created_at');

  const notifs = notifsAll.filter((n) => n.user_id !== EXCLUDED_USER_ID);
  const excludedCount = notifsAll.length - notifs.length;
  if (excludedCount !== 3) {
    console.error(`FATAL: expected exactly 3 notifications excluded for ${EXCLUDED_USER_ID}, found ${excludedCount} - source data may have changed since this script was written. Refusing to proceed with a stale assumption.`);
    process.exit(1);
  }
  console.log(`Fetched ${notifsAll.length} notifications (${excludedCount} excluded, ${notifs.length} to migrate), ${dms.length} direct_messages, ${reactions.length} message_reactions.`);

  if (!opts.apply) {
    console.log('\n=== Sample notification ===');
    console.log(JSON.stringify(notifs[0], null, 1));
    console.log('\n=== Sample direct_message ===');
    console.log(JSON.stringify(dms[0], null, 1));
    if (reactions.length) {
      console.log('\n=== Sample message_reaction ===');
      console.log(JSON.stringify(reactions[0], null, 1));
    }
    console.log(`\n=== Summary ===\n${notifs.length} notifications + ${dms.length} direct_messages + ${reactions.length} message_reactions would be inserted. No writes performed.`);
    process.exit(0);
  }

  if (process.env.CONFIRM_APPLY !== 'YES-MIGRATE-NOTIFICATIONS-MESSAGES') {
    console.error('FATAL: --apply requires CONFIRM_APPLY=YES-MIGRATE-NOTIFICATIONS-MESSAGES. Refusing to write.');
    process.exit(1);
  }

  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  try {
    const before = await client.query(
      "SELECT (SELECT count(*) FROM notifications) AS n, (SELECT count(*) FROM direct_messages) AS d, (SELECT count(*) FROM message_reactions) AS r"
    );
    console.log('Target before:', JSON.stringify(before.rows[0]));

    await client.query('BEGIN');

    let nIns = 0, nSkip = 0;
    for (const row of notifs) {
      const values = NOTIF_COLS.map((c) => (c === 'push_data' ? (row[c] == null ? null : JSON.stringify(row[c])) : row[c]));
      const ph = NOTIF_COLS.map((_, i) => `$${i + 1}`).join(', ');
      const res = await client.query(
        `INSERT INTO public.notifications (${NOTIF_COLS.join(', ')}) VALUES (${ph}) ON CONFLICT (id) DO NOTHING`,
        values
      );
      if (res.rowCount === 1) nIns++; else nSkip++;
    }
    console.log(`Notifications: ${nIns} inserted, ${nSkip} skipped.`);

    let dIns = 0, dSkip = 0;
    for (const row of dms) {
      const values = DM_COLS.map((c) => row[c]);
      const ph = DM_COLS.map((_, i) => `$${i + 1}`).join(', ');
      const res = await client.query(
        `INSERT INTO public.direct_messages (${DM_COLS.join(', ')}) VALUES (${ph}) ON CONFLICT (id) DO NOTHING`,
        values
      );
      if (res.rowCount === 1) dIns++; else dSkip++;
    }
    console.log(`Direct messages: ${dIns} inserted, ${dSkip} skipped.`);

    let rIns = 0, rSkip = 0;
    for (const row of reactions) {
      const values = REACTION_COLS.map((c) => row[c]);
      const ph = REACTION_COLS.map((_, i) => `$${i + 1}`).join(', ');
      const res = await client.query(
        `INSERT INTO public.message_reactions (${REACTION_COLS.join(', ')}) VALUES (${ph}) ON CONFLICT (id) DO NOTHING`,
        values
      );
      if (res.rowCount === 1) rIns++; else rSkip++;
    }
    console.log(`Message reactions: ${rIns} inserted, ${rSkip} skipped.`);

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
