-- ── Surface scanner identity on the Guest List, not just the activity feed ───
-- get_event_attendees already returned checked_in/checked_in_at/gate_name, but
-- not WHO scanned a given attendee in -- the production check-in spec asks for
-- "scan time and scanner information" directly on the searchable/filterable
-- attendee list, not just in the separate live-activity feed. Join the ledger's
-- scanned_by through to a name + device id.

DROP FUNCTION IF EXISTS public.get_event_attendees(uuid, text, text, int, int);

CREATE FUNCTION public.get_event_attendees(
  p_event_id uuid,
  p_search   text DEFAULT NULL,
  p_filter   text DEFAULT 'all',
  p_limit    int  DEFAULT 50,
  p_offset   int  DEFAULT 0
)
 RETURNS TABLE(
  ticket_id uuid, holder_name text, holder_email text, buyer_phone text,
  ticket_type text, status text, payment_status text, amount numeric,
  checked_in boolean, checked_in_at timestamptz, is_manual_override boolean,
  gate_name text, purchased_at timestamptz, order_ref text,
  user_id uuid, buyer_name text, avatar_url text,
  scanner_name text, device_id text
 )
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_q text := NULLIF(trim(coalesce(p_search, '')), '');
BEGIN
  IF NOT public.is_event_door_manager(p_event_id) THEN
    RAISE EXCEPTION 'Not authorized for this event''s door';
  END IF;

  RETURN QUERY
  SELECT t.id, t.holder_name, t.holder_email, u.phone_number,
         t.ticket_type, t.status, t.payment_status, t.amount,
         t.checked_in, t.checked_in_at, COALESCE(ci.is_manual_override, false),
         ci.gate_name, t.created_at, t.payment_ref,
         t.user_id, u.full_name, u.avatar_url,
         su.full_name, ci.device_id
  FROM public.tickets t
  LEFT JOIN public.checkins ci ON ci.ticket_id = t.id
  LEFT JOIN public.users u     ON u.id = t.user_id
  LEFT JOIN public.users su    ON su.id = ci.scanned_by
  WHERE t.event_id = p_event_id
    AND (
      p_filter = 'all'
      OR (p_filter = 'checked_in' AND t.checked_in)
      OR (p_filter = 'pending'    AND t.status = 'active' AND NOT t.checked_in)
      OR (p_filter = 'vip'        AND t.ticket_type ILIKE '%vip%')
      OR (p_filter = 'regular'    AND t.ticket_type NOT ILIKE '%vip%')
      OR (p_filter = 'refunded'   AND t.status = 'refunded')
      OR (p_filter = 'cancelled'  AND t.status = 'cancelled')
    )
    AND (
      v_q IS NULL
      OR t.holder_name  ILIKE '%' || v_q || '%'
      OR t.holder_email ILIKE '%' || v_q || '%'
      OR u.phone_number ILIKE '%' || v_q || '%'
      OR u.full_name    ILIKE '%' || v_q || '%'
      OR t.id::text = v_q
    )
  ORDER BY t.checked_in_at DESC NULLS LAST, t.created_at DESC
  LIMIT GREATEST(1, LEAST(p_limit, 200))
  OFFSET GREATEST(0, p_offset);
END;
$function$;
GRANT EXECUTE ON FUNCTION public.get_event_attendees(uuid, text, text, int, int) TO authenticated;
