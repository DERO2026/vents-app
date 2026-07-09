-- Organizer corporate (CAC) brand verification pipeline.
--
-- Reuses the existing users.is_verified flag as the source of truth for the
-- "verified organizer" badge shown throughout the app — this table is the
-- formal request/review trail behind it, replacing the previous no-document
-- "verify" admin tab which could only toggle is_verified with zero evidence.

CREATE TABLE IF NOT EXISTS public.organizer_verification_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  company_name text NOT NULL,
  cac_number text NOT NULL,
  business_address text NOT NULL,
  document_url text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_note text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.organizer_verification_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY organizer_verif_select_own ON public.organizer_verification_requests
  FOR SELECT USING (auth.uid() = user_id OR is_admin());

CREATE POLICY organizer_verif_insert_own ON public.organizer_verification_requests
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY organizer_verif_admin_update ON public.organizer_verification_requests
  FOR UPDATE USING (is_admin());

-- ── RPC: submit a CAC verification request ──────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_organizer_verification(
  p_company_name text, p_cac_number text, p_business_address text, p_document_url text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_user_id uuid := auth.uid(); v_id uuid;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_user_id AND role = 'organizer') THEN
    RAISE EXCEPTION 'Only organizers can request brand verification';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.organizer_verification_requests
    WHERE user_id = v_user_id AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'You already have a pending verification request';
  END IF;
  INSERT INTO public.organizer_verification_requests
    (user_id, company_name, cac_number, business_address, document_url)
  VALUES (v_user_id, p_company_name, p_cac_number, p_business_address, p_document_url)
  RETURNING id INTO v_id;
  RETURN v_id;
END; $function$;
GRANT EXECUTE ON FUNCTION public.submit_organizer_verification TO authenticated;

-- ── RPC: admin approve — flips users.is_verified atomically with the request
CREATE OR REPLACE FUNCTION public.admin_approve_organizer_verification(p_request_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_user_id uuid;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  SELECT user_id INTO v_user_id FROM public.organizer_verification_requests
  WHERE id = p_request_id AND status = 'pending';
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Request not found or already reviewed'; END IF;
  UPDATE public.organizer_verification_requests
  SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = p_request_id;
  UPDATE public.users SET is_verified = true WHERE id = v_user_id;
END; $function$;
GRANT EXECUTE ON FUNCTION public.admin_approve_organizer_verification TO authenticated;

-- ── RPC: admin reject ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_reject_organizer_verification(p_request_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_user_id uuid;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  SELECT user_id INTO v_user_id FROM public.organizer_verification_requests
  WHERE id = p_request_id AND status = 'pending';
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Request not found or already reviewed'; END IF;
  UPDATE public.organizer_verification_requests
  SET status = 'rejected', admin_note = p_reason, reviewed_by = auth.uid(), reviewed_at = now()
  WHERE id = p_request_id;
END; $function$;
GRANT EXECUTE ON FUNCTION public.admin_reject_organizer_verification TO authenticated;

-- ── RPC: admin list of pending requests, joined with user metadata ──────
CREATE OR REPLACE FUNCTION public.admin_list_organizer_verifications()
RETURNS TABLE (
  request_id uuid, user_id uuid, full_name text, email text, phone_number text, state text,
  company_name text, cac_number text, business_address text, document_url text,
  status text, created_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Admin access required'; END IF;
  RETURN QUERY
  SELECT r.id, r.user_id, u.full_name, u.email, u.phone_number, u.state,
    r.company_name, r.cac_number, r.business_address, r.document_url, r.status, r.created_at
  FROM public.organizer_verification_requests r
  JOIN public.users u ON u.id = r.user_id
  WHERE r.status = 'pending'
  ORDER BY r.created_at ASC;
END; $function$;
GRANT EXECUTE ON FUNCTION public.admin_list_organizer_verifications TO authenticated;

-- ── RPC: current user's own latest verification request (for status UI) ─
CREATE OR REPLACE FUNCTION public.my_latest_organizer_verification()
RETURNS TABLE (
  request_id uuid, status text, admin_note text, created_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  RETURN QUERY
  SELECT r.id, r.status, r.admin_note, r.created_at
  FROM public.organizer_verification_requests r
  WHERE r.user_id = v_user_id
  ORDER BY r.created_at DESC
  LIMIT 1;
END; $function$;
GRANT EXECUTE ON FUNCTION public.my_latest_organizer_verification TO authenticated;
