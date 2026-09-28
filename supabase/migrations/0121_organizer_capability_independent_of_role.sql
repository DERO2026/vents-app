-- Fix the Multi-Role Account Architecture audit finding: public.users.role
-- conflated the Organizer capability with the staff tier (user/sub-admin/
-- admin), so admin_set_user_role could silently discard Organizer status
-- (and vice versa -- an organizer could never also be a sub-admin). Service
-- Provider was already correctly modeled as its own independent boolean +
-- admin_set_service_provider_capability() RPC; this migration gives
-- Organizer the exact same treatment so the three dimensions (User account,
-- Organizer capability, Service Provider capability, staff tier) are fully
-- independent and can coexist.
--
-- Pre-migration counts on this project (verified live before writing this
-- migration): 40 total users, 9 with role='organizer', 2 with
-- is_service_provider=true, 1 with both. This migration preserves all of
-- them -- it moves the *signal* from role to is_organizer, it does not
-- delete or invalidate anything.

-- 1. New independent capability column, same shape as is_service_provider.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_organizer boolean NOT NULL DEFAULT false;

-- 2. Backfill from the current (conflated) role value -- every existing
-- organizer keeps their capability.
UPDATE public.users SET is_organizer = true WHERE role IN ('organizer', 'organiser');

-- 3. role now represents staff tier only. Existing organizer accounts drop
-- back to 'user' at the role layer -- their Organizer capability survives
-- via is_organizer (step 2), and nothing about their events/wallet/RLS
-- access depends on role for organizers (every organizer_* table's RLS is
-- keyed on `organizer_id = auth.uid()` ownership, never on users.role --
-- confirmed live via pg_policies before writing this migration).
UPDATE public.users SET role = 'user' WHERE role IN ('organizer', 'organiser');

-- 4. Protect the new column the same way is_service_provider is already
-- protected -- only a SECURITY DEFINER RPC may change it, never a direct
-- authenticated table write.
CREATE OR REPLACE FUNCTION public.protect_capability_columns()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_user <> 'authenticated' THEN RETURN NEW; END IF;

  IF OLD.is_service_provider IS DISTINCT FROM NEW.is_service_provider THEN
    RAISE EXCEPTION 'is_service_provider can only be changed via admin_set_service_provider_capability()';
  END IF;

  IF OLD.is_organizer IS DISTINCT FROM NEW.is_organizer THEN
    RAISE EXCEPTION 'is_organizer can only be changed via admin_set_organizer_capability() or promote_to_organizer()';
  END IF;

  RETURN NEW;
END;
$function$;

