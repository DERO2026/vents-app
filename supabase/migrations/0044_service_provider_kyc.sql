-- Service Provider KYC, mirroring the Organizer verification architecture
-- (0037_organizer_verification_country_aware.sql) so post-approval provider
-- onboarding has the same shape: submit request w/ country-aware identity
-- fields + document -> admin review -> single atomic approve/reject RPC
-- that updates the request AND grants/denies the capability AND notifies
-- the user. Does NOT touch organizer_verification_requests, users.role,
-- promote_to_organizer(), or admin_set_service_provider_capability() (kept
-- as-is for any other direct-grant caller) -- this is purely additive.
--
-- NIN/CAC here are still format/presence checks only, same honesty as
-- Organizer verification's own NIN check -- no automated identity-verification
-- vendor is wired up in this pass (see migration comment below and the
-- final report for the integration point this leaves for a real KYC vendor).

ALTER TABLE public.service_provider_requests
  ADD COLUMN IF NOT EXISTS provider_type text NOT NULL DEFAULT 'individual',
  ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'NG',
  ADD COLUMN IF NOT EXISTS owner_name text,
  ADD COLUMN IF NOT EXISTS document_url text,
  ADD COLUMN IF NOT EXISTS identity_id_type text,
  ADD COLUMN IF NOT EXISTS identity_id_number text,
  ADD COLUMN IF NOT EXISTS business_name text,
  ADD COLUMN IF NOT EXISTS cac_number text;

ALTER TABLE public.service_provider_requests
  ADD CONSTRAINT service_provider_requests_provider_type_check
    CHECK (provider_type = ANY (ARRAY['individual'::text, 'business'::text])),
  ADD CONSTRAINT service_provider_requests_country_format_check
    CHECK (country ~ '^[A-Z]{2}$');

