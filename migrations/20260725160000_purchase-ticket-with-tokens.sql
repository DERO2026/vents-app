-- ── Purchase + signed pass tokens in ONE server-side call ────────────────────
-- The QR "Generating secure pass…" flash came from minting the signed token
-- LAZILY on the client after navigation (a second network round-trip that could
-- be slow, race a re-render, or fail offline). This wraps purchase_ticket so the
-- signed v2 token for every created ticket is generated server-side in the SAME
-- transaction and returned with the purchase — the client caches them before it
-- ever shows the success screen, so the QR is always available immediately.
--
-- Idempotent by virtue of purchase_ticket itself (same p_payment_ref returns the
-- same ticket ids), so a client retry after a flaky response never double-sells;
-- it just re-returns the tokens.

CREATE OR REPLACE FUNCTION public.purchase_ticket_with_tokens(
  p_event_id uuid,
  p_ticket_type text,
  p_attendees jsonb,
  p_payment_ref text,
  p_promo_code text DEFAULT NULL
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO ''
AS $fn$
DECLARE
  v_ids uuid[];
  v_id uuid;
  v_result jsonb := '[]'::jsonb;
BEGIN
  -- Reuse the audited, idempotent purchase path exactly as-is.
  v_ids := public.purchase_ticket(p_event_id, p_ticket_type, p_attendees, p_payment_ref, p_promo_code);

  IF v_ids IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  -- Sign each freshly-created ticket in the same transaction (the rows are
  -- already visible here), returning {ticket_id, token} pairs.
  FOREACH v_id IN ARRAY v_ids LOOP
    v_result := v_result || jsonb_build_object(
      'ticket_id', v_id,
      'token', public.generate_ticket_token(v_id)
    );
  END LOOP;

  RETURN v_result;
END;
$fn$;

ALTER FUNCTION public.purchase_ticket_with_tokens(uuid, text, jsonb, text, text) SET search_path = '';
GRANT EXECUTE ON FUNCTION public.purchase_ticket_with_tokens(uuid, text, jsonb, text, text) TO authenticated;
