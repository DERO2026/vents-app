-- Organizer Verification workflow v2 — production-ready schema + RPCs.
--
-- Extends the existing organizer_verification_requests table (created
-- 2026-07-09) with owner/contact fields the CAC form now collects.
-- company_name/cac_number/business_address/document_url/admin_note are
-- kept as-is (they already map 1:1 onto businessName/CACNumber/
-- uploadedDocument/rejectionReason) rather than renamed, since several
-- existing RPCs and the admin dashboard already reference those names.

ALTER TABLE public.organizer_verification_requests
  ADD COLUMN IF NOT EXISTS owner_name text,
  ADD COLUMN IF NOT EXISTS registration_date date,
  ADD COLUMN IF NOT EXISTS business_email text,
  ADD COLUMN IF NOT EXISTS business_phone text;

-- Backfill any pre-existing rows (submitted before these columns existed)
-- from the requester's own account so the NOT NULL constraints below can be
-- applied without data loss.
UPDATE public.organizer_verification_requests r
SET owner_name = COALESCE(r.owner_name, NULLIF(u.full_name, ''), split_part(u.email, '@', 1)),
    registration_date = COALESCE(r.registration_date, r.created_at::date),
    business_email = COALESCE(r.business_email, u.email),
    business_phone = COALESCE(r.business_phone, u.phone_number, 'unknown')
FROM public.users u
WHERE u.id = r.user_id
  AND (r.owner_name IS NULL OR r.registration_date IS NULL OR r.business_email IS NULL OR r.business_phone IS NULL);

ALTER TABLE public.organizer_verification_requests
  ALTER COLUMN owner_name SET NOT NULL,
  ALTER COLUMN registration_date SET NOT NULL,
  ALTER COLUMN business_email SET NOT NULL,
  ALTER COLUMN business_phone SET NOT NULL;

-- Server-side, race-proof duplicate-pending-submission guard (the RPC's own
-- existence check below is a friendly first pass; this index is what
-- actually prevents two concurrent submits from both slipping through).
CREATE UNIQUE INDEX IF NOT EXISTS organizer_verification_requests_one_pending_per_user
  ON public.organizer_verification_requests (user_id)
  WHERE status = 'pending';

-- ── RPC: submit a CAC verification request (v2 — full field set + server-side
-- validation as defense-in-depth behind the client-side validation). Arg
-- list grew from 4 to 8 params, so the old 4-arg overload is dropped first
-- rather than left dangling alongside the new one. ─────────────────────────
DROP FUNCTION IF EXISTS public.submit_organizer_verification(text, text, text, text);

CREATE OR REPLACE FUNCTION public.submit_organizer_verification(
  p_company_name text, p_cac_number text, p_business_address text, p_document_url text,
  p_owner_name text, p_registration_date date, p_business_email text, p_business_phone text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_user_id uuid := auth.uid(); v_id uuid;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_user_id AND role = 'organizer') THEN
    RAISE EXCEPTION 'Only organizers can request brand verification';
  END IF;

  IF trim(coalesce(p_company_name, '')) = '' THEN RAISE EXCEPTION 'Business name is required'; END IF;
  IF trim(coalesce(p_cac_number, '')) = '' THEN RAISE EXCEPTION 'CAC number is required'; END IF;
  IF trim(coalesce(p_business_address, '')) = '' THEN RAISE EXCEPTION 'Business address is required'; END IF;
  IF trim(coalesce(p_owner_name, '')) = '' THEN RAISE EXCEPTION 'Owner name is required'; END IF;
  IF p_registration_date IS NULL OR p_registration_date > CURRENT_DATE THEN
    RAISE EXCEPTION 'A valid registration date is required';
  END IF;
  IF trim(coalesce(p_business_email, '')) !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'A valid business email is required';
  END IF;
  IF trim(coalesce(p_business_phone, '')) = '' THEN RAISE EXCEPTION 'Business phone is required'; END IF;
  IF trim(coalesce(p_document_url, '')) = '' THEN RAISE EXCEPTION 'A certificate document is required'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.organizer_verification_requests
    WHERE user_id = v_user_id AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'You already have a pending verification request';
  END IF;

  INSERT INTO public.organizer_verification_requests
    (user_id, company_name, cac_number, business_address, document_url,
     owner_name, registration_date, business_email, business_phone)
  VALUES (v_user_id, trim(p_company_name), trim(p_cac_number), trim(p_business_address), p_document_url,
          trim(p_owner_name), p_registration_date, lower(trim(p_business_email)), trim(p_business_phone))
  RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'You already have a pending verification request';
