# Daily database backup

Workflow: `.github/workflows/db-backup.yml`. Scripts: `scripts/ops/db-backup-*.sh`,
`scripts/ops/verify-backup-restore.sh`. Self-test: `scripts/local-pg-test/run-db-backup-pipeline-selftest.sh`.

## What it does

Every day at 02:17 UTC, or when started by hand (Actions → Database backup → Run workflow), the workflow:

1. Runs `pg_dump` (PostgreSQL 17, custom format, compressed) against production through the Supabase **session pooler**. `pg_dump` only reads, inside a READ ONLY transaction. The workflow sends no other SQL to production.
2. Streams the archive straight into `gpg --symmetric` (AES-256), so the plain dump is never written to disk.
3. Validates the backup on the same throwaway VM. It decrypts the file, which checks integrity. It reads the archive's table of contents. Then it restores the archive into a **local** PostgreSQL 17 database (the drill refuses any hosted server) and checks that every public table came back with exactly as many rows as the backup holds.
4. Uploads the backup only after it is verified. The artifact holds three files: the **encrypted** file, its sha256, and a manifest. Artifacts are kept for **30 days**.

Any failure fails the run. GitHub sends the failure notice for scheduled runs to the account that last changed the `cron` line in the workflow file, by email if that account's notification settings allow it. Confirm you get the first one.

## Settings it relies on (environment `o4-backup`)

| Setting | Needed | Notes |
|---|---|---|
| Secret `DATABASE_URL` | yes | Session pooler URI on port 5432: `postgresql://postgres.slrtjxtzhowhwhebjprv:<password>@<region>.pooler.supabase.com:5432/postgres`. The password must be URL-encoded. Any other shape is refused before a connection is made. |
| Secret `BACKUP_ENCRYPTION_PASSPHRASE` | recommended | At least 24 characters. Without it, the key is derived from `DATABASE_URL` (see below) and every run shows a warning. |
| Deployment branches | must include `main` | Scheduled runs come from `main`. If the environment allows only another branch, every scheduled run is rejected. |
| Required reviewers | should be off | With a reviewer, every daily run waits for a manual approval, and if it isn't given, no backup is taken. |

## The encryption key

- **With `BACKUP_ENCRYPTION_PASSPHRASE`:** the key is that secret's value.
- **Without it:** the key is `HMAC-SHA256(key="vents-db-backup-v1", message=<the full DATABASE_URL>)` in hex. Anyone holding the database URL can decrypt, which is no worse than what that URL already allows. The catch is a password change: backups taken before it can only be decrypted with the **old** URL, and GitHub will not show you a secret's old value. If you ever have to rotate the password after an incident, the pre-incident backups are exactly the ones you would need, so add the dedicated passphrase secret and keep a copy of it somewhere safe.

GitHub secrets cannot be read back. Keep your own copy of the passphrase, or decrypt inside a workflow run that has access to the secret.

## Restoring from an artifact

1. Download the artifact from the run page (Actions → Database backup → the run → Artifacts), then unzip it.
2. Check the file: `sha256sum -c vents-db-<stamp>.dump.gpg.sha256`.
3. Decrypt it: `gpg --batch --pinentry-mode loopback --passphrase-file key.txt -o backup.dump -d vents-db-<stamp>.dump.gpg`. For a derived key, create `key.txt` with `printf '%s' "$DATABASE_URL" | openssl dgst -sha256 -hmac vents-db-backup-v1 -r | cut -d' ' -f1 | tr -d '\n' > key.txt`.
4. Restore **into a new, empty database, never into production**: `pg_restore --no-owner --no-privileges -d <target> backup.dump`. Before that, rehearse locally with `scripts/ops/verify-backup-restore.sh backup.dump`.

## What this backup does NOT contain

- **Storage files** (event images, avatars, verification documents). Only the `storage` schema's metadata rows are included.
- **Database roles and their passwords**, which `pg_dumpall --roles-only` would cover.
- **Supabase project settings**: Auth providers, redirect URLs, SMTP, API keys, edge-function code and secrets, and Vercel environment variables.
- Anything written after the dump's snapshot. On the Free plan this is a daily snapshot, so up to 24 hours of changes can be lost. It is not point-in-time recovery.

## Limits to know

- The repository is public. Any signed-in GitHub user can read the logs and download the artifacts. The logs print only pass/fail lines, and the artifact is ciphertext, so its safety rests on the key's strength.
- `schedule` runs only from the default branch. GitHub can delay or skip scheduled runs under load, and it **disables a public repository's schedules after 60 days without repository activity**.
- `pg_dump` takes ACCESS SHARE locks for its whole duration. A migration (DDL) started during the dump waits for it to finish. Avoid running migrations at 02:17 UTC.
- Function fingerprints are reported, not enforced (`function_check=report`). Once 0201–0203 are applied they no longer match the pre-apply snapshot, by design. For the O4 rehearsal, start a run by hand with `function_check=enforce`, which also requires 19/19.
