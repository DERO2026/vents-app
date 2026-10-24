-- Broadcast Center, Phase 3: audience-aware announcement RPC.
--
-- Builds on migrations 0188 (admin_send_broadcast authorization fix), 0189
-- (announcement_groups/announcement_group_members/announcement_mutes
-- schema), and 0190 (automatic membership sync) -- all three confirmed
-- live in production before writing this file. This migration does NOT
-- modify any of them, does not touch admin_send_broadcast()/
-- admin_broadcast(), and does not weaken any existing authorization check.
--
-- New: admin_send_announcement(p_audience text, p_title text, p_body text)
-- -- a second, audience-aware entry point alongside the existing Everyone-
-- only admin_send_broadcast(). It is intentionally a separate function,
-- not a rewrite of admin_send_broadcast(), so the existing Root-only
-- "Global Broadcast" action (AdminSystemScreen.tsx) and its already-
-- reviewed behavior are completely unaffected by this change.
--
-- Authorization: is_admin_or_root() -- the same Super-Admin-tier helper
-- 0188 put admin_send_broadcast() on, and the same one
-- admin_set_event_trending/admin_reject_organizer_payout/
-- admin_cancel_processing_payout already use. Not the broader is_admin()
-- -- this keeps Sub-Admins excluded, consistent with every other
-- mutation-shaped admin RPC in this schema (as opposed to the read/
-- catalog-visibility tables from 0189, which deliberately use is_admin()).
--
-- Audience allow-list: p_audience must be exactly 'everyone', 'organizers',
-- or 'service_providers' -- checked with a plain CASE over string
-- literals, never interpolated into SQL text. No dynamic SQL anywhere in
-- this function: every branch below is a static, fixed INSERT ... SELECT
-- statement; the only thing that varies by audience is which static
-- branch executes.
--
-- Input validation: title/body trimmed, required, and length-capped,
-- mirroring send_event_announcement's own validation
-- (0041_event_announcements.sql) -- the only other user-facing
-- announcement-composing RPC in this schema, so the two now validate
-- identically rather than drifting.
--
-- Recipient targeting:
--   'everyone'            -- the EXACT same population admin_send_broadcast()
--                            already targets (public.users WHERE role <> 'admin'),
--                            so existing Everyone-broadcast behavior/expectations
--                            are preserved, not re-defined here.
--   'organizers'           -- public.announcement_group_members joined to
--   'service_providers'      the matching public.announcement_groups row by
--                            key, per requirement #4: role-specific audiences
--                            are targeted THROUGH the membership table (which
--                            0190 already keeps in sync with
--                            users.is_organizer/is_service_provider), not by
--                            re-querying those boolean columns directly.
--
-- Mute handling -- the one subtlety this migration must get exactly right:
-- announcement_mutes (0189) is keyed by (user_id, group_id), and group_id
-- is a NOT NULL foreign key into announcement_groups -- a table whose own
-- CHECK constraint (announcement_groups_key_check) only ever allows the
-- keys 'organizers'/'service_providers'. There both IS and CAN BE no
-- announcement_groups row for 'everyone', and therefore no
-- announcement_mutes row can ever reference one either. Consequently:
--   - For 'organizers'/'service_providers', recipients are anti-joined
--     against announcement_mutes for THAT SPECIFIC group's id -- a user
--     muted for 'organizers' is excluded from an organizers send, and
--     muting one group never touches the other (each branch's anti-join
--     is scoped to its own single group_id).
--   - For 'everyone', NO announcement_mutes lookup is performed at all --
--     not because muting is accidentally skipped, but because there is
--     structurally nothing to look up: 'everyone' is deliberately not a
--     row in announcement_groups (0189's own header comment: "Everyone
--     remains notification-only"), so it is impossible for any
--     announcement_mutes row to apply to it, and this function does not
--     pretend otherwise by inventing a lookup against a group that cannot
--     exist. Everyone-sends are unaffected by ANY existing mute row,
--     including a user's own organizers/service_providers mutes -- this
--     is the explicit, tested behavior requirement #5 asks for, not an
--     oversight: today, Everyone has no mute control of its own at all.
--
-- Notification shape: same column set as admin_send_broadcast() -- id,
-- user_id, type, title, body, read (false), icon ('📢'), created_at.
-- 'everyone' uses type = 'broadcast', byte-identical to
-- admin_send_broadcast()'s own INSERT; role audiences use type =
-- 'announcement' instead -- see the dedicated "Notification type"
-- section below for why. Every branch shares the exact same
-- notification feed rendering and push-eligibility path either way
-- (0041's own comment: push is a type-agnostic polling cron, no new
-- plumbing needed).
--
-- Audit logging: one admin_logs row per call, action 'announcement_sent',
-- details including audience/title/body/recipients -- mirroring
-- admin_send_broadcast()'s own 'broadcast_sent' log shape, with the added
-- audience field this RPC's whole purpose requires recording.
--
-- Return shape: jsonb_build_object('success', true, 'recipients', v_count)
-- -- byte-identical shape to admin_send_broadcast()'s return, so existing
-- or future callers can handle either RPC's result the same way.
--
-- Grants: REVOKE ALL FROM PUBLIC, anon, authenticated first (closing the
-- platform's own default EXECUTE grant to PUBLIC on new functions), then
-- GRANT EXECUTE TO authenticated, project_admin only -- confirmed live to
-- be the exact grant shape admin_send_broadcast()/admin_broadcast()/
-- admin_set_event_trending already use (is_admin_or_root() inside the
-- function body is the real gate, not the grant -- same stated rationale
-- 0182_admin_manual_trending_control.sql already gives for that pattern).
-- anon never receives EXECUTE.
--
-- Rate limiting: PERFORM public.check_rate_limit(...) -- the same existing
-- primitive send_event_announcement() already uses
-- (0041_event_announcements.sql:67, confirmed live via pg_get_functiondef:
-- check_rate_limit(p_key text, p_max_attempts integer, p_window_seconds
-- integer)), called once per admin caller (keyed on v_admin_id, not on
-- audience or content) immediately after authorization/validation and
-- before any INSERT. admin_send_broadcast() itself has no rate limit at
-- all -- this migration does not add one there, only to the new RPC.
-- Limit chosen: 10 calls per 300-second window per admin. This is
-- deliberately generous relative to send_event_announcement's 1-per-900s
-- (that limit exists to stop one organizer spamming one event's
-- attendees; this one exists only to stop a runaway client/script loop
-- calling this RPC repeatedly) -- a Super Admin composing and sending to
-- all three audiences in quick succession, or correcting a typo and
-- re-sending, stays well under 10 calls in 5 minutes. Exceeding it raises
-- 'rate_limited' (ERRCODE P0429, check_rate_limit's own existing
-- behavior) rather than silently dropping or queuing the call.
--
-- Notification type: 'everyone' keeps type = 'broadcast', byte-identical
-- to admin_send_broadcast()'s own INSERT -- zero behavior change for the
-- existing Everyone path, including NotificationsScreen.tsx's
-- TYPE_COLORS['broadcast'] color mapping and the type-agnostic push-
-- delivery cron (get_pending_push_notifications_for_user, confirmed live:
-- it claims any notifications row with push_sent = false, never filters
-- on type). Role-specific sends ('organizers'/'service_providers') use a
-- NEW, distinct type = 'announcement' instead of reusing 'broadcast' --
-- confirmed this is compatible, not a drift risk: NotificationsScreen.tsx
-- resolves an unmapped type via `TYPE_COLORS[notif.type] ?? ventsColors.
-- accent`, the same safe fallback 'reminder'/'event_update' already rely
-- on, so a new type renders correctly today without a UI change; and
-- push delivery is confirmed type-agnostic above, so it is unaffected
-- either way. Distinguishing the two matters because 'broadcast' already
-- means, everywhere else in this schema and UI, "sent to literally
-- everyone" -- silently reusing that label for an audience-scoped send
-- would misrepresent who actually received it (to the admin re-reading
-- their own admin_logs, and to any future per-type notification
-- preference). Both role branches share one 'announcement' type rather
-- than a per-audience type, since nothing today needs to tell an
-- organizer-announcement apart from a service-provider-announcement
-- after delivery -- audience is still fully recorded, per-send, in the
-- admin_logs 'audience' field.

CREATE OR REPLACE FUNCTION public.admin_send_announcement(p_audience text, p_title text, p_body text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_admin_id uuid := auth.uid();
  v_title    text := trim(COALESCE(p_title, ''));
  v_body     text := trim(COALESCE(p_body, ''));
  v_count    int;
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Only admins can send announcements';
  END IF;

  IF p_audience NOT IN ('everyone', 'organizers', 'service_providers') THEN
    RAISE EXCEPTION 'Invalid audience: %', p_audience;
  END IF;

  IF v_title = '' THEN RAISE EXCEPTION 'Title is required'; END IF;
  IF length(v_title) > 80 THEN RAISE EXCEPTION 'Title must be 80 characters or fewer'; END IF;
  IF v_body = '' THEN RAISE EXCEPTION 'Message is required'; END IF;
  IF length(v_body) > 500 THEN RAISE EXCEPTION 'Message must be 500 characters or fewer'; END IF;

  -- One admin, up to 10 sends per 5-minute window -- generous enough that
  -- a legitimate Super Admin sending to all three audiences, or
  -- correcting a typo and re-sending, is never blocked; tight enough to
  -- stop a runaway script loop.
  PERFORM public.check_rate_limit('admin_send_announcement:' || v_admin_id::text, 10, 300);

  CASE p_audience
    WHEN 'everyone' THEN
      -- Same population admin_send_broadcast() already targets, same
      -- type ('broadcast') so existing rendering/push behavior for
      -- Everyone sends is unchanged. No announcement_mutes lookup --
      -- deliberately: 'everyone' has no announcement_groups row (CHECK
      -- constraint forbids it), so no mute row can structurally
      -- reference it.
      INSERT INTO public.notifications (id, user_id, type, title, body, read, icon, created_at)
      SELECT gen_random_uuid(), u.id, 'broadcast', v_title, v_body, false, '📢', now()
      FROM public.users u
      WHERE u.role <> 'admin';

    WHEN 'organizers' THEN
      -- type = 'announcement' (not 'broadcast') -- audience-scoped, not
      -- "sent to literally everyone"; see this file's header comment.
      INSERT INTO public.notifications (id, user_id, type, title, body, read, icon, created_at)
      SELECT gen_random_uuid(), m.user_id, 'announcement', v_title, v_body, false, '📢', now()
      FROM public.announcement_group_members m
      JOIN public.announcement_groups g ON g.id = m.group_id AND g.key = 'organizers'
      WHERE NOT EXISTS (
        SELECT 1 FROM public.announcement_mutes mu
        WHERE mu.user_id = m.user_id AND mu.group_id = m.group_id
      );

    WHEN 'service_providers' THEN
      INSERT INTO public.notifications (id, user_id, type, title, body, read, icon, created_at)
      SELECT gen_random_uuid(), m.user_id, 'announcement', v_title, v_body, false, '📢', now()
      FROM public.announcement_group_members m
      JOIN public.announcement_groups g ON g.id = m.group_id AND g.key = 'service_providers'
      WHERE NOT EXISTS (
        SELECT 1 FROM public.announcement_mutes mu
        WHERE mu.user_id = m.user_id AND mu.group_id = m.group_id
      );
  END CASE;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  INSERT INTO public.admin_logs (id, admin_id, action, target_user_id, details, created_at)
  VALUES (
    gen_random_uuid(),
    v_admin_id,
    'announcement_sent',
    NULL,
    jsonb_build_object('audience', p_audience, 'title', v_title, 'body', v_body, 'recipients', v_count),
    now()
  );

  RETURN jsonb_build_object('success', true, 'recipients', v_count);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_send_announcement(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_send_announcement(text, text, text) TO authenticated, project_admin;
