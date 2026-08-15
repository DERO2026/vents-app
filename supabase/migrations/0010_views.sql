-- Views. public_profiles depends on get_public_profiles() (0004 must run
-- first). pg_stat_statements/_info system views from the raw export are
-- deliberately excluded — Postgres/extension-owned, not app schema.

-- View: public_profiles
CREATE OR REPLACE VIEW public_profiles AS  SELECT get_public_profiles.id,
    get_public_profiles.full_name,
    get_public_profiles.username,
    get_public_profiles.avatar_url,
    get_public_profiles.cover_url,
    get_public_profiles.is_verified,
    get_public_profiles.state,
    get_public_profiles.role,
    get_public_profiles.interests,
    get_public_profiles.bio,
    get_public_profiles.vc_badge,
    get_public_profiles.last_active_at
   FROM get_public_profiles() get_public_profiles(id, full_name, username, avatar_url, cover_url, is_verified, state, role, interests, bio, vc_badge, last_active_at);

