-- CRITICAL finding from the final whole-app cross-system reconciliation
-- audit: public.activate_event_promotion(p_event_id, p_plan_type,
-- p_duration_days, p_payment_ref) -- the RPC that grants a paid Featured/
-- Trending/Boosted event-promotion placement -- performs NO payment
-- verification of its own. It only checks that p_payment_ref is non-empty
-- and that the caller owns the event; the real Paystack verification
-- happens entirely in api/promotions/activate.ts, which then forwards the
-- user's OWN session token through PostgREST to call this RPC. Because the
-- RPC was GRANTed EXECUTE to authenticated (required for that forwarding
-- call to work) with no other gate, any organizer could call it directly
-- from the browser with a fabricated, never-paid payment_ref and grant
-- their own event free Featured placement -- a complete revenue bypass of
-- a paid product feature. Live-verified: a direct call with
-- payment_ref='fabricated-free-ref-123' set is_featured=true and a 30-day
-- featured_until on a real event, no payment involved (rolled back, no
-- residue).
--
-- Fixed the same way every other payment-gated RPC in this codebase is
-- fixed: the function no longer reads auth.uid() (which only resolves
-- correctly when the caller's own JWT is forwarded -- the exact thing that
-- made the direct-call bypass possible); it now takes an explicit
-- p_organizer_id, and is locked down to project_admin only, matching
-- confirm_ticket_payment/confirm_wallet_deposit/credit_provider_wallet_for_
-- booking's lockdown pattern. The paired API route change (same commit)
-- switches from forwarding the client's token through PostgREST to calling
-- this RPC over the project_admin connection with the already-session-
-- verified user id, after Paystack verification -- so there is no longer
-- any path that reaches this function without going through that
-- verification first.
--
-- Live-verified after the fix (rolled back, no residue):
--   - the identical direct call now fails with "permission denied for
--     function activate_event_promotion"
--   - the legitimate project_admin-connection call still activates the
--     promotion correctly for the real owner
--   - a mismatched p_organizer_id still fails with "You do not own this event"
DROP FUNCTION IF EXISTS public.activate_event_promotion(uuid, text, integer, text);

CREATE OR REPLACE FUNCTION public.activate_event_promotion(p_event_id uuid, p_plan_type text, p_duration_days integer, p_payment_ref text, p_organizer_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_owner_id uuid;
  v_end_date timestamptz;
  v_inserted integer;
BEGIN
  IF p_organizer_id IS NULL THEN
    RAISE EXCEPTION 'organizer_id is required';
  END IF;
  IF p_plan_type NOT IN ('boosted', 'featured', 'trending') THEN
    RAISE EXCEPTION 'Invalid plan_type';
  END IF;
  IF p_duration_days NOT IN (3, 7, 14, 30) THEN
    RAISE EXCEPTION 'Invalid duration';
  END IF;
  IF p_payment_ref IS NULL OR trim(p_payment_ref) = '' THEN
    RAISE EXCEPTION 'payment_ref is required';
  END IF;

  SELECT organizer_id INTO v_owner_id FROM public.events WHERE id = p_event_id;
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'Event not found';
  END IF;
  IF v_owner_id <> p_organizer_id THEN
    RAISE EXCEPTION 'You do not own this event';
  END IF;

  v_end_date := now() + make_interval(days => p_duration_days);

  INSERT INTO public.event_promotions (event_id, organizer_id, plan_type, start_date, end_date, status, payment_ref)
  VALUES (p_event_id, p_organizer_id, p_plan_type, now(), v_end_date, 'active', p_payment_ref)
  ON CONFLICT (payment_ref) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN; -- replayed reference — already activated, no-op
  END IF;

  IF p_plan_type = 'featured' THEN
    UPDATE public.events SET is_featured = true, featured_until = v_end_date WHERE id = p_event_id;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.activate_event_promotion(uuid, text, integer, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_event_promotion(uuid, text, integer, text, uuid) TO project_admin;
