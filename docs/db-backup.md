# Daily database backup

Workflow: `.github/workflows/db-backup.yml`. Scripts: `scripts/ops/db-backup-*.sh`,
`scripts/ops/verify-backup-restore.sh`, `scripts/ops/db-backup-decrypt.sh`. Self-test: `scripts/local-pg-test/run-db-backup-pipeline-selftest.sh`.

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
| Secret `DATABASE_URL` | yes | Either the session pooler URI on port 5432 (`postgresql://postgres.slrtjxtzhowhwhebjprv:<password>@<region>.pooler.supabase.com:5432/postgres`) or the dashboard's direct URI (`postgresql://postgres:<password>@db.slrtjxtzhowhwhebjprv.supabase.co:5432/postgres`). The direct one is IPv6-only, so the dump script converts it to the session pooler with the same password. The password must be URL-encoded. Any other shape is refused before a connection is made. This secret is used **only** to connect, never for the key. |
| Secret `BACKUP_ENCRYPTION_PASSPHRASE` | **yes** | The only encryption key. At least 32 characters. If it is missing or short, the run stops before connecting. There is no fallback key. |
| Deployment branches | must include `main` | Scheduled runs come from `main`. If the environment allows only another branch, every scheduled run is rejected. |
| Required reviewers | should be off | With a reviewer, every daily run waits for a manual approval, and if it isn't given, no backup is taken. |

## The encryption key

Every backup is encrypted with the `BACKUP_ENCRYPTION_PASSPHRASE` secret of the `o4-backup` environment, and nothing else. The key step is given only that secret, not the database URL, so it cannot derive a different key. Validation in the same run decrypts with the same key file before anything is uploaded.

GitHub cannot show a secret's value back. **The passphrase must also be kept outside GitHub** (a password manager, plus an offline copy). Without that copy, a backup can only be decrypted inside a workflow run, and if the secret is ever deleted or overwritten, the backups encrypted with it are lost.

Each manifest records `key_source=passphrase-secret` and `key_fingerprint=<16 hex>`. The fingerprint is the first 16 hex characters of `SHA-256("vents-db-backup-key-check-v1:" + passphrase)`. It identifies the key without revealing it, so you can check that your copy matches before you need it.

### Setting it up (owner, once)

1. On your own machine, generate the passphrase: `openssl rand -base64 32` (44 characters). Save it in your password manager first, then make an offline copy.
2. Repository → Settings → Environments → `o4-backup` → Environment secrets → Add secret. Name: `BACKUP_ENCRYPTION_PASSPHRASE`; value: the passphrase, with no spaces or newline. Use the environment, not a repository secret.
3. To check it without revealing it, run a backup (Actions → Database backup → Run workflow). Its manifest must show `key_source=passphrase-secret`. Then compare `key_fingerprint` with your copy:
   ```sh
   umask 077; printf '%s' 'PASTE-PASSPHRASE' > key.txt   # or paste it from your password manager into the file, no trailing newline
   bash scripts/ops/db-backup-key-fingerprint.sh key.txt
   ```
   The two values must match. If they don't, the secret and your copy differ: fix that before you rely on any backup. (`printf` in an interactive shell may record the passphrase in your shell history. Prefix the command with a space if your shell ignores those, or write the file from your password manager.)

Never rotate the passphrase without keeping the old one: older artifacts stay encrypted with it until they expire (30 days).

### Older artifacts (key derived from the database URL)

Runs from before this rule have `key_source=derived-from-DATABASE_URL` and no `key_fingerprint`. These include runs #20 (`vents-db-backup-20261110T121759Z`) and #22 (`vents-db-backup-20261111T001450Z`). Their key is `HMAC-SHA256(key="vents-db-backup-v1", message=<the raw secret value>)` in hex. Two catches:

- **Which secret.** Runs #20 and #22 ran on branch `claude/o4-cloud-rehearsal`. That branch's workflow used `O4_DATABASE_URL` if it existed, else `DATABASE_URL`. The log masks which one. If `O4_DATABASE_URL` is listed under the `o4-backup` environment's or the repository's secrets, its value was the message; otherwise `DATABASE_URL`'s.
- **Byte for byte.** The key step hashed the secret exactly as stored, including any trailing newline or spaces. (The dump step strips whitespace before connecting, so a backup could succeed with a stray newline in the secret.)

So these artifacts can be decrypted only by someone holding that exact secret value, or inside a workflow run that still has it. After a database password change, nobody can decrypt them. They expire on 2026-12-10 and 2026-12-11. To rebuild the key on your own machine:
```sh
umask 077; BACKUP_DB_URL='EXACT-SECRET-VALUE' bash scripts/ops/db-backup-key.sh --legacy-derived key.txt key-mode.txt
```
`--legacy-derived` refuses to run on a GitHub runner, so no backup can be encrypted this way.

## Taking a fresh backup and checking it yourself

1. Start a run: Actions → Database backup → Run workflow, on a branch the `o4-backup` environment allows. Scheduled runs come from `main`, so the environment must allow `main`. To get the passphrase-only workflow, run it from `main` once this change is merged. An older branch's copy of the workflow also uses the passphrase when the secret exists, but it falls back to the URL-derived key if the secret is missing, and it records no fingerprint.
2. Wait for green, and read the run summary. You need `key_source=passphrase-secret`, `restore_tables=N/N`, `restore_rows=N/N`, `sha256=...` and `key_fingerprint=...`.
3. On your own machine, download the artifact (the run page → Artifacts), unzip it into an empty folder, and run:
   ```sh
   bash scripts/ops/db-backup-decrypt.sh <unzipped-folder> key.txt backup.dump
   ```
   It checks the file against the `.sha256` file and the manifest's `sha256`, refuses a key whose fingerprint differs from the manifest's, and only then decrypts. The plaintext is written with mode 600. Also compare the `sha256` printed in the run log's Manifest step with the one in the downloaded manifest: they come from separate places (the run log, and the artifact).
4. Restore drill: `bash scripts/ops/verify-backup-restore.sh backup.dump`. It restores only into a throwaway **local** database and checks that every public table holds every row.
5. A real restore goes **into a new, empty database, never into production**: `pg_restore --no-owner --no-privileges -d <target> backup.dump`.
6. When you are done, delete `backup.dump` and `key.txt` (`shred -u` on Linux).

There is no restore workflow. Restoring is deliberately a manual step on your own machine or a new database.

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
