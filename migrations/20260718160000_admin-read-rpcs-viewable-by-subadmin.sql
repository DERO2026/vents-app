-- ── Keep admin READ/LIST RPCs viewable by Sub-Admins ─────────────────────────
-- The maker-checker re-gate pointed is_admin_or_root() at is_super_admin(), which
-- correctly blocks Sub-Admins from EXECUTING write RPCs — but it also gated the
-- read/list RPCs they need to SEE the data before requesting an action. Re-gate
-- those specific reads to is_admin() (Root + Admin + Sub-Admin). Writes stay
-- Super-Admin-only. (admin_get_verification_stats already used is_admin().)

CREATE OR REPLACE FUNCTION public.admin_list_organizer_verifications(
  p_status text DEFAULT 'pending'::text, p_search text DEFAULT NULL::text,
  p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
  RETURNS TABLE(request_id uuid, user_id uuid, full_name text, email text, phone_number text,
    state text, avatar_url text, is_verified boolean, company_name text, cac_number text,
    owner_name text, registration_date date, business_email text, business_phone text,
    business_address text, document_url text, status text, admin_note text,
    reviewed_at timestamptz, created_at timestamptz, total_count bigint)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $fn$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
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
END; $fn$;
ALTER FUNCTION public.admin_list_organizer_verifications(text, text, integer, integer) SET search_path = '';

CREATE OR REPLACE FUNCTION public.admin_get_vc_aggregates()
  RETURNS TABLE(circulation numeric, total_txns bigint, credits bigint, debits bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'not authorized'; END IF;
  RETURN QUERY
  SELECT
    (SELECT coalesce(sum(balance), 0) FROM public.vents_wallets)::numeric AS circulation,
    (SELECT count(*) FROM public.vc_transactions)::bigint AS total_txns,
    (SELECT count(*) FROM public.vc_transactions WHERE type IN ('earn', 'referral') AND status = 'active')::bigint AS credits,
    (SELECT count(*) FROM public.vc_transactions WHERE type = 'spend' AND status = 'spent')::bigint AS debits;
END; $fn$;
