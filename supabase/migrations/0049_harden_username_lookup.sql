-- Hardens resolve_username_to_email() -- part of the intermittent
-- "incorrect username and password" login-reliability audit. The RPC
-- itself was already the right architecture (a SECURITY DEFINER server-side
-- resolver, not a client-side query subject to RLS) -- but its comparison
-- had two reliability gaps:
--
-- 1. Case sensitivity: `WHERE username = lower(trim(p_username))` compares
--    the LOWERCASED INPUT against the RAW stored `username` column. Every
--    current signup path already lowercases before insert, so this works
--    for accounts created that way -- but any legacy/admin-created row
--    with a mixed-case stored username (e.g. "Jojo" instead of "jojo")
--    would NEVER match a lowercase login attempt, a hard, permanent
--    failure for that one account, not an intermittent one. Fixed by
--    comparing lower(trim(username)) on BOTH sides.
--
-- 2. Determinism under duplicates: `LIMIT 1` with no ORDER BY. The
--    users_username_key UNIQUE constraint (0005) is case-SENSITIVE by
--    default, so "jojo" and "Jojo" could both exist as distinct rows
--    without ever violating it (again, only reachable via a legacy/
--    non-app insert path, since every current signup path lowercases
--    first). If that ever happens for a given username, which specific
--    row Postgres returns for a plain `LIMIT 1` is not guaranteed stable
--    across executions (query-plan/physical-storage dependent) -- this
--    would resolve to a DIFFERENT email on different login attempts for
--    the exact same typed username, and (since a resolved-to-the-wrong-
--    account email fails Supabase's password check) reads to the user as
--    "sometimes my password works, sometimes it doesn't" with the exact
--    same credentials -- fully explaining an intermittent, username-
--    specific symptom. Fixed by ordering deterministically (oldest account
--    wins) so the same username always resolves to the same email on
--    every call, whether or not a duplicate exists.
--
-- This migration does NOT delete, merge, or alter any existing user row --
-- it only changes which row a lookup prefers when more than one matches.
-- If a real case-duplicate exists for an affected username (e.g. "jojo"),
-- the accounts still need manual review; run this first to check:
--   SELECT id, username, email, created_at FROM public.users
--   WHERE lower(trim(username)) = 'jojo' ORDER BY created_at;
-- If that returns more than one row, decide (outside this migration)
-- which account is authoritative before considering a username rename or
-- merge for the other.
-- The old query matched the UNIQUE (username) btree index (0005) directly;
-- comparing lower(trim(username)) is a function call the plain index can't
-- serve, which would otherwise turn every login's username lookup into a
-- sequential scan as the table grows -- itself a reliability risk (slower
-- lookups under load -> more timeouts -> more of the exact symptom this
-- migration fixes). This functional index keeps it an index lookup.
CREATE INDEX IF NOT EXISTS idx_users_username_lower_trim ON public.users (lower(trim(username)));

CREATE OR REPLACE FUNCTION public.resolve_username_to_email(p_username text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_email text;
BEGIN
  SELECT email INTO v_email
  FROM public.users
  WHERE lower(trim(username)) = lower(trim(p_username))
  ORDER BY created_at ASC
  LIMIT 1;
  RETURN v_email;
END;
$function$
;
