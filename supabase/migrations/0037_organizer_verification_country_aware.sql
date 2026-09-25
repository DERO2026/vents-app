-- Makes Organizer verification country-aware and distinguishes individual
-- organizers from registered businesses. Audit finding (read-only pass
-- before this migration): organizer_verification_requests was 100%
-- CAC/Nigeria-shaped -- every business field NOT NULL, no country column,
-- no individual-vs-business flag, and submit_organizer_verification()
-- unconditionally required a CAC number. That's fine for the ~1000
-- Nigerian rows that exist today (all of them genuinely were CAC
-- submissions -- backfilling organizer_type='business', country='NG'
-- below is an accurate historical fact, not an invented guess, unlike a
-- column where the true value is genuinely unknown), but structurally
-- breaks for an individual organizer or a non-Nigerian one.
--
-- Deliberately NOT introducing a per-country requirements table --
-- that's more schema than this needs. The country/type-specific "what's
-- required" logic lives in submit_organizer_verification() as explicit
-- branches (NG individual needs NIN, NG business needs CAC, anything
-- else falls back to owner_name + document_url only). Adding a new
-- country later means adding one more branch there, not a schema
-- rewrite -- matches how service_providers.category has no DB enum
-- either, just a client-enforced list.
--
-- Does NOT touch organizer_requests, check_user_role_update(),
-- promote_to_organizer(), users.role, users.country, or any Service
-- Provider capability table/column (0033/0034/0036) -- all untouched.

ALTER TABLE public.organizer_verification_requests
  ADD COLUMN IF NOT EXISTS organizer_type text NOT NULL DEFAULT 'business',
  ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'NG',
  ADD COLUMN IF NOT EXISTS identity_id_type text,
  ADD COLUMN IF NOT EXISTS identity_id_number text;

ALTER TABLE public.organizer_verification_requests
  ADD CONSTRAINT organizer_verification_requests_organizer_type_check
    CHECK (organizer_type = ANY (ARRAY['individual'::text, 'business'::text])),
  ADD CONSTRAINT organizer_verification_requests_country_format_check
    CHECK (country ~ '^[A-Z]{2}$');

-- The CAC/business-specific columns are no longer universally required --
-- an individual organizer's submission (any country) or a non-Nigerian
-- business won't have a CAC number, and shouldn't be forced to invent
-- one. submit_organizer_verification() below enforces the real
-- country/type-conditional requirements; the DB layer only guards shape,
-- same division of responsibility as before this migration.
ALTER TABLE public.organizer_verification_requests
  ALTER COLUMN company_name DROP NOT NULL,
  ALTER COLUMN cac_number DROP NOT NULL,
  ALTER COLUMN business_address DROP NOT NULL,
  ALTER COLUMN registration_date DROP NOT NULL,
  ALTER COLUMN business_email DROP NOT NULL,
  ALTER COLUMN business_phone DROP NOT NULL;

-- ── submit_organizer_verification: country/type-aware rewrite ──────────
-- Signature changed (organizer_type/country added, business fields moved
-- to optional) -- DROP + CREATE rather than CREATE OR REPLACE, since
-- Postgres won't let OR REPLACE change a function's parameter list.
DROP FUNCTION IF EXISTS public.submit_organizer_verification(text, text, text, text, text, date, text, text);