END; $function$;
GRANT EXECUTE ON FUNCTION public.submit_organizer_verification(text, text, text, text, text, date, text, text) TO authenticated;

-- ── RPC: current user's own latest verification request (v2 — full field
-- set, enough for a proper Pending status page). Return columns changed, and
-- Postgres won't let CREATE OR REPLACE change a function's return type. ────
DROP FUNCTION IF EXISTS public.my_latest_organizer_verification();

CREATE OR REPLACE FUNCTION public.my_latest_organizer_verification()
RETURNS TABLE (
  request_id uuid, status text, admin_note text, created_at timestamptz, reviewed_at timestamptz,
  company_name text, cac_number text, owner_name text, registration_date date,
  business_email text, business_phone text, business_address text, document_url text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN QUERY
  SELECT r.id, r.status, r.admin_note, r.created_at, r.reviewed_at,
    r.company_name, r.cac_number, r.owner_name, r.registration_date,
    r.business_email, r.business_phone, r.business_address, r.document_url
  FROM public.organizer_verification_requests r
  WHERE r.user_id = v_user_id
  ORDER BY r.created_at DESC
  LIMIT 1;
END; $function$;
GRANT EXECUTE ON FUNCTION public.my_latest_organizer_verification TO authenticated;

-- ── RPC: admin list (v2 — status filter + search + pagination + full field
-- set + organizer profile summary, replacing the old pending-only, unfiltered
-- version). Still Super Admin only, matching the rest of Block 19. Arg list
-- grew from 0 to 4 params, so the old 0-arg overload is dropped first. ─────
DROP FUNCTION IF EXISTS public.admin_list_organizer_verifications();

CREATE OR REPLACE FUNCTION public.admin_list_organizer_verifications(
  p_status text DEFAULT 'pending',
  p_search text DEFAULT NULL,
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0
)
RETURNS TABLE(
  request_id uuid, user_id uuid, full_name text, email text, phone_number text, state text,
  avatar_url text, is_verified boolean,
  company_name text, cac_number text, owner_name text, registration_date date,
  business_email text, business_phone text, business_address text, document_url text,
  status text, admin_note text, reviewed_at timestamptz, created_at timestamptz,
  total_count bigint
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  RETURN QUERY
  SELECT r.id, r.user_id, u.full_name, u.email, u.phone_number, u.state,
    u.avatar_url, u.is_verified,
    r.company_name, r.cac_number, r.owner_name, r.registration_date,
    r.business_email, r.business_phone, r.business_address, r.document_url,
    r.status, r.admin_note, r.reviewed_at, r.created_at,
    count(*) OVER()::bigint AS total_count
  FROM public.organizer_verification_requests r
  JOIN public.users u ON u.id = r.user_id
  WHERE (p_status IS NULL OR p_status = 'all' OR r.status = p_status)
    AND (
      p_search IS NULL OR trim(p_search) = '' OR
      r.company_name ILIKE '%' || p_search || '%' OR
      r.cac_number ILIKE '%' || p_search || '%' OR
      u.full_name ILIKE '%' || p_search || '%' OR
      u.email ILIKE '%' || p_search || '%'
    )
  ORDER BY r.created_at DESC
  LIMIT p_limit OFFSET p_offset;
END; $function$;
GRANT EXECUTE ON FUNCTION public.admin_list_organizer_verifications(text, text, int, int) TO authenticated;

-- ── Reject RPC hardening: require a non-empty reason at the SQL layer too
-- (matches the admin_cancel_processing_payout precedent) — logic otherwise
-- unchanged from the Block 19 version (still Super Admin only, still writes
-- admin_logs). ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_reject_organizer_verification(p_request_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE v_user_id uuid;
BEGIN
  IF NOT public.is_admin_or_root() THEN RAISE EXCEPTION 'Super Admin access required'; END IF;
  IF p_reason IS NULL OR trim(p_reason) = '' THEN RAISE EXCEPTION 'A rejection reason is required'; END IF;
  SELECT user_id INTO v_user_id FROM public.organizer_verification_requests
  WHERE id = p_request_id AND status = 'pending';
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Request not found or already reviewed'; END IF;
  UPDATE public.organizer_verification_requests
  SET status = 'rejected', admin_note = p_reason, reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = p_request_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'reject_organizer_verification', v_user_id,
          jsonb_build_object('request_id', p_request_id, 'reason', p_reason), public.actor_role());
END; $function$;
