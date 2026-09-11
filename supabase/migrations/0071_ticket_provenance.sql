-- get_ticket_provenance: lets a ticket's own owner see, on the ticket/QR
-- screen, "Paid by X" (Someone Else Pays) and/or "Transferred to you from
-- X" (accepted Ticket Transfer) -- both currently invisible in the app
-- even though the underlying data (tickets.payer_id, ticket_transfers)
-- already exists. Deliberately does NOT touch ticket ownership: tickets.
-- user_id stays the sole source of truth for who holds/can check in a
-- ticket, this only surfaces two more names alongside it.
--
-- No public read policy exists for public.users beyond one's own row
-- (0008_rls_and_policies.sql) -- this SECURITY DEFINER function is the
-- narrow exception, and only for tickets the caller actually owns
-- (t.user_id = auth.uid()), returning nothing but a display name for the
-- payer/sender.
CREATE OR REPLACE FUNCTION public.get_ticket_provenance(p_ticket_ids uuid[])
 RETURNS TABLE(ticket_id uuid, paid_by_name text, transferred_from_name text)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT
    t.id,
    CASE WHEN t.payer_id IS NOT NULL THEN COALESCE(payer.full_name, payer.username) END,
    CASE WHEN xfer.from_user_id IS NOT NULL THEN COALESCE(sender.full_name, sender.username) END
  FROM public.tickets t
  LEFT JOIN public.users payer ON payer.id = t.payer_id
  LEFT JOIN LATERAL (
    SELECT from_user_id
      FROM public.ticket_transfers
     WHERE ticket_id = t.id AND status = 'accepted' AND to_user_id = t.user_id
     ORDER BY responded_at DESC NULLS LAST
     LIMIT 1
  ) xfer ON true
  LEFT JOIN public.users sender ON sender.id = xfer.from_user_id
  WHERE t.id = ANY(p_ticket_ids)
    AND t.user_id = (SELECT auth.uid());
$function$
;

REVOKE ALL ON FUNCTION public.get_ticket_provenance(uuid[]) FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.get_ticket_provenance(uuid[]) TO authenticated;