CREATE FUNCTION public.submit_organizer_verification(
  p_organizer_type text,
  p_country text,
  p_owner_name text,
  p_document_url text,
  p_company_name text DEFAULT NULL,
  p_cac_number text DEFAULT NULL,
  p_business_address text DEFAULT NULL,
  p_registration_date date DEFAULT NULL,
  p_business_email text DEFAULT NULL,
  p_business_phone text DEFAULT NULL,
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
  v_type text := lower(trim(coalesce(p_organizer_type, '')));
  v_country text := upper(trim(coalesce(p_country, '')));
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_user_id AND role = 'organizer') THEN
    RAISE EXCEPTION 'Only organizers can request brand verification';
  END IF;

  IF v_type NOT IN ('individual', 'business') THEN
    RAISE EXCEPTION 'organizer_type must be ''individual'' or ''business''';
  END IF;
  IF v_country !~ '^[A-Z]{2}$' THEN
    RAISE EXCEPTION 'A valid country is required';
  END IF;

  -- Universal fields, required regardless of type/country.
  IF trim(coalesce(p_owner_name, '')) = '' THEN RAISE EXCEPTION 'Your name is required'; END IF;
  IF trim(coalesce(p_document_url, '')) = '' THEN RAISE EXCEPTION 'A verification document is required'; END IF;

  -- Country/type-conditional requirements. Extending to a new country is
  -- adding a branch here, not altering the table again.
  IF v_type = 'business' THEN
    IF trim(coalesce(p_company_name, '')) = '' THEN RAISE EXCEPTION 'Business name is required'; END IF;
    IF trim(coalesce(p_business_address, '')) = '' THEN RAISE EXCEPTION 'Business address is required'; END IF;
    IF p_registration_date IS NULL OR p_registration_date > CURRENT_DATE THEN
      RAISE EXCEPTION 'A valid registration date is required';
    END IF;
    IF trim(coalesce(p_business_email, '')) !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
      RAISE EXCEPTION 'A valid business email is required';
    END IF;
    IF trim(coalesce(p_business_phone, '')) = '' THEN RAISE EXCEPTION 'Business phone is required'; END IF;

    IF v_country = 'NG' THEN
      IF trim(coalesce(p_cac_number, '')) = '' THEN RAISE EXCEPTION 'CAC number is required'; END IF;
    END IF;
    -- Other countries: no local business-registration-number requirement
    -- defined yet -- p_cac_number stays optional rather than forcing a
    -- Nigeria-specific field on a business that has no CAC.

  ELSE -- individual
    IF v_country = 'NG' THEN
      IF trim(coalesce(p_identity_id_type, '')) = '' THEN p_identity_id_type := 'NIN'; END IF;
      IF p_identity_id_type <> 'NIN' THEN RAISE EXCEPTION 'Unsupported identity document type for Nigeria'; END IF;
      IF trim(coalesce(p_identity_id_number, '')) = '' THEN RAISE EXCEPTION 'A valid NIN is required'; END IF;
      IF trim(p_identity_id_number) !~ '^[0-9]{11}$' THEN RAISE EXCEPTION 'NIN must be 11 digits'; END IF;
    END IF;
    -- Other countries: no structured individual-ID requirement defined
    -- yet -- owner_name + document_url (already required above) is the
    -- minimum accepted rather than inventing a requirement VENTS doesn't
    -- actually enforce for that country.
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.organizer_verification_requests
    WHERE user_id = v_user_id AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'You already have a pending verification request';
  END IF;

  INSERT INTO public.organizer_verification_requests
    (user_id, organizer_type, country, company_name, cac_number, business_address, document_url,
     owner_name, registration_date, business_email, business_phone, identity_id_type, identity_id_number)
  VALUES (
    v_user_id, v_type, v_country,
    NULLIF(trim(coalesce(p_company_name, '')), ''),
    NULLIF(trim(coalesce(p_cac_number, '')), ''),
    NULLIF(trim(coalesce(p_business_address, '')), ''),
    p_document_url,
    trim(p_owner_name),
    p_registration_date,
    NULLIF(lower(trim(coalesce(p_business_email, ''))), ''),
    NULLIF(trim(coalesce(p_business_phone, '')), ''),
    NULLIF(trim(coalesce(p_identity_id_type, '')), ''),
    NULLIF(trim(coalesce(p_identity_id_number, '')), '')
  )
  RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'You already have a pending verification request';
END; $function$
;

REVOKE ALL ON FUNCTION public.submit_organizer_verification(text, text, text, text, text, text, text, date, text, text, text, text) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.submit_organizer_verification(text, text, text, text, text, text, text, date, text, text, text, text) TO authenticated, project_admin;

-- ── my_latest_organizer_verification: widen the return shape ───────────
DROP FUNCTION IF EXISTS public.my_latest_organizer_verification();

