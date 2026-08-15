#!/usr/bin/env node
'use strict';

/**
 * InsForge -> Supabase Auth user migration.
 *
 * Scope: the ~29 VENTS users who have BOTH an InsForge auth.users row AND a
 * matching public.users profile. Deliberately excludes:
 *   - the one legitimately, deliberately soft-deleted account
 *     (deleted_<id>@deleted.vents pattern) - resurrecting a user's own
 *     account deletion would be a real harm, not a migration bug
 *   - anyone with no public.users profile at all (the source-side JOIN
 *     structurally excludes these; see fetchSourceUsers())
 *
 * Modes:
 *   --dry-run (default)  Connects to SOURCE only. Validates every record,
 *                         reports exactly what WOULD be written. Opens no
 *                         connection to the target and issues zero writes
 *                         anywhere - the target connection code path does
 *                         not even run in this mode.
 *   --apply               Connects to SOURCE and TARGET. Requires BOTH
 *                         --apply AND the environment variable
 *                         CONFIRM_APPLY=YES-MIGRATE-AUTH to actually write -
 *                         either alone is not enough. Idempotent: skips any
 *                         user whose id already exists in the target
 *                         auth.users, and every insert also carries an
 *                         ON CONFLICT DO NOTHING as a second, SQL-level
 *                         guard against duplicate rows on a re-run or race.
 *
 * Fail-safe validation: if ANY source record fails validation, the entire
 * run aborts before touching the target at all - no partial import, no
 * silent skip of a bad record while others proceed. Every validation
 * failure is reported with the specific reason.
 *
 * Env vars:
 *   SOURCE_DATABASE_URL   InsForge Postgres connection string (read-only
 *                         usage - this script issues no INSERT/UPDATE/DELETE
 *                         against SOURCE under any mode).
 *   TARGET_DATABASE_URL   Supabase Postgres connection string. Only read in
 *                         --apply mode (or --dry-run --check-target, see
 *                         below). Must be a role with INSERT privilege on
 *                         the `auth` schema (the Postgres superuser /
 *                         `postgres` role, or `supabase_auth_admin` - NOT
 *                         the anon/authenticated PostgREST roles, which
 *                         cannot write to `auth` and should not be able to).
 *   CONFIRM_APPLY         Must exactly equal "YES-MIGRATE-AUTH" to allow
 *                         --apply to do anything. This is deliberately a
 *                         separate, easy-to-grep env var rather than a
 *                         CLI flag alone, so --apply can never fire from a
 *                         copy-pasted command missing this line.
 *
 * Optional flags:
 *   --check-target         In --dry-run mode, also connects to TARGET
 *                          read-only (SELECT only) to report which users
 *                          already exist there vs. would be newly inserted.
 *                          Without this flag, --dry-run never opens a
 *                          target connection at all.
 *   --allow-count-mismatch Suppress the informational warning if the
 *                          source record count differs from the 29 this
 *                          script was built against (expected to grow
 *                          slightly between audit and actual cutover as
 *                          real users continue signing up - this is a
 *                          warning, not a validation failure, either way).
 */

const { Client } = require('pg');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Known-good as of the 2026-08-14 audit. Belt-and-suspenders explicit
// exclusion in addition to the structural INNER JOIN in fetchSourceUsers()
// (which already excludes this id because it has no public.users profile) -
// if this id ever shows up in the fetched set for any reason, that is
// treated as a hard validation failure, not a silent skip.
const DELETED_ACCOUNT_ID = 'aaaabbbb-cccc-dddd-eeee-ffff00001111';

