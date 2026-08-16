#!/usr/bin/env node
'use strict';

/**
 * Migrates InsForge's reports (2) and admin_logs (227) into Supabase,
 * preserving exact UUIDs and all column values, except:
 *
 *   admin_logs.target_user_id is set to NULL for exactly 35 rows that
 *   reference one of the 4 accounts excluded throughout this entire
 *   migration (michael.tomakpan@gmail.com, testerboy3@gmail.com,
 *   ventsresendtest2026@mailinator.com - none were ever imported into
 *   auth.users/public.users). Not a new decision - the same established
 *   exclusion applying naturally here too. The column is nullable
 *   (ON DELETE SET NULL in the source schema), and the log entry itself
 *   (admin_id, action, details, created_at, actor_role) is preserved -
 *   only the broken pointer to an unmigrated user is dropped.
 *
 *   NOTE: the 4th excluded id (portalfix-org test account,
 *   9a7fd475-98f6-43fb-b911-8bdf30489b25) was MISSED on the first --apply
 *   attempt - that account is status='active' on InsForge (excluded from
 *   the auth migration as a product decision, not via deleted_at/status),
 *   so it wasn't caught by the deleted_at/status-based coverage check used
 *   to build the original 15-row exclusion list. The first attempt failed
 *   cleanly on a real FK violation (20 rows referencing this id), rolled
 *   back with zero partial data, and was fixed by adding this 4th id
 *   before retrying.
 *
 * Read-only audit already confirmed: 0 reports.reporter_id and 0
 * admin_logs.admin_id values fall outside the 25 already-migrated users.
 * reports.target_id is a polymorphic reference (target_type + target_id,
 * no FK constraint in the source schema) - migrated as-is regardless of
 * value, nothing to validate against.
 *
 * Modes: --dry-run (default) prints row counts and samples, no writes.
 * --apply requires CONFIRM_APPLY=YES-MIGRATE-REPORTS-ADMINLOGS.
 * Idempotent - every INSERT carries ON CONFLICT (id) DO NOTHING.
 */

const { Client } = require('pg');

const EXCLUDED_TARGET_IDS = new Set([
  '5eca7da6-c253-4782-84ad-772644f5ad59', // michael.tomakpan@gmail.com (status='deleted' anomaly)
  '80439784-eb8b-429c-a137-e3439366e542', // testerboy3@gmail.com (soft-deleted)
  'b35b8268-6be3-44ba-b39a-e9a9dac79031', // ventsresendtest2026@mailinator.com (soft-deleted)
  '9a7fd475-98f6-43fb-b911-8bdf30489b25', // portalfix-org test account (product-decision exclusion,
  // NOT caught by a deleted_at/status check since it's status='active' on
  // InsForge - this is what the first --apply attempt missed, causing a
  // real FK violation (20 admin_logs rows reference it, consistent with
  // being a QA test account for exactly these ban/suspend/delete flows).
  // Confirmed no other data affected - transaction rolled back cleanly.
]);

const REPORT_COLS = ['id','reporter_id','target_type','target_id','reason','details','status','created_at'];
const LOG_COLS = ['id','admin_id','action','target_user_id','details','created_at','actor_role'];

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
  console.log('Fetching InsForge reports and admin_logs (read-only)...');
  const reports = await fetchRows(sourceUrl, 'reports', REPORT_COLS, 'created_at');
  const logs = await fetchRows(sourceUrl, 'admin_logs', LOG_COLS, 'created_at');

  const affectedLogs = logs.filter((l) => l.target_user_id && EXCLUDED_TARGET_IDS.has(l.target_user_id));
  if (affectedLogs.length !== 35) {
    console.error(`FATAL: expected exactly 35 admin_logs rows needing target_user_id nulled, found ${affectedLogs.length} - source data may have changed since this script was written. Refusing to proceed with a stale assumption.`);
    process.exit(1);
  }
  console.log(`Fetched ${reports.length} reports, ${logs.length} admin_logs (${affectedLogs.length} will have target_user_id nulled).`);

  if (!opts.apply) {
    console.log('\n=== Reports (full - only 2) ===');
    console.log(JSON.stringify(reports, null, 1));
    console.log('\n=== Sample admin_log ===');
    console.log(JSON.stringify(logs[0], null, 1));
    console.log('\n=== Affected admin_logs (target_user_id will be nulled) ===');
    for (const l of affectedLogs) console.log(`  ${l.id}: action=${l.action} target_user_id(source)=${l.target_user_id}`);
    console.log(`\n=== Summary ===\n${reports.length} reports + ${logs.length} admin_logs would be inserted (${affectedLogs.length} with target_user_id nulled). No writes performed.`);
    process.exit(0);
  }

  if (process.env.CONFIRM_APPLY !== 'YES-MIGRATE-REPORTS-ADMINLOGS') {
    console.error('FATAL: --apply requires CONFIRM_APPLY=YES-MIGRATE-REPORTS-ADMINLOGS. Refusing to write.');
    process.exit(1);
  }

  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  try {
    const before = await client.query("SELECT (SELECT count(*) FROM reports) AS r, (SELECT count(*) FROM admin_logs) AS a");
    console.log('Target before:', JSON.stringify(before.rows[0]));

    await client.query('BEGIN');

    let rIns = 0, rSkip = 0;
    for (const row of reports) {
      const values = REPORT_COLS.map((c) => row[c]);
      const ph = REPORT_COLS.map((_, i) => `$${i + 1}`).join(', ');
      const res = await client.query(
        `INSERT INTO public.reports (${REPORT_COLS.join(', ')}) VALUES (${ph}) ON CONFLICT (id) DO NOTHING`,
        values
      );
      if (res.rowCount === 1) rIns++; else rSkip++;
    }
    console.log(`Reports: ${rIns} inserted, ${rSkip} skipped.`);

    let lIns = 0, lSkip = 0, lNulled = 0;
    for (const row of logs) {
      const isExcluded = row.target_user_id && EXCLUDED_TARGET_IDS.has(row.target_user_id);
      if (isExcluded) lNulled++;
      const values = LOG_COLS.map((c) => {
        if (c === 'target_user_id') return isExcluded ? null : row[c];
        if (c === 'details') return row[c] == null ? null : JSON.stringify(row[c]);
        return row[c];
      });
      const ph = LOG_COLS.map((_, i) => `$${i + 1}`).join(', ');
      const res = await client.query(
        `INSERT INTO public.admin_logs (${LOG_COLS.join(', ')}) VALUES (${ph}) ON CONFLICT (id) DO NOTHING`,
        values
      );
      if (res.rowCount === 1) lIns++; else lSkip++;
    }
    console.log(`Admin logs: ${lIns} inserted, ${lSkip} skipped, ${lNulled} had target_user_id nulled.`);

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
