-- Verbatim copies (from supabase/migrations/0004_functions.sql, their latest
-- definition) of production functions the local stack does not otherwise load,
-- used by run-event-cancellation-verification.sh: the organizer delete path
-- and the Paystack refund helpers the refund API and webhook call.

CREATE OR REPLACE FUNCTION public.soft_delete_event(p_event_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_owner   uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT organizer_id INTO v_owner FROM public.events WHERE id = p_event_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Event not found';
  END IF;
  IF v_owner <> v_user_id AND NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'You do not have permission to delete this event';
  END IF;

  UPDATE public.events
     SET deleted_at = now(),
         deleted_by = v_user_id,
         reason = p_reason,
         status = 'draft'
   WHERE id = p_event_id;

  INSERT INTO public.admin_logs (admin_id, action, details, actor_role)
  VALUES (v_user_id, 'delete_event',
          jsonb_build_object('event_id', p_event_id, 'reason', p_reason),
          public.actor_role());
END;
$function$;

CREATE OR REPLACE FUNCTION public.attach_ticket_refund_id(p_ticket_id uuid, p_refund_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_organizer_id uuid;
  v_status       text;
  v_user_id      uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT e.organizer_id, t.payment_status, t.user_id INTO v_organizer_id, v_status, v_user_id
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.id = p_ticket_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;

  IF v_organizer_id IS DISTINCT FROM auth.uid()
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF v_status <> 'refund_pending' THEN
    RAISE EXCEPTION 'Ticket is not awaiting a refund (status: %)', v_status;
  END IF;

  UPDATE public.tickets SET refund_id = p_refund_id WHERE id = p_ticket_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'attach_ticket_refund_id', v_user_id,
          jsonb_build_object('ticket_id', p_ticket_id, 'refund_id', p_refund_id), public.actor_role());
END;
$function$;

CREATE OR REPLACE FUNCTION public.fail_ticket_refund(p_refund_id text, p_reason text)
 RETURNS TABLE(status text, actor_email text, actor_name text, event_title text, ticket_type text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ticket record;
BEGIN
  SELECT t.id, t.user_id, t.ticket_type, t.payment_status, t.refund_initiated_by, e.title AS event_title
    INTO v_ticket
    FROM public.tickets t
    JOIN public.events e ON e.id = t.event_id
   WHERE t.refund_id = p_refund_id
   FOR UPDATE OF t;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  IF v_ticket.payment_status <> 'refund_pending' THEN
    RETURN QUERY SELECT 'not_pending'::text, NULL::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  UPDATE public.tickets
     SET payment_status = 'paid', status = 'active', refund_id = NULL
   WHERE id = v_ticket.id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    v_ticket.refund_initiated_by, 'refund_ticket_failed', v_ticket.user_id,
    jsonb_build_object('ticket_id', v_ticket.id, 'refund_id', p_refund_id, 'reason', p_reason),
    'webhook'
  );

  RETURN QUERY
  SELECT 'reverted'::text, u.email, u.full_name, v_ticket.event_title, v_ticket.ticket_type
    FROM public.users u WHERE u.id = v_ticket.refund_initiated_by;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_revert_stuck_refund(p_ticket_id uuid, p_reason text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ticket record;
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required';
  END IF;

  SELECT id, user_id, payment_status INTO v_ticket
    FROM public.tickets
   WHERE id = p_ticket_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;

  IF v_ticket.payment_status <> 'refund_pending' THEN
    RAISE EXCEPTION 'Only tickets awaiting refund can be reverted (current status: %)', v_ticket.payment_status;
  END IF;

  UPDATE public.tickets
     SET payment_status = 'paid', status = 'active', refund_id = NULL
   WHERE id = p_ticket_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(), 'admin_revert_stuck_refund', v_ticket.user_id,
    jsonb_build_object('ticket_id', p_ticket_id, 'reason', p_reason),
    public.actor_role()
  );

  RETURN 'reverted';
END;
$function$;
