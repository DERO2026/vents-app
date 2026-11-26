# Release safeguards

The checks that protect `main` and production, and who turns each one on.

## 1. Pull-request checks (H5)

`.github/workflows/pr-checks.yml` runs on every pull request into `main` and on every push to `main`. It runs:

- `npm ci`
- `npm run typecheck` (`tsc --noEmit`)
- `npm test` (vitest with the main config, then the preview-build config)

It uses no secrets and has read-only permissions. `src/lib/prChecksWorkflow.test.ts` fails if the workflow is weakened: steps removed, `continue-on-error`, `|| true`, skips, secrets, or unpinned actions.

### Making it binding (owner, one time, GitHub settings)

A workflow only reports a result. To stop a red PR from merging, branch protection must require it:

1. Open the repository → **Settings → Branches** (or **Rules → Rulesets**).
2. Add a rule for `main`.
3. Turn on **Require a pull request before merging**.
4. Turn on **Require status checks to pass before merging**. Search for and add **`typecheck-and-test`**. It appears after the workflow has run once, for example on the PR that adds it.
5. Turn on **Require branches to be up to date before merging**.
6. Optional: **Do not allow bypassing the above settings**, so admins are held to it too.

Until step 4 is done, a PR with a failing check can still be merged by hand.

## 2. Database changes

- Migrations are never applied by CI or by Vercel. Each one is applied to production only with the owner's approval, in the order given in `docs/repair-tracker.md`.
- Each migration that patches existing functions carries a drift guard and refuses to apply if production differs from the repository. Each has an `undo_NNNN.sql` in `supabase/rollback/`, gated by `SET vents.rollback_confirm`.
- The local PostgreSQL suites in `scripts/local-pg-test/` are the evidence for each migration. A nightly CI run of them is part of B10.

## 3. Deployment

- Vercel deploys `main` to production automatically when a PR is merged. **Merging is the deployment decision.** That's why the PR check and the owner's review come first.
- A migration that the new frontend depends on must be applied before that frontend is merged. H4 (Coming Soon shipping before 0224) is what happens otherwise. Each PR description states its database dependency.
- Rollback: the previous production deployment stays available to instant-rollback in Vercel. Database rollback uses the matching `undo_NNNN.sql`.