// Explicit, product-decision exclusion (not a data-integrity issue like
// DELETED_ACCOUNT_ID above) - id 9a7fd475-98f6-43fb-b911-8bdf30489b25,
// email portalfix-org-1784293549518@vents-test.local, has the signature of
// an automated QA/test-suite signup (.local TLD, timestamp-suffixed
// username, no real name), unlike the "testerboy"-named accounts
// (testerboy2@gmail.com, bbgbbg1357@gmail.com) which were deliberately
// KEPT - those have real gmail addresses and real verified credentials,
// this one does not. Decision confirmed with the account owner on
// 2026-08-14; hardcoded by id (not a domain/pattern heuristic) so it can
// never accidentally catch a future real user.
const PRODUCT_EXCLUDED_IDS = new Set([
  '9a7fd475-98f6-43fb-b911-8bdf30489b25', // portalfix-org test account
]);

// Updated from the audit's original 29 -> 27 -> 26 -> 25. Each drop found
// by this script's own investigation against real data, not assumed
// upfront: 2 soft-deleted-but-profile-retained accounts (deleted_at check),
// 1 more caught only by status='deleted' independent of deleted_at (see the
// SOURCE_QUERY comment above), and 1 product-decision exclusion
// (PRODUCT_EXCLUDED_IDS above).
const EXPECTED_USER_COUNT = 25;

// Supabase's standard single-tenant GoTrue instance id. Verified against
// the target project when --check-target or --apply actually connects
// (see verifyTargetInstanceId); this constant is the well-known default
// and is only a fallback assumption in modes that don't reach the target.
const DEFAULT_INSTANCE_ID = '00000000-0000-0000-0000-000000000000';

const BCRYPT_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Deliberately permissive (matches what the app's own client-side check
// allows) - this script is not the place to newly reject an email InsForge
// itself already accepted at signup.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// CLI / env parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  const apply = args.has('--apply');
  return {
    apply, // dry-run is simply "not --apply" - see main(); --apply additionally requires CONFIRM_APPLY to do anything
    checkTarget: args.has('--check-target'),
    allowCountMismatch: args.has('--allow-count-mismatch'),
  };
}

// ---------------------------------------------------------------------------
// Source fetch (InsForge) - SELECT only, never writes
// ---------------------------------------------------------------------------

const SOURCE_QUERY = `
  SELECT
    a.id,
    a.email,
    a.password        AS password_hash,
    a.email_verified,
    a.created_at,
    a.updated_at,
    a.is_anonymous,
    a.profile->>'name' AS profile_name,
    u.username,
    u.full_name        AS public_full_name,
    u.role,
    u.status,
    u.banned_until,
    u.deleted_at
  FROM auth.users a
  INNER JOIN public.users u ON u.id = a.id
  WHERE u.deleted_at IS NULL
    AND u.status <> 'deleted'
  ORDER BY a.created_at;
`;
// Three distinct structural exclusions, ALL discovered/confirmed via this
// script's own investigation against real data, not assumed upfront:
//   1. INNER JOIN excludes auth.users rows with no public.users profile at
//      all - covers accounts deleted via the email-scrambling pattern
//      (deleted_<id>@deleted.vents), which removes/never-had a profile row.
//   2. WHERE u.deleted_at IS NULL excludes accounts deleted via
//      delete_own_account(), which sets status='deleted' + deleted_at but
//      LEAVES the profile row (with its real email) in place - a second,
//      different deletion mechanism that the original audit's simpler
//      "does a profile row exist" check did not catch. Found by this
//      script's own validation layer during its first real dry-run
//      (2 accounts: testerboy3@gmail.com, ventsresendtest2026@mailinator.com,
//      both deleted 2026-08-04, both status='deleted').
//   3. AND u.status <> 'deleted' - a THIRD, independent signal, added after
//      finding one account (michael.tomakpan@gmail.com,
//      5eca7da6-c253-4782-84ad-772644f5ad59) with status='deleted' but
//      deleted_at/deleted_by/reason all NULL - i.e. marked deleted through
//      some path that never went through the normal delete_own_account()
//      RPC (confirmed via a database-wide sweep: this is the ONLY row in
//      public.users where status and deleted_at disagree with each other -
//      not a systemic issue, just this one account). Relying on deleted_at
//      alone would have silently imported this user despite status=deleted.
//      validateRecord() below still hard-fails on either signal as
//      defense-in-depth in case a fourth deletion pattern exists that none
//      of these three catch.

