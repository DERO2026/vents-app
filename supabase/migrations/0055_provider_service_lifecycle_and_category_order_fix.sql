-- Two fixes found during Preview testing of 0054:
--
-- 1. FK violation deleting/removing a provider_services row once ANY
--    booking references it (service_booking_items.service_id has no
--    ON DELETE clause -- RESTRICT by default, and stays that way here: the
--    FK is NOT removed/relaxed, per explicit instruction). Booking history
--    itself was never actually at risk -- service_booking_items already
--    snapshots service_name/unit_price_kobo/quantity/line_total_kobo at
--    booking time (0054's own header comment), so the live provider_services
--    row is not the source of truth for a past booking's display. The bug
--    was that "Delete" had no fallback: it always attempted a hard DELETE
--    and surfaced Postgres' raw FK error instead of archiving. Fixed with a
--    safe-delete RPC that hard-deletes only when nothing references the
--    service, and otherwise deactivates it (same as the existing
--    Activate/Deactivate toggle) so it disappears from public/booking
--    surfaces without breaking any existing booking's history or the FK.
--
-- 2. set_service_provider_categories used array_agg(DISTINCT trim(c)),
--    which has no defined output order for the DISTINCT case -- Postgres is
--    free to return the distinct values in ANY order (commonly value-sorted,
--    not selection order), so v_clean[1] (meant to be the provider's actual
--    first-picked / primary category) could silently become an arbitrary
--    one of the selected categories instead. All selected categories were
--    still correctly inserted into service_provider_categories (this was
--    never why a category "returned no providers"), but the primary column
--    (service_providers.category, still the one every legacy single-category
--    reader keys off) could end up wrong. Fixed to preserve first-occurrence
--    order using WITH ORDINALITY.

CREATE OR REPLACE FUNCTION public.delete_provider_service_safe(p_service_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_provider_id uuid;
BEGIN
  SELECT ps.provider_id INTO v_provider_id
  FROM public.provider_services ps
  JOIN public.service_providers sp ON sp.id = ps.provider_id
  WHERE ps.id = p_service_id AND sp.user_id = (SELECT auth.uid());

  IF v_provider_id IS NULL THEN
    RAISE EXCEPTION 'Service not found or not owned by you';
  END IF;

  IF EXISTS (SELECT 1 FROM public.service_booking_items WHERE service_id = p_service_id) THEN
    UPDATE public.provider_services SET is_active = false WHERE id = p_service_id;
    RETURN 'archived';
  END IF;

  DELETE FROM public.provider_services WHERE id = p_service_id;
  RETURN 'deleted';
END;
$function$
;

REVOKE ALL ON FUNCTION public.delete_provider_service_safe(uuid) FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.delete_provider_service_safe(uuid) TO authenticated, project_admin;

CREATE OR REPLACE FUNCTION public.set_service_provider_categories(p_provider_id uuid, p_categories text[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_clean text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.service_providers sp
    JOIN public.users u ON u.id = sp.user_id
    WHERE sp.id = p_provider_id AND sp.user_id = (SELECT auth.uid()) AND u.is_service_provider = true
  ) THEN
    RAISE EXCEPTION 'Not authorized to edit categories for this provider';
  END IF;

  SELECT array_agg(c ORDER BY first_pos) INTO v_clean
  FROM (
    SELECT trim(c) AS c, min(ord) AS first_pos
    FROM unnest(p_categories) WITH ORDINALITY AS t(c, ord)
    WHERE trim(c) <> ''
    GROUP BY trim(c)
  ) dedup;

  IF v_clean IS NULL OR array_length(v_clean, 1) = 0 THEN
    RAISE EXCEPTION 'At least one category is required';
  END IF;
  IF array_length(v_clean, 1) > 5 THEN
    RAISE EXCEPTION 'A provider may select at most 5 categories';
  END IF;

  UPDATE public.service_providers SET category = v_clean[1], updated_at = now() WHERE id = p_provider_id;

  DELETE FROM public.service_provider_categories
   WHERE provider_id = p_provider_id AND category <> ALL (v_clean);

  INSERT INTO public.service_provider_categories (provider_id, category)
  SELECT p_provider_id, c FROM unnest(v_clean) AS c
  ON CONFLICT (provider_id, category) DO NOTHING;
END;
$function$
;

REVOKE ALL ON FUNCTION public.set_service_provider_categories(uuid, text[]) FROM PUBLIC, anon, project_admin;
GRANT EXECUTE ON FUNCTION public.set_service_provider_categories(uuid, text[]) TO authenticated, project_admin;
