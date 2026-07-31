-- Fix (2 of 4 payment-integrity blockers, 2026-07-31 QA pass): ticket
-- availability shown to buyers came straight from events.ticket_types'
-- static `quantity`, never decremented by sales — HomeScreen.tsx mapped
-- `available: t.quantity`, so a fully sold-out event still showed e.g.
-- "500 available" and TicketSelectScreen's soldOut check (`available === 0`)
-- was only ever true if the organizer had literally typed 0. Buyers could
-- pay through Paystack and only then hit purchase_ticket's real capacity
-- guard — by which point the money is already captured (see the
-- App.tsx handleCheckoutSuccess fix in this same batch for why that's a
-- 🔴, not a UX nit).
--
-- This mirrors purchase_ticket's own capacity check exactly (status =
-- 'active', regardless of payment_status — a pending/unpaid ticket still
-- holds inventory) so the number shown to a buyer always matches what the
-- server will actually enforce at purchase time. Called live by
-- TicketSelectScreen right before a buyer picks a quantity.
CREATE OR REPLACE FUNCTION public.get_event_ticket_type_availability(p_event_id uuid)
 RETURNS TABLE(ticket_type text, sold_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT t.ticket_type, count(*)::integer AS sold_count
  FROM public.tickets t
  WHERE t.event_id = p_event_id AND t.status = 'active'
  GROUP BY t.ticket_type;
$function$;

GRANT EXECUTE ON FUNCTION public.get_event_ticket_type_availability(uuid) TO anon, authenticated;
