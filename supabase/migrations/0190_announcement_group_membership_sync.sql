-- Broadcast Center, Phase 2: automatic announcement-group membership sync.
--
-- Scope: this migration adds exactly one new trigger function and one new
-- trigger on public.users. It does NOT modify migration 0189's tables/RLS/
-- grants, does NOT modify protect_capability_columns() or its existing
-- trigger (trg_protect_capability_columns, BEFORE UPDATE -- confirmed live
-- via pg_get_triggerdef: it still fires first and still blocks any direct
-- `authenticated`-role write to is_organizer/is_service_provider), and does
-- NOT touch admin_send_broadcast()/admin_broadcast() or migration 0188.
--
-- Why a NEW, separate AFTER trigger rather than extending
-- protect_capability_columns() itself: that function's one job is to BLOCK
-- a disallowed write (BEFORE UPDATE, RAISE EXCEPTION, no side effects).
-- Mixing a side-effecting sync into a guard function makes the guard's
-- behavior harder to reason about and risks a future edit to one
-- accidentally changing the other. A second, independent AFTER UPDATE
-- trigger keeps them orthogonal: the BEFORE trigger still decides whether
-- the write is allowed at all; this AFTER trigger only runs once that
-- write has already been committed to the row, and only reacts to it.
--
-- Why AFTER, not BEFORE: membership must reflect the row's new, COMMITTED
-- is_organizer/is_service_provider values. An AFTER UPDATE trigger sees
-- the final NEW row for this statement and cannot itself be the reason the
-- original UPDATE fails (it can still raise and roll back the whole
-- transaction, which is a feature, not a risk here -- see security notes
-- below).
--
-- Privilege model: public.announcement_group_members (0189) grants NO
-- INSERT/UPDATE/DELETE to `authenticated` or `anon` -- only to
-- project_admin and whatever runs as a SECURITY DEFINER function's owner.
-- This trigger function is SECURITY DEFINER with an empty search_path
-- (matching every privileged function in this schema) specifically so it
-- can write to announcement_group_members regardless of which role's
-- statement caused the users row to change -- the client role itself is
-- NEVER granted direct write access to announcement_group_members, now or
-- after this migration. Every write to that table still happens only
-- inside this one SECURITY DEFINER function body.
--
-- Idempotency: every INSERT uses ON CONFLICT (group_id, user_id) DO
-- NOTHING against 0189's own unique constraint -- re-firing this trigger
-- for a user already in a group is a safe no-op, not a duplicate row or
-- an error. Every DELETE targets a row by its own (group_id, user_id)
-- pair and is naturally idempotent -- deleting an already-absent
-- membership row removes zero rows, no error.
--
-- Missing-group safety: both the INSERT ... SELECT ... FROM
-- announcement_groups WHERE key = '...' and the DELETE's matching
-- subquery resolve to zero matching rows if that group row doesn't exist
-- (e.g. a hypothetical future environment where 0189's seed hasn't run) --
-- this is a plain, safe no-op in standard SQL, not a special case this
-- function has to detect or branch on. No RAISE, no error, membership
-- sync for that flag is simply skipped for that call.
--
-- Both flags changing in the same UPDATE: this is one AFTER UPDATE ... FOR
-- EACH ROW trigger whose body independently evaluates
-- OLD.is_organizer IS DISTINCT FROM NEW.is_organizer and
-- OLD.is_service_provider IS DISTINCT FROM NEW.is_service_provider in the
-- same invocation -- a single UPDATE that flips both columns at once
-- performs both the organizers-group and service_providers-group sync in
-- the same trigger firing, each independently correct.
--
-- Security notes:
--   1. SECURITY DEFINER + `SET search_path TO ''` + fully schema-qualified
--      identifiers throughout -- the same hardening every privileged
--      function in this schema already uses, closing the classic
--      search_path-hijack vector for SECURITY DEFINER functions.
--   2. This function performs ONLY reads of public.announcement_groups
--      and writes to public.announcement_group_members. It does not read
--      or write any other table, and does not call any other function.
--   3. It cannot be invoked directly by a client as an RPC -- it is a
--      trigger function (RETURNS trigger), callable only by the trigger
--      mechanism itself, and is additionally not granted EXECUTE to
--      `authenticated`/`anon`/`project_admin` at all (triggers do not need
--      a role EXECUTE grant to fire; explicitly revoking it here only
--      forecloses a hypothetical future, mistaken attempt to call it as
--      an RPC).
--   4. A user still cannot self-assign or self-remove announcement-group
--      membership: the only way to reach this trigger is to change
--      is_organizer/is_service_provider on their own users row, and
--      protect_capability_columns() (unchanged, still BEFORE this
--      trigger in firing order since BEFORE triggers always run before
--      AFTER triggers for the same event) still blocks that for the
--      `authenticated` role. Only admin_set_organizer_capability(),
--      admin_set_service_provider_capability(), and
--      promote_to_organizer() -- all pre-existing, already-authorized
--      SECURITY DEFINER functions -- can actually flip these columns, and
--      each one's own authorization check is completely unchanged by this
--      migration.

CREATE OR REPLACE FUNCTION public.sync_announcement_group_membership()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF OLD.is_organizer IS DISTINCT FROM NEW.is_organizer THEN
    IF NEW.is_organizer THEN
      INSERT INTO public.announcement_group_members (group_id, user_id)
      SELECT g.id, NEW.id
      FROM public.announcement_groups g
      WHERE g.key = 'organizers'
      ON CONFLICT (group_id, user_id) DO NOTHING;
    ELSE
      DELETE FROM public.announcement_group_members
      WHERE user_id = NEW.id
        AND group_id IN (SELECT id FROM public.announcement_groups WHERE key = 'organizers');
    END IF;
  END IF;

  IF OLD.is_service_provider IS DISTINCT FROM NEW.is_service_provider THEN
    IF NEW.is_service_provider THEN
      INSERT INTO public.announcement_group_members (group_id, user_id)
      SELECT g.id, NEW.id
      FROM public.announcement_groups g
      WHERE g.key = 'service_providers'
      ON CONFLICT (group_id, user_id) DO NOTHING;
    ELSE
      DELETE FROM public.announcement_group_members
      WHERE user_id = NEW.id
        AND group_id IN (SELECT id FROM public.announcement_groups WHERE key = 'service_providers');
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_announcement_group_membership() FROM PUBLIC, anon, authenticated, project_admin;

CREATE TRIGGER trg_sync_announcement_group_membership
  AFTER UPDATE OF is_organizer, is_service_provider ON public.users
  FOR EACH ROW
  WHEN (OLD.is_organizer IS DISTINCT FROM NEW.is_organizer OR OLD.is_service_provider IS DISTINCT FROM NEW.is_service_provider)
  EXECUTE FUNCTION public.sync_announcement_group_membership();
