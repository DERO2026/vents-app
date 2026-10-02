-- VENTS Chats/Inbox identity fix.
--
-- Root cause (confirmed live): ExploreScreen.tsx's reachable "Chats" tab
-- (the actual chat list -- InboxScreen.tsx is unreferenced/unreachable
-- from any navigation call site) loads each conversation's partner profile
-- via:
--   supabase.from('public_profiles')
--     .select('id, full_name, username, avatar_url, vc_badge, role, is_organizer, last_active_at')
--     .in('id', partnerIds)
-- but the public_profiles view (backed by get_public_profiles()) never
-- exposed an is_organizer column -- confirmed by reading both the live view
-- definition and the function's RETURNS TABLE. Selecting a nonexistent
-- column makes PostgREST return a 400 error on every single call, with
-- data = null. The frontend destructures only `{ data: profiles }` and
-- never checks `error`, so this failure is silent: profiles is always
-- null/empty, the per-partner profile lookup always misses, and every
-- conversation row falls through to the generic 'User' name and 'U'
-- avatar initial -- exactly the reported symptom, and deterministic
-- (every call, every conversation), not intermittent. Reproduced live via
-- a rolled-back transaction impersonating a real authenticated user:
-- `ERROR: 42703: column "is_organizer" does not exist`.
--
-- HomeScreen.tsx and UserProfileScreen.tsx also select is_organizer from
-- public_profiles and hit the same error; fixing the column here fixes all
-- of them. The one defensive gap this exposed (the chats-tab query not
-- checking its own error, unlike InboxScreen.tsx's equivalent query) is
-- fixed separately in ExploreScreen.tsx.
--
-- is_organizer is already not sensitive data -- every screen listed above
-- already assumed it was available from this exact public, SECURITY
-- DEFINER-backed view (no RLS bypass, no new exposure). Adding it closes a
-- schema drift, not a new privacy surface.
--
-- DROP VIEW/DROP FUNCTION are intentionally NOT used here: this project's
-- Supabase DDL tooling reproducibly hung on DROP statements against this
-- database when this migration was being applied (confirmed clean on the
-- server side -- pg_stat_activity showed no blocking locks or long-running
-- transactions during or after each hang; CREATE/SELECT statements
-- returned immediately throughout), so the fix below avoids DROP entirely:
--
--   1. Rename the old get_public_profiles() out of the way (ALTER
--      FUNCTION ... RENAME TO, not a DROP).
--   2. CREATE the function fresh under the original name with the
--      original SELECT/WHERE logic unchanged plus the one new
--      is_organizer column.
--   3. CREATE OR REPLACE the view, which Postgres allows for a view as
--      long as the pre-existing output columns keep their name, order,
--      and type -- the new column must be appended at the end of the
--      SELECT list (mid-list insertion is rejected with "cannot change
--      name of view column"), which is what's done here.
--   4. Reapply the original SELECT grants to anon/authenticated (CREATE
--      OR REPLACE VIEW preserves existing grants automatically, but this
--      restates them for clarity/idempotency).
--
-- The renamed-away original function (get_public_profiles_old_v1) is
-- orphaned and unused by anything; it is left in place rather than forcing
-- a DROP, and can be cleaned up in a future migration once DROP DDL is
-- confirmed reliable again in this environment.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_public_profiles'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_public_profiles_old_v1'
  ) THEN
    ALTER FUNCTION public.get_public_profiles() RENAME TO get_public_profiles_old_v1;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.get_public_profiles()
 RETURNS TABLE(id uuid, full_name text, username text, avatar_url text, cover_url text, is_verified boolean, state text, role text, is_organizer boolean, interests text[], bio text, vc_badge text, last_active_at timestamp with time zone, instagram_handle text, x_handle text, tiktok_handle text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT
    id,
    full_name,
    username,
    avatar_url,
    cover_url,
    is_verified,
    state,
    CASE WHEN role = 'admin' THEN 'organizer' ELSE role END AS role,
    is_organizer,
    interests,
    bio,
    vc_badge,
    last_active_at,
    instagram_handle,
    x_handle,
    tiktok_handle
  FROM public.users
  WHERE deleted_at IS NULL;
$function$;

CREATE OR REPLACE VIEW public.public_profiles AS
 SELECT id,
    full_name,
    username,
    avatar_url,
    cover_url,
    is_verified,
    state,
    role,
    interests,
    bio,
    vc_badge,
    last_active_at,
    instagram_handle,
    x_handle,
    tiktok_handle,
    is_organizer
   FROM get_public_profiles() get_public_profiles(id, full_name, username, avatar_url, cover_url, is_verified, state, role, is_organizer, interests, bio, vc_badge, last_active_at, instagram_handle, x_handle, tiktok_handle);

GRANT SELECT ON public.public_profiles TO authenticated, anon;
