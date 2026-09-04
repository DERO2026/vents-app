-- Minimal Service Provider capability -- deliberately NOT a `role` value.
-- Per the approved plan: a plain boolean, independent of `role`, so a user
-- can be both an Organizer (role='organizer') and a Service Provider
-- (is_service_provider=true) at the same time on one account. This does
-- NOT touch users.role, its CHECK constraint, promote_to_organizer(),
-- check_user_role_update(), organizer_requests, or
-- organizer_verification_requests -- all existing Organizer architecture
-- is untouched by this migration. Marketplace/Vendors, CAC/identity
-- verification for Service Providers, and a full capability table are
-- explicitly out of scope for this release (see the approved plan).
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_service_provider boolean NOT NULL DEFAULT false;

-- Request table, same shape as organizer_requests (0002_tables.sql) --
-- copied as a template, not shared, so future changes to one never risk
-- the other.
CREATE TABLE IF NOT EXISTS public.service_provider_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'pending'::text,
  admin_note text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_provider_requests_pkey PRIMARY KEY (id),
  CONSTRAINT service_provider_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);

ALTER TABLE public.service_provider_requests ENABLE ROW LEVEL SECURITY;

-- Same 4-policy shape as organizer_requests: users manage their own
-- request, admins can see/update all.
CREATE POLICY service_provider_requests_insert_own ON public.service_provider_requests FOR INSERT TO authenticated WITH CHECK (((SELECT auth.uid()) = user_id));
CREATE POLICY service_provider_requests_select_own ON public.service_provider_requests FOR SELECT TO authenticated USING ((((SELECT auth.uid()) = user_id) OR is_admin()));
CREATE POLICY service_provider_requests_admin_select ON public.service_provider_requests FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY service_provider_requests_admin_update ON public.service_provider_requests FOR UPDATE TO authenticated USING (is_admin());

-- Table-level grants, mirroring organizer_requests' final grant state
-- (0012_fix_default_table_grants.sql) -- RLS policies alone don't grant
-- table privileges; anon/authenticated need this too, restricted in
-- practice by the policies above (an anon caller matches no policy here,
-- since every one requires TO authenticated).
GRANT DELETE, INSERT, SELECT, UPDATE ON public.service_provider_requests TO anon;
GRANT DELETE, INSERT, SELECT, UPDATE ON public.service_provider_requests TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.service_provider_requests TO project_admin;

-- Protects is_service_provider the exact same way check_user_role_update()
-- already protects `role` (0004_functions.sql) and protect_trust_signal_
-- columns() protects is_verified/vc_badge/vc_featured_until: a plain
-- authenticated client can never flip this column via a normal
-- UPDATE/upsert on users, no matter what RLS otherwise allows on that row
-- (the generic update_own_user policy is column-agnostic and would
-- otherwise let a user grant themselves this capability directly).
-- Deliberately a separate function from check_user_role_update() and
-- protect_trust_signal_columns() -- keeps this change fully isolated from
-- those already-audited functions, per "existing organizer functionality
-- must remain untouched".
CREATE OR REPLACE FUNCTION public.protect_capability_columns()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_user <> 'authenticated' THEN RETURN NEW; END IF;

  IF OLD.is_service_provider IS DISTINCT FROM NEW.is_service_provider THEN
    RAISE EXCEPTION 'is_service_provider can only be changed via admin_set_service_provider_capability()';
  END IF;

  RETURN NEW;
END;
$function$
;

-- Trigger functions still need an explicit EXECUTE grant for the roles
-- whose UPDATEs fire them -- mirrors check_user_role_update()'s own grant
-- immediately below its definition.
REVOKE ALL ON FUNCTION public.protect_capability_columns() FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.protect_capability_columns() TO anon, authenticated, project_admin;

CREATE TRIGGER trg_protect_capability_columns BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.protect_capability_columns();

-- The only sanctioned write path for is_service_provider -- same shape as
-- admin_set_user_role() (0004_functions.sql): Super Admin only, audit
-- logged. Deliberately its own function rather than extending
-- admin_set_user_role(), so approving/revoking a capability can never be
-- confused with (or accidentally exercise) the role-change path.
CREATE OR REPLACE FUNCTION public.admin_set_service_provider_capability(p_user_id uuid, p_enabled boolean)
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

  SELECT is_service_provider INTO v_previous FROM public.users WHERE id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found: %', p_user_id;
  END IF;

  UPDATE public.users SET is_service_provider = p_enabled WHERE id = p_user_id;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (
    auth.uid(),
    'service_provider_capability_change',
    p_user_id,
    jsonb_build_object('previous', v_previous, 'new', p_enabled),
    public.actor_role()
  );
END;
$function$
;

REVOKE ALL ON FUNCTION public.admin_set_service_provider_capability(p_user_id uuid, p_enabled boolean) FROM PUBLIC, anon, authenticated, project_admin;
GRANT EXECUTE ON FUNCTION public.admin_set_service_provider_capability(p_user_id uuid, p_enabled boolean) TO authenticated, project_admin;
