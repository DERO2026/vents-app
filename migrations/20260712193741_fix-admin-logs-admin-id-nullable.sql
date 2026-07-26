-- Fix schema inconsistency: admin_logs.admin_id has FK ... REFERENCES users(id)
-- ON DELETE SET NULL, but the column was declared NOT NULL. Any hard DELETE of a
-- users row that ever performed a logged admin action would fail with
-- "null value in column admin_id ... violates not-null constraint" because the
-- FK's SET NULL action conflicts with the column's own NOT NULL constraint.
--
-- admin_logs is an append-only historical audit trail, so the correct fix is to
-- let the audit row survive its actor's account being fully deleted: relax the
-- NOT NULL constraint to match the FK's existing ON DELETE SET NULL intent.
ALTER TABLE public.admin_logs
  ALTER COLUMN admin_id DROP NOT NULL;