-- ── submit_service_provider_verification: country/type-aware, same
-- validation shape as submit_organizer_verification(). New function (the
-- old free-text-only insert stays a raw client .insert() nowhere in the
-- DB layer, so nothing to DROP here).
CREATE FUNCTION public.submit_service_provider_verification(
  p_provider_type text,
  p_country text,
  p_owner_name text,
  p_document_url text,
  p_reason text DEFAULT NULL,
  p_business_name text DEFAULT NULL,
  p_cac_number text DEFAULT NULL,
  p_identity_id_type text DEFAULT NULL,
  p_identity_id_number text DEFAULT NULL
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_id uuid;
  v_type text := lower(trim(coalesce(p_provider_type, '')));
  v_country text := upper(trim(coalesce(p_country, '')));
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  IF v_type NOT IN ('individual', 'business') THEN
    RAISE EXCEPTION 'provider_type must be ''individual'' or ''business''';
  END IF;
  IF v_country !~ '^[A-Z]{2}$' THEN
    RAISE EXCEPTION 'A valid country is required';
  END IF;

  IF trim(coalesce(p_owner_name, '')) = '' THEN RAISE EXCEPTION 'Your name is required'; END IF;
  IF trim(coalesce(p_document_url, '')) = '' THEN RAISE EXCEPTION 'A verification document is required'; END IF;

  IF v_type = 'business' THEN
    IF trim(coalesce(p_business_name, '')) = '' THEN RAISE EXCEPTION 'Business name is required'; END IF;
    IF v_country = 'NG' THEN
      IF trim(coalesce(p_cac_number, '')) = '' THEN RAISE EXCEPTION 'CAC number is required'; END IF;
    END IF;
    -- Other countries: no local business-registration-number requirement
    -- defined yet -- p_cac_number stays optional, same reasoning as the
    -- Organizer flow.
  ELSE -- individual
    IF v_country = 'NG' THEN
      IF trim(coalesce(p_identity_id_type, '')) = '' THEN p_identity_id_type := 'NIN'; END IF;
      IF p_identity_id_type <> 'NIN' THEN RAISE EXCEPTION 'Unsupported identity document type for Nigeria'; END IF;
      IF trim(coalesce(p_identity_id_number, '')) = '' THEN RAISE EXCEPTION 'A valid NIN is required'; END IF;
      IF trim(p_identity_id_number) !~ '^[0-9]{11}$' THEN RAISE EXCEPTION 'NIN must be 11 digits'; END IF;
    END IF;
    -- Other countries: owner_name + document_url (already required above)
    -- is the minimum accepted, same as Organizer verification.
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.service_provider_requests
    WHERE user_id = v_user_id AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'You already have a pending request';
  END IF;

  INSERT INTO public.service_provider_requests
    (user_id, reason, provider_type, country, owner_name, document_url,
     identity_id_type, identity_id_number, business_name, cac_number)
  VALUES (
    v_user_id, NULLIF(trim(coalesce(p_reason, '')), ''), v_type, v_country,
    trim(p_owner_name), p_document_url,
    NULLIF(trim(coalesce(p_identity_id_type, '')), ''),
    NULLIF(trim(coalesce(p_identity_id_number, '')), ''),
    NULLIF(trim(coalesce(p_business_name, '')), ''),
    NULLIF(trim(coalesce(p_cac_number, '')), '')
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END; $function$
;

REVOKE ALL ON FUNCTION public.submit_service_provider_verification(text, text, text, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.submit_service_provider_verification(text, text, text, text, text, text, text, text, text) TO authenticated, project_admin;

-- ── my_latest_service_provider_verification: caller's own latest request ─
CREATE FUNCTION public.my_latest_service_provider_verification()
 RETURNS TABLE(
   request_id uuid, status text, admin_note text, created_at timestamptz, reviewed_at timestamptz,
   provider_type text, country text, owner_name text, business_name text, cac_number text,
   identity_id_type text, identity_id_number text, document_url text, reason text
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN QUERY
  SELECT r.id, r.status, r.admin_note, r.created_at, r.reviewed_at,
    r.provider_type, r.country, r.owner_name, r.business_name, r.cac_number,
    r.identity_id_type, r.identity_id_number, r.document_url, r.reason
  FROM public.service_provider_requests r
  WHERE r.user_id = v_user_id
  ORDER BY r.created_at DESC
  LIMIT 1;
END; $function$
;

REVOKE ALL ON FUNCTION public.my_latest_service_provider_verification() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.my_latest_service_provider_verification() TO authenticated, project_admin;

-- ── admin_decide_service_provider_request: single atomic
-- approve/reject RPC, replacing the client's two-step
-- update-then-admin_set_service_provider_capability -- fixes the "approved
-- applicants never get notified" gap, since the notification now fires in
-- the same transaction as the capability grant, guaranteed together.
CREATE FUNCTION public.admin_decide_service_provider_request(p_request_id uuid, p_status text, p_admin_note text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_user_id uuid; v_business text; v_type text;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  IF p_status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'status must be ''approved'' or ''rejected''';
  END IF;

  SELECT user_id, business_name, provider_type INTO v_user_id, v_business, v_type
  FROM public.service_provider_requests
  WHERE id = p_request_id AND status = 'pending';
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Request not found or already reviewed'; END IF;

  UPDATE public.service_provider_requests
  SET status = p_status, admin_note = p_admin_note, reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = p_request_id;

  IF p_status = 'approved' THEN
    UPDATE public.users SET is_service_provider = true WHERE id = v_user_id;
    INSERT INTO public.notifications (user_id, type, title, body, read, icon)
    VALUES (
      v_user_id, 'promo', 'Provider Application Approved ✓',
      'You''re approved as a Service Provider on Vents. Set up your services listing to go live.',
      false, '🛠️'
    );
  ELSE
    INSERT INTO public.notifications (user_id, type, title, body, read, icon)
    VALUES (
      v_user_id, 'promo', 'Provider Application Update',
      COALESCE('Your Service Provider application was not approved: ' || p_admin_note, 'Your Service Provider application was not approved.'),
      false, 'ℹ️'
    );
  END IF;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'service_provider_request_decision', v_user_id, jsonb_build_object('request_id', p_request_id, 'status', p_status), public.actor_role());
END;
$function$
;

REVOKE ALL ON FUNCTION public.admin_decide_service_provider_request(uuid, text, text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_decide_service_provider_request(uuid, text, text) TO authenticated, project_admin;
