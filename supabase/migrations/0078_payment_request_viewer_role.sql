-- Adds viewer-role and payer-identity fields to get_payment_request_details.
--
-- Real gap this closes: PaymentRequestScreen.tsx renders exactly one view
-- for BOTH sides of a "Someone else is paying" request -- payer-oriented
-- copy ("<recipient_name> asked you to pay for this ticket") and an always-
-- visible Pay button, regardless of whether the actual viewer is the payer
-- or the person who SENT the request (pending_purchases.user_id -- the
-- eventual ticket holder). The requester, checking on their own pending
-- request, currently sees confusing payer-facing copy and a Pay button
-- that isn't meaningfully theirs (get_payment_request_details already
-- returns rows to both sides via its own WHERE clause; nothing downstream
-- has ever distinguished which one is looking).
--
-- Adds two things, non-breaking for any existing caller that only reads
-- the original columns:
--   - viewer_is_requester: auth.uid() = pp.user_id (the ticket-holder-to-be
--     who created the request), computed server-side so the client never
--     has to guess a role from data it can't independently verify.
--   - payer_name / payer_masked_phone: who the requester is waiting on --
--     nullable, since payer_id itself is nullable per 0058's own comment.
--   - created_at / expires_at: real timestamps already stored on
--     pending_purchases, for a genuine (not invented) "Request sent" /
--     "Expires in" display on the requester's own tracking view.
--
-- Does NOT add a "send reminder" action -- no notification-sending path
-- for payment request reminders exists anywhere in this schema, and
-- inventing one is out of scope for what this migration does (fixing an
-- existing detail RPC to tell the truth about who's asking).
--
-- Postgres refuses CREATE OR REPLACE when the new RETURNS TABLE column set
-- differs from the existing function's (42P13: "cannot change return type
-- of existing function ... Row type defined by OUT parameters is
-- different"), so the old signature must be dropped first.
DROP FUNCTION IF EXISTS public.get_payment_request_details(text);

CREATE OR REPLACE FUNCTION public.get_payment_request_details(p_payment_ref text)
 RETURNS TABLE(
   event_title text,
   event_image_url text,
   ticket_type text,
   attendee_count integer,
   amount_kobo bigint,
   recipient_name text,
   status text,
   is_expired boolean,
   viewer_is_requester boolean,
   payer_name text,
   payer_masked_phone text,
   created_at timestamptz,
   expires_at timestamptz
 )
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT
    e.title,
    e.image_url,
    pp.ticket_type,
    jsonb_array_length(pp.attendees),
    pp.amount_kobo,
    COALESCE(u.full_name, u.username),
    pp.status,
    (pp.status = 'pending' AND pp.expires_at IS NOT NULL AND pp.expires_at < now()),
    (pp.user_id = (SELECT auth.uid())),
    COALESCE(payer.full_name, payer.username),
    CASE
      WHEN payer.phone_number IS NULL OR length(payer.phone_number) < 4 THEN NULL
      ELSE left(payer.phone_number, length(payer.phone_number) - 4) || '••••' || right(payer.phone_number, 2)
    END,
    pp.created_at,
    pp.expires_at
  FROM public.pending_purchases pp
  JOIN public.events e ON e.id = pp.event_id
  JOIN public.users u ON u.id = pp.user_id
  LEFT JOIN public.users payer ON payer.id = pp.payer_id
  WHERE pp.payment_ref = p_payment_ref
    AND (pp.payer_id = (SELECT auth.uid()) OR pp.user_id = (SELECT auth.uid()));
$function$;

REVOKE ALL ON FUNCTION public.get_payment_request_details(text) FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.get_payment_request_details(text) TO authenticated, project_admin;