CREATE FUNCTION public.my_latest_organizer_verification()
 RETURNS TABLE(
   request_id uuid, status text, admin_note text, created_at timestamptz, reviewed_at timestamptz,
   organizer_type text, country text,
   company_name text, cac_number text, owner_name text, registration_date date,
   business_email text, business_phone text, business_address text,
   identity_id_type text, identity_id_number text, document_url text
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
    r.organizer_type, r.country,
    r.company_name, r.cac_number, r.owner_name, r.registration_date,
    r.business_email, r.business_phone, r.business_address,
    r.identity_id_type, r.identity_id_number, r.document_url
  FROM public.organizer_verification_requests r
  WHERE r.user_id = v_user_id
  ORDER BY r.created_at DESC
  LIMIT 1;
END; $function$
;

REVOKE ALL ON FUNCTION public.my_latest_organizer_verification() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.my_latest_organizer_verification() TO authenticated, project_admin;

-- ── admin_list_organizer_verifications: widen the return shape ─────────
DROP FUNCTION IF EXISTS public.admin_list_organizer_verifications(text, text, integer, integer);

CREATE FUNCTION public.admin_list_organizer_verifications(p_status text DEFAULT 'pending'::text, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(
   request_id uuid, user_id uuid, full_name text, email text, phone_number text, state text,
   avatar_url text, is_verified boolean,
   organizer_type text, country text,
   company_name text, cac_number text, owner_name text, registration_date date,
   business_email text, business_phone text, business_address text,
   identity_id_type text, identity_id_number text, document_url text,
   status text, admin_note text, reviewed_at timestamptz, created_at timestamptz, total_count bigint
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  RETURN QUERY
  SELECT r.id, r.user_id, u.full_name, u.email, u.phone_number, u.state,
    u.avatar_url, u.is_verified,
    r.organizer_type, r.country,
    r.company_name, r.cac_number, r.owner_name, r.registration_date,
    r.business_email, r.business_phone, r.business_address,
    r.identity_id_type, r.identity_id_number, r.document_url,
    r.status, r.admin_note, r.reviewed_at, r.created_at,
    count(*) OVER()::bigint AS total_count
  FROM public.organizer_verification_requests r
  JOIN public.users u ON u.id = r.user_id
  WHERE (p_status IS NULL OR p_status = 'all' OR r.status = p_status)
    AND (
      p_search IS NULL OR trim(p_search) = '' OR
      r.company_name ILIKE '%' || p_search || '%' OR
      r.cac_number ILIKE '%' || p_search || '%' OR
      r.identity_id_number ILIKE '%' || p_search || '%' OR
      u.full_name ILIKE '%' || p_search || '%' OR
      u.email ILIKE '%' || p_search || '%'
    )
  ORDER BY r.created_at DESC
  LIMIT p_limit OFFSET p_offset;
END; $function$
;

REVOKE ALL ON FUNCTION public.admin_list_organizer_verifications(text, text, integer, integer) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_list_organizer_verifications(text, text, integer, integer) TO authenticated, project_admin;

-- ── admin_approve_organizer_verification: type-aware notification copy ─
-- Same approval mechanics (status/users.is_verified/admin_logs) as
-- before, completely unchanged -- only the notification text now reads
-- correctly for an individual organizer instead of always saying "Your
-- organization ... has been verified".
CREATE OR REPLACE FUNCTION public.admin_approve_organizer_verification(p_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_user_id uuid; v_company text; v_type text;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  SELECT user_id, company_name, organizer_type INTO v_user_id, v_company, v_type
  FROM public.organizer_verification_requests
  WHERE id = p_request_id AND status = 'pending';
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Request not found or already reviewed'; END IF;

  UPDATE public.organizer_verification_requests
  SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = p_request_id;
  UPDATE public.users SET is_verified = true WHERE id = v_user_id;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (
    v_user_id, 'promo', 'Brand Verified ✓',
    CASE WHEN v_type = 'individual'
      THEN 'You have been verified. Your verified badge is now live across Vents.'
      ELSE COALESCE(v_company, 'Your organization') || ' has been verified. Your verified badge is now live across Vents.'
    END,
    false, '🛡️'
  );

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'approve_organizer_verification', v_user_id, jsonb_build_object('request_id', p_request_id), public.actor_role());
END;
$function$
;
