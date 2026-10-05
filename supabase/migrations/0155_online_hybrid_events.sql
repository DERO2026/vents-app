-- Online / hybrid events.
--
-- Online is a first-class location_type on events (not a fake address
-- string), per the explicit product decision: discovery, tickets, event
-- details, and organizer creation all need to genuinely know an event is
-- virtual, not infer it from a magic "Online" location string alone.
-- events.location/country stay NOT NULL as before -- CreateEventScreen.tsx
-- sets location = 'Online' as a clearly-labeled sentinel for online events
-- (never shown to users as a real address; the UI reads location_type, not
-- this string, to decide what to render) and still requires a country for
-- discovery purposes, per the product spec's own "can still have a
-- country/city... for discovery" allowance. No existing column is
-- repurposed or renamed, and no existing in-person event's data changes --
-- this is additive only.
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS location_type text NOT NULL DEFAULT 'in_person'
    CHECK (location_type IN ('in_person', 'online', 'hybrid'));

-- Online access details (platform/URL/instructions) are deliberately NOT a
-- column on events: that table is publicly selectable (the whole public
-- event feed/search/sharing path reads it), so a private ticket-holder-only
-- link has no business living in a row anyone can select. This is its own
-- table with RLS enabled and ALL direct grants revoked from anon/
-- authenticated -- the only way in or out is the two SECURITY DEFINER RPCs
-- below, which do the actual "is this caller the organizer, or a paid
-- active ticket holder" check server-side on every read (never trusting a
-- client-side flag, per the explicit requirement).
CREATE TABLE IF NOT EXISTS public.event_online_access (
  event_id     uuid PRIMARY KEY REFERENCES public.events(id) ON DELETE CASCADE,
  platform     text NOT NULL CHECK (platform IN ('discord', 'zoom', 'google_meet', 'youtube', 'other')),
  access_url   text NOT NULL,
  instructions text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES public.users(id)
);

ALTER TABLE public.event_online_access ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_online_access FROM anon, authenticated;

-- Server-side URL validation, reused by the write RPC below -- the
-- organizer's own authentication is not treated as making their submitted
-- URL trustworthy. https:// only; explicitly rejects javascript:/data:/
-- file:/vbscript: and any other non-https scheme (including a bare
-- scheme-less string, which this regex also rejects -- "arbitrary text"
-- is never silently promoted to a clickable URL).
CREATE OR REPLACE FUNCTION public.is_safe_https_url(p_url text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT p_url IS NOT NULL
     AND p_url ~* '^https://[^\s]+\.[^\s]+'
     AND p_url !~* '^\s*(javascript|data|file|vbscript):';
$function$;

-- Organizer (or admin) sets/updates the private access details for their
-- own online/hybrid event. Re-validates ownership and location_type
-- server-side on every call -- never assumes the client only shows this
-- form to the right person.
CREATE OR REPLACE FUNCTION public.organizer_set_event_online_access(
  p_event_id uuid,
  p_platform text,
  p_access_url text,
  p_instructions text DEFAULT NULL
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_organizer_id uuid;
  v_location_type text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT organizer_id, location_type INTO v_organizer_id, v_location_type
  FROM public.events WHERE id = p_event_id;

  IF v_organizer_id IS NULL THEN
    RAISE EXCEPTION 'Event not found';
  END IF;
  IF v_organizer_id IS DISTINCT FROM auth.uid() AND NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Only the organizer can set online access details for this event';
  END IF;
  IF v_location_type = 'in_person' THEN
    RAISE EXCEPTION 'This event is not online or hybrid -- set the event location type first';
  END IF;
  IF p_platform NOT IN ('discord', 'zoom', 'google_meet', 'youtube', 'other') THEN
    RAISE EXCEPTION 'Invalid access platform';
  END IF;
  IF NOT public.is_safe_https_url(p_access_url) THEN
    RAISE EXCEPTION 'Access URL must be a valid https:// link';
  END IF;

  INSERT INTO public.event_online_access (event_id, platform, access_url, instructions, updated_at, updated_by)
  VALUES (p_event_id, p_platform, trim(p_access_url), NULLIF(trim(p_instructions), ''), now(), auth.uid())
  ON CONFLICT (event_id) DO UPDATE
    SET platform     = EXCLUDED.platform,
        access_url   = EXCLUDED.access_url,
        instructions = EXCLUDED.instructions,
        updated_at   = now(),
        updated_by   = auth.uid();
END;
$function$;

-- Retrieval: the organizer, or a caller holding a PAID, ACTIVE ticket for
-- this exact event -- re-checked here on every call against the real
-- tickets row, never a client-supplied "I'm authorized" flag. An unpaid,
-- pending, or cancelled ticket does not satisfy this and gets the same
-- "not authorized" exception as a caller with no ticket at all. Returns a
-- has_access_info flag distinct from "not authorized" so the client can
-- tell "you're allowed to see this, but the organizer hasn't added a link
-- yet" apart from "you're not allowed to see this at all" -- the UI needs
-- that distinction to show the right message without ever leaking which
-- case it actually was through an error string.
CREATE OR REPLACE FUNCTION public.get_event_online_access(p_event_id uuid)
 RETURNS TABLE(platform text, access_url text, instructions text, has_access_info boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_organizer_id uuid;
  v_authorized boolean := false;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT organizer_id INTO v_organizer_id FROM public.events WHERE id = p_event_id;
  IF v_organizer_id IS NULL THEN
    RAISE EXCEPTION 'Event not found';
  END IF;

  IF v_organizer_id = auth.uid() OR public.is_admin_or_root() THEN
    v_authorized := true;
  ELSIF EXISTS (
    SELECT 1 FROM public.tickets t
    WHERE t.event_id = p_event_id
      AND t.user_id = auth.uid()
      AND t.payment_status = 'paid'
      AND t.status = 'active'
  ) THEN
    v_authorized := true;
  END IF;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'Not authorized for this event''s online access details';
  END IF;

  RETURN QUERY
  SELECT a.platform, a.access_url, a.instructions, true
  FROM public.event_online_access a
  WHERE a.event_id = p_event_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::text, NULL::text, NULL::text, false;
  END IF;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.organizer_set_event_online_access(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_event_online_access(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.organizer_set_event_online_access(uuid, text, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_event_online_access(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_safe_https_url(text) FROM anon, authenticated;