async function fetchSourceUsers(sourceUrl) {
  const client = new Client({ connectionString: sourceUrl });
  await client.connect();
  try {
    const { rows } = await client.query(SOURCE_QUERY);
    return rows;
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Validation - fail-safe: collect every problem, never silently skip
// ---------------------------------------------------------------------------

/**
 * @returns {{errors: string[], warnings: string[]}} for this single record.
 * An empty errors array means the record is safe to import. Warnings are
 * informational only (e.g. "this user is currently suspended") and never
 * block the migration - they are surfaced so a human reviews them.
 */
function validateRecord(row) {
  const errors = [];
  const warnings = [];
  const tag = `[${row.id || '(missing id)'} / ${row.email || '(missing email)'}]`;

  if (!row.id || typeof row.id !== 'string' || !UUID_RE.test(row.id)) {
    errors.push(`${tag} invalid or missing id (must be a UUID): ${JSON.stringify(row.id)}`);
  }
  if (row.id === DELETED_ACCOUNT_ID) {
    errors.push(`${tag} this is the known deliberately-deleted account id and must never be imported - the source query should have excluded it structurally; its presence here means the exclusion logic itself is broken and must be investigated before proceeding`);
  }

  if (!row.email || typeof row.email !== 'string' || !EMAIL_RE.test(row.email)) {
    errors.push(`${tag} invalid or missing email: ${JSON.stringify(row.email)}`);
  }

  if (row.is_anonymous) {
    if (row.password_hash !== null) {
      errors.push(`${tag} is_anonymous=true but has a non-null password_hash - anonymous accounts should never have a password; this is unexpected source data, not something to silently paper over`);
    }
  } else {
    if (row.password_hash === null || row.password_hash === undefined) {
      errors.push(`${tag} not anonymous but has no password hash - cannot migrate without a credential`);
    } else if (!BCRYPT_RE.test(row.password_hash)) {
      errors.push(`${tag} password hash is not a valid bcrypt hash (expected $2a$/$2b$/$2y$ + 2-digit cost + 53 chars, got length ${row.password_hash.length}, prefix "${row.password_hash.slice(0, 7)}") - this account cannot have its password migrated as-is and needs a separate decision (e.g. forced reset), not a silent skip`);
    }
  }

  if (typeof row.email_verified !== 'boolean') {
    errors.push(`${tag} email_verified is not a boolean: ${JSON.stringify(row.email_verified)}`);
  }

  if (!row.created_at) {
    errors.push(`${tag} missing created_at - needed as the email_confirmed_at backfill timestamp for verified users`);
  }

  if (row.status === 'suspended' || row.status === 'banned') {
    warnings.push(`${tag} account status is "${row.status}" on InsForge - will still be migrated (this script does not make suspension decisions), but the operator should be aware`);
  }
  if (row.deleted_at) {
    errors.push(`${tag} has a non-null deleted_at on public.users despite passing the source query filter - this is a soft-deleted profile that should not be migrated; investigate why it wasn't excluded upstream`);
  }
  if (row.status === 'deleted') {
    errors.push(`${tag} has status='deleted' on public.users despite passing the source query filter - this is a deleted account that should not be migrated (this exact signal, independent of deleted_at, is what caught michael.tomakpan@gmail.com during investigation - a row where status='deleted' but deleted_at was NULL); investigate why it wasn't excluded upstream`);
  }

  return { errors, warnings };
}

function validateAll(rows) {
  const seenIds = new Map();
  const seenEmails = new Map();
  const perRecordErrors = [];
  const perRecordWarnings = [];

  for (const row of rows) {
    const { errors, warnings } = validateRecord(row);
    perRecordErrors.push(...errors);
    perRecordWarnings.push(...warnings);

    if (row.id) {
      if (seenIds.has(row.id)) {
        perRecordErrors.push(`Duplicate id in source result set: ${row.id} (rows for "${seenIds.get(row.id)}" and "${row.email}")`);
      } else {
        seenIds.set(row.id, row.email);
      }
    }
    if (row.email) {
      const key = row.email.toLowerCase();
      if (seenEmails.has(key)) {
        perRecordErrors.push(`Duplicate email (case-insensitive) in source result set: "${row.email}" (ids ${seenEmails.get(key)} and ${row.id})`);
      } else {
        seenEmails.set(key, row.id);
      }
    }
  }

  return { errors: perRecordErrors, warnings: perRecordWarnings };
}

// ---------------------------------------------------------------------------
// Field mapping: InsForge auth.users row -> Supabase auth.users + auth.identities
// ---------------------------------------------------------------------------

function mapToSupabaseUser(row, instanceId) {
  const rawUserMetaData = {};
  if (row.profile_name) rawUserMetaData.full_name = row.profile_name;

  return {
    instance_id: instanceId,
    id: row.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: row.email,
    encrypted_password: row.password_hash, // verbatim bcrypt hash, or null for anonymous
    email_confirmed_at: row.email_verified ? row.created_at : null,
    raw_app_meta_data: {}, // confirmed empty for every source user during the audit
    raw_user_meta_data: rawUserMetaData,
    is_anonymous: !!row.is_anonymous,
    created_at: row.created_at,
    updated_at: row.updated_at || row.created_at,
    // GoTrue convention: these token columns are empty string, not NULL.
    confirmation_token: '',
    recovery_token: '',
    email_change_token_new: '',
    email_change_token_current: '',
    reauthentication_token: '',
    email_change: '',
    // Deliberately NOT set: phone/phone_confirmed_at (InsForge never had
    // phone-based auth - see audit), banned_until/deleted_at (VENTS' own
    // ban/delete state lives in public.users and is out of scope for the
    // auth-layer migration; do not invent a mapping that wasn't requested).
  };
}

function mapToSupabaseIdentity(row) {
  return {
    id: crypto.randomUUID(),
    user_id: row.id,
    provider: 'email',
    provider_id: row.id, // Supabase's own convention for the "email" provider
    identity_data: {
      sub: row.id,
      email: row.email,
      email_verified: !!row.email_verified,
    },
    email: row.email,
    created_at: row.created_at,
    updated_at: row.updated_at || row.created_at,
    last_sign_in_at: null,
  };
}

// ---------------------------------------------------------------------------
// Target (Supabase) - only reached in --apply or --dry-run --check-target
// ---------------------------------------------------------------------------

async function fetchExistingTargetIds(targetUrl, ids) {
  if (ids.length === 0) return new Set();
  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  try {
    const { rows } = await client.query(
      'SELECT id FROM auth.users WHERE id = ANY($1::uuid[])',
      [ids]
    );
    return new Set(rows.map((r) => r.id));
  } finally {
    await client.end();
  }
}

async function verifyTargetInstanceId(targetUrl) {
  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT DISTINCT instance_id FROM auth.users LIMIT 5');
    if (rows.length === 0) return { instanceId: DEFAULT_INSTANCE_ID, verified: false };
    if (rows.length > 1) {
      throw new Error(`Target auth.users has more than one distinct instance_id already (${rows.map((r) => r.instance_id).join(', ')}) - this script assumes a single-tenant project and cannot safely guess which to use. Investigate before proceeding.`);
    }
    return { instanceId: rows[0].instance_id, verified: true };
  } finally {
    await client.end();
  }
}

async function applyUser(client, mappedUser, mappedIdentity) {
  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO auth.users (
         instance_id, id, aud, role, email, encrypted_password,
         email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
         is_anonymous, created_at, updated_at,
         confirmation_token, recovery_token, email_change_token_new,
         email_change_token_current, reauthentication_token, email_change
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
       )
       ON CONFLICT (id) DO NOTHING`,
      [
        mappedUser.instance_id, mappedUser.id, mappedUser.aud, mappedUser.role,
        mappedUser.email, mappedUser.encrypted_password, mappedUser.email_confirmed_at,
        JSON.stringify(mappedUser.raw_app_meta_data), JSON.stringify(mappedUser.raw_user_meta_data),
        mappedUser.is_anonymous, mappedUser.created_at, mappedUser.updated_at,
        mappedUser.confirmation_token, mappedUser.recovery_token, mappedUser.email_change_token_new,
        mappedUser.email_change_token_current, mappedUser.reauthentication_token, mappedUser.email_change,
      ]
    );
    // NOTE: auth.identities.email is a Supabase GENERATED column (derived
    // from identity_data->>'email') - it cannot be supplied explicitly.
    // identity_data still carries the email (see mapToSupabaseIdentity);
    // Postgres populates the generated column from that automatically.
    await client.query(
      `INSERT INTO auth.identities (
         id, user_id, provider, provider_id, identity_data, created_at, updated_at, last_sign_in_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (provider, provider_id) DO NOTHING`,
      [
        mappedIdentity.id, mappedIdentity.user_id, mappedIdentity.provider, mappedIdentity.provider_id,
        JSON.stringify(mappedIdentity.identity_data),
        mappedIdentity.created_at, mappedIdentity.updated_at, mappedIdentity.last_sign_in_at,
      ]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function redactHash(hash) {
  if (!hash) return '(none - anonymous account)';
  return `${hash.slice(0, 7)}...(${hash.length} chars total, redacted)`;
}

function printDryRunReport(rows, existingTargetIds) {
  console.log('\n=== DRY RUN — no writes performed, no target connection opened unless --check-target was passed ===\n');
  let wouldInsert = 0;
  let alreadyPresent = 0;

  for (const row of rows) {
    const already = existingTargetIds && existingTargetIds.has(row.id);
    if (already) alreadyPresent++; else wouldInsert++;

    const mappedUser = mapToSupabaseUser(row, DEFAULT_INSTANCE_ID);
    console.log(`${already ? '[SKIP - already exists on target]' : '[WOULD IMPORT]'} ${row.id}`);
    console.log(`  email:               ${mappedUser.email}`);
    console.log(`  encrypted_password:  ${redactHash(mappedUser.encrypted_password)}`);
    console.log(`  email_confirmed_at:  ${mappedUser.email_confirmed_at ? mappedUser.email_confirmed_at.toISOString() : 'NULL (unverified)'}`);
    console.log(`  is_anonymous:        ${mappedUser.is_anonymous}`);
    console.log(`  raw_user_meta_data:  ${JSON.stringify(mappedUser.raw_user_meta_data)}`);
    console.log(`  created_at:          ${mappedUser.created_at.toISOString()}`);
    console.log(`  identities row:      provider=email, provider_id=${row.id}, identity_data.email_verified=${!!row.email_verified}`);
    console.log('');
  }

  console.log('=== Summary ===');
  console.log(`Total valid source records: ${rows.length}`);
  if (existingTargetIds) {
    console.log(`Already present on target (would skip): ${alreadyPresent}`);
    console.log(`Would newly insert: ${wouldInsert}`);
  } else {
    console.log('(target not checked - pass --check-target to see which of these already exist on Supabase)');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv);
  const sourceUrl = process.env.SOURCE_DATABASE_URL;

  if (!sourceUrl) {
    console.error('FATAL: SOURCE_DATABASE_URL is not set. Refusing to run.');
    process.exit(1);
  }

  console.log(`Mode: ${opts.apply ? 'APPLY (writes to target)' : 'DRY RUN (no writes)'}`);
  console.log('Fetching source users from InsForge (read-only)...');
  const fetchedRows = await fetchSourceUsers(sourceUrl);
  console.log(`Fetched ${fetchedRows.length} source records (auth.users JOIN public.users).`);

  // Product-decision exclusions: filtered here, transparently logged, BEFORE
  // validation runs - this is intentional curation (confirmed with the
  // account owner), not a data-integrity problem, so it does not go through
  // the fail-safe validation-error path. Contrast with DELETED_ACCOUNT_ID,
  // which IS a hard validation failure if it ever appears (see
  // validateRecord) because its presence would mean the structural SQL
  // exclusion itself broke.
  const rows = fetchedRows.filter((row) => {
    if (PRODUCT_EXCLUDED_IDS.has(row.id)) {
      console.log(`Excluding ${row.id} (${row.email}) — product-decision exclusion, not a validation error (see PRODUCT_EXCLUDED_IDS).`);
      return false;
    }
    return true;
  });
  if (rows.length !== fetchedRows.length) {
    console.log(`${fetchedRows.length - rows.length} record(s) removed by product-decision exclusion. ${rows.length} remain for validation.`);
  }

  if (rows.length !== EXPECTED_USER_COUNT && !opts.allowCountMismatch) {
    console.warn(`WARNING: expected ${EXPECTED_USER_COUNT} users (per the 2026-08-14 audit), fetched ${rows.length}. This is a warning, not a hard failure - the user base may have legitimately grown since the audit. Pass --allow-count-mismatch to suppress this message, or investigate if the number is unexpectedly lower.`);
  }

  console.log('Validating every record before any further action...');
  const { errors, warnings } = validateAll(rows);

  if (warnings.length > 0) {
    console.log(`\n${warnings.length} warning(s) (informational, do not block the migration):`);
    for (const w of warnings) console.log(`  - ${w}`);
  }

  if (errors.length > 0) {
    console.error(`\nFATAL: ${errors.length} validation error(s). Aborting before any target action - no partial import, no silent skip.`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`All ${rows.length} records passed validation.\n`);

  if (!opts.apply) {
    let existingTargetIds = null;
    if (opts.checkTarget) {
      const targetUrl = process.env.TARGET_DATABASE_URL;
      if (!targetUrl) {
        console.error('FATAL: --check-target was passed but TARGET_DATABASE_URL is not set.');
        process.exit(1);
      }
      console.log('Checking target (Supabase) for already-existing rows (read-only SELECT)...');
      existingTargetIds = await fetchExistingTargetIds(targetUrl, rows.map((r) => r.id));
    }
    printDryRunReport(rows, existingTargetIds);
    process.exit(0);
  }

  // --apply path
  if (process.env.CONFIRM_APPLY !== 'YES-MIGRATE-AUTH') {
    console.error('FATAL: --apply was passed but CONFIRM_APPLY is not set to exactly "YES-MIGRATE-AUTH". Refusing to write. This double-confirmation is intentional.');
    process.exit(1);
  }
  const targetUrl = process.env.TARGET_DATABASE_URL;
  if (!targetUrl) {
    console.error('FATAL: --apply requires TARGET_DATABASE_URL.');
    process.exit(1);
  }

  console.log('Verifying target instance_id...');
  const { instanceId, verified } = await verifyTargetInstanceId(targetUrl);
  console.log(`Using instance_id: ${instanceId} (${verified ? 'read from existing target rows' : 'target auth.users is empty, using Supabase default'})`);

  const existingTargetIds = await fetchExistingTargetIds(targetUrl, rows.map((r) => r.id));
  console.log(`${existingTargetIds.size} of ${rows.length} users already present on target - will be skipped (idempotent re-run).`);

  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  let imported = 0;
  let skipped = 0;
  try {
    for (const row of rows) {
      if (existingTargetIds.has(row.id)) {
        skipped++;
        continue;
      }
      const mappedUser = mapToSupabaseUser(row, instanceId);
      const mappedIdentity = mapToSupabaseIdentity(row);
      console.log(`Importing ${row.id} (${row.email})...`);
      await applyUser(client, mappedUser, mappedIdentity);
      imported++;
    }
  } finally {
    await client.end();
  }

  console.log(`\nDone. Imported: ${imported}. Skipped (already present): ${skipped}. Total considered: ${rows.length}.`);
}

main().catch((err) => {
  console.error('FATAL (unhandled):', err);
  process.exit(1);
});