-- 5. Admin capability setter, mirroring admin_set_service_provider_capability
-- exactly -- Super Admin only, logs to admin_logs, never touches role.
CREATE OR REPLACE FUNCTION public.admin_set_organizer_capability(p_user_id uuid, p_enabled boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_previous boolean;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required (your role: %)',
      COALESCE((SELECT role FROM public.users WHERE id = auth.uid()), 'none');
  END IF;

  SELECT is_organizer INTO v_previous FROM public.users WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found: %', p_user_id;
  END IF;

  UPDATE public.users SET is_organizer = p_enabled WHERE id = p_user_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(),
    'organizer_capability_change',
    p_user_id,
    jsonb_build_object('previous', v_previous, 'new', p_enabled),
    public.actor_role()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_set_organizer_capability(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_organizer_capability(uuid, boolean) TO authenticated, project_admin;

-- 6. admin_set_user_role now only ever sets staff tier -- 'organizer' is no
-- longer a valid value here at all (use admin_set_organizer_capability
-- instead), so this RPC can never again clobber Organizer status.
CREATE OR REPLACE FUNCTION public.admin_set_user_role(p_user_id uuid, p_new_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_target_role text;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required (your role: %)',
      COALESCE((SELECT role FROM public.users WHERE id = auth.uid()), 'none');
  END IF;

  IF p_new_role = 'sub-admin' THEN
    IF NOT public.is_root() THEN
      RAISE EXCEPTION 'Only Root can assign the Sub-Admin role';
    END IF;
  ELSIF p_new_role <> 'user' THEN
    RAISE EXCEPTION 'Invalid role: % (allowed: user, sub-admin [Root only] -- Organizer/Service Provider are independent capabilities set via admin_set_organizer_capability()/admin_set_service_provider_capability())', p_new_role;
  END IF;

  IF p_user_id = 'c9eb5eb6-d4d3-4ecb-9cda-b6e8b9bf2832' THEN
    RAISE EXCEPTION 'Root admin role cannot be changed';
  END IF;

  SELECT role INTO v_target_role FROM public.users WHERE id = p_user_id;

  UPDATE public.users SET role = p_new_role WHERE id = p_user_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(),
    'role_change',
    p_user_id,
    jsonb_build_object('old_role', v_target_role, 'new_role', p_new_role),
    public.actor_role()
  );
END;
$function$;

-- 7. Self-service organizer opt-in: sets the capability flag, never role.
-- Blocks staff tiers (admin AND sub-admin, the audit's item 11 -- the old
-- body only blocked 'admin') from using a plain-user self-service endpoint
-- on themselves, even though (per the prior security pass, 0116) this RPC
-- is no longer callable by authenticated/anon at all -- kept as
-- defense-in-depth in case that grant is ever revisited.
CREATE OR REPLACE FUNCTION public.promote_to_organizer()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_id uuid;
  v_role text;
BEGIN
  v_id := auth.uid();
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT role INTO v_role FROM public.users WHERE id = v_id;

  IF v_role IN ('admin', 'sub-admin') THEN
    RAISE EXCEPTION 'Staff accounts cannot self-promote via this endpoint';
  END IF;

  UPDATE public.users SET is_organizer = true WHERE id = v_id;
END;
$function$;

-- 8. Signup-time organizer opt-in (AuthScreen.tsx's set_signup_role call) --
-- 'organizer' now sets the capability flag instead of role.
CREATE OR REPLACE FUNCTION public.set_signup_role(p_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_id uuid;
  v_current_role text;
BEGIN
  v_id := auth.uid();
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_role NOT IN ('organizer', 'user') THEN
    RAISE EXCEPTION 'Invalid role';
  END IF;

  SELECT role INTO v_current_role FROM public.users WHERE id = v_id;
  IF v_current_role = 'admin' THEN
    RAISE EXCEPTION 'Admin role cannot be changed';
  END IF;

  IF p_role = 'organizer' THEN
    UPDATE public.users SET is_organizer = true WHERE id = v_id;
  END IF;
END;
$function$;

-- 9. organizer_requests approval now grants the independent capability
-- unconditionally (regardless of the applicant's current staff tier),
-- fixing the edge case where an admin/sub-admin applying for Organizer
-- previously got role_granted=false because their role wasn't 'user'.
CREATE OR REPLACE FUNCTION public.admin_decide_organizer_request(p_request_id uuid, p_approve boolean, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_id      uuid;
  v_status       text;
  v_prior_organizer boolean;
  v_capability_granted boolean := false;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required to decide an organizer request (your role: %). Sub-Admins must submit this for approval.',
      COALESCE(public.actor_role(), 'none');
  END IF;
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'p_request_id is required'; END IF;
  IF p_approve IS NULL THEN RAISE EXCEPTION 'p_approve is required'; END IF;

  v_status := CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END;

  UPDATE public.organizer_requests
     SET status      = v_status,
         admin_note  = p_reason,
         reviewed_by = auth.uid(),
         reviewed_at = now()
   WHERE id = p_request_id
     AND status = 'pending'
  RETURNING user_id INTO v_user_id;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Request not found or already reviewed';
  END IF;

  SELECT u.is_organizer INTO v_prior_organizer FROM public.users u WHERE u.id = v_user_id;

  IF p_approve THEN
    IF NOT COALESCE(v_prior_organizer, false) THEN
      UPDATE public.users SET is_organizer = true WHERE id = v_user_id;
      v_capability_granted := true;
    END IF;

    INSERT INTO public.notifications (user_id, type, title, body, read, icon)
    VALUES (v_user_id, 'promo', 'Organizer Application Approved ✓',
            'You''re approved as an Organizer on Vents. You can now create and sell tickets for your events.',
            false, '🎤');
  ELSE
    INSERT INTO public.notifications (user_id, type, title, body, read, icon)
    VALUES (v_user_id, 'promo', 'Organizer Application Update',
            COALESCE('Your Organizer application was not approved: ' || p_reason,
                     'Your Organizer application was not approved.'),
            false, 'ℹ️');
  END IF;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(),
    'organizer_request_decision',
    v_user_id,
    jsonb_build_object(
      'request_id',          p_request_id,
      'status',               v_status,
      'reason',               p_reason,
      'prior_is_organizer',   v_prior_organizer,
      'capability_granted',   v_capability_granted
    ),
    public.actor_role()
  );

  RETURN jsonb_build_object(
    'request_id', p_request_id,
    'status', v_status,
    'user_id', v_user_id,
    'role_granted', v_capability_granted
  );
END;
$function$;

-- 10. Brand-verification eligibility now keys on the capability flag, not role.
CREATE OR REPLACE FUNCTION public.submit_organizer_verification(p_organizer_type text, p_country text, p_owner_name text, p_document_url text, p_company_name text DEFAULT NULL::text, p_cac_number text DEFAULT NULL::text, p_business_address text DEFAULT NULL::text, p_registration_date date DEFAULT NULL::date, p_business_email text DEFAULT NULL::text, p_business_phone text DEFAULT NULL::text, p_identity_id_type text DEFAULT NULL::text, p_identity_id_number text DEFAULT NULL::text)
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
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_user_id AND is_organizer = true) THEN
    RAISE EXCEPTION 'Only organizers can request brand verification';
  END IF;

  IF v_type NOT IN ('individual', 'business') THEN
    RAISE EXCEPTION 'organizer_type must be ''individual'' or ''business''';
  END IF;
  IF v_country !~ '^[A-Z]{2}$' THEN
    RAISE EXCEPTION 'A valid country is required';
  END IF;

  IF trim(coalesce(p_owner_name, '')) = '' THEN RAISE EXCEPTION 'Your name is required'; END IF;
  IF trim(coalesce(p_document_url, '')) = '' THEN RAISE EXCEPTION 'A verification document is required'; END IF;

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

  ELSE -- individual
    IF v_country = 'NG' THEN
      IF trim(coalesce(p_identity_id_type, '')) = '' THEN p_identity_id_type := 'NIN'; END IF;
      IF p_identity_id_type <> 'NIN' THEN RAISE EXCEPTION 'Unsupported identity document type for Nigeria'; END IF;
      IF trim(coalesce(p_identity_id_number, '')) = '' THEN RAISE EXCEPTION 'A valid NIN is required'; END IF;
      IF trim(p_identity_id_number) !~ '^[0-9]{11}$' THEN RAISE EXCEPTION 'NIN must be 11 digits'; END IF;
    END IF;
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
END; $function$;

-- 11. is_organizer() helper (used elsewhere for capability checks) now
-- reads the real capability column instead of the old conflated role value.
CREATE OR REPLACE FUNCTION public.is_organizer()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
      AND (is_organizer = true OR role = 'admin')
  );
$function$;

-- 12. Audit-log helper for the (now-dead, per a prior security audit --
-- App.tsx's only caller was removed when the promote_to_organizer
-- self-escalation bypass was closed) client self-log path -- fixed for
-- correctness/consistency rather than left referencing a column that no
-- longer carries this meaning.
CREATE OR REPLACE FUNCTION public.log_organizer_promotion(p_user_id uuid, p_email text, p_username text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'caller must be the target user';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = p_user_id AND is_organizer = true
  ) THEN
    RAISE EXCEPTION 'user is not an organizer';
  END IF;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details)
  VALUES (
    p_user_id,
    'organizer_promoted',
    p_user_id,
    jsonb_build_object(
      'email',       p_email,
      'username',    p_username,
      'promoted_at', now()
    )
  );
END;
$function$;

-- 13. New-signup trigger: role is never set to 'organizer' from auth
-- metadata (raw_app_meta_data isn't client-settable via a normal signUp()
-- call anyway -- this path was already effectively unreachable from the
-- app's own client code, fixed here for correctness). An organizer signal
-- in metadata now sets the capability flag on the same insert.
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_is_organizer boolean;
  v_full_name text;
  v_username text;
  v_phone text;
  v_state text;
  v_country text;
  v_dob date;
BEGIN
  v_is_organizer := COALESCE(NEW.raw_app_meta_data->>'role' = 'organizer', false);

  v_full_name := NULLIF(trim(NEW.raw_user_meta_data->>'full_name'), '');
  v_username  := NULLIF(trim(lower(NEW.raw_user_meta_data->>'username')), '');
  v_phone     := NULLIF(trim(NEW.raw_user_meta_data->>'phone_number'), '');
  v_state     := NULLIF(trim(NEW.raw_user_meta_data->>'state'), '');
  v_country   := NULLIF(trim(NEW.raw_user_meta_data->>'country'), '');
  BEGIN
    v_dob := NULLIF(NEW.raw_user_meta_data->>'date_of_birth', '')::date;
  EXCEPTION WHEN OTHERS THEN
    v_dob := NULL;
  END;

  BEGIN
    INSERT INTO public.users (id, email, role, is_organizer, full_name, username, phone_number, state, country, date_of_birth)
    VALUES (NEW.id, NEW.email, 'user', v_is_organizer, v_full_name, v_username, v_phone, v_state, v_country, v_dob);
  EXCEPTION WHEN unique_violation OR check_violation THEN
    INSERT INTO public.users (id, email, role, is_organizer)
    VALUES (NEW.id, NEW.email, 'user', v_is_organizer);
  END;

  RETURN NEW;
END;
$function$;
