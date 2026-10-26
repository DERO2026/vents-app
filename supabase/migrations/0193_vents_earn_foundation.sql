-- VENTS Earn Stage 1: recruiter/marketer partnership foundation.
--
-- Scope: schema + invite/accept-decline functions only. Does NOT compute
-- or pay any commission (that's Stage 2+), does NOT touch
-- confirm_ticket_payment / credit_organizer_wallet / refund_ticket /
-- finalize_ticket_refund, and does NOT touch migration 0192 or any
-- payment-processing behavior. This is purely additive.
--
-- Business rules encoded here, structurally (not just in application code):
--   1. A partnership becomes 'accepted' only via
--      respond_to_recruiter_invitation, which is SECURITY DEFINER and
--      checks auth.uid() against the ORGANIZER/PROVIDER side of the
--      partnership (events.organizer_id or service_providers.user_id).
--      There is no function, grant, or RLS policy anywhere in this file
--      that lets the recruiter's own auth.uid() satisfy that check --
--      recruiter_id and the responder identity are always compared, never
--      conflated. Self-approval is therefore impossible by construction:
--      a recruiter calling respond_to_recruiter_invitation on their own
--      invitation fails the ownership check and raises.
--   2. commission_split_bps is proposed by the recruiter at invite time
--      and can only be set to a FINAL agreed value by the accept call
--      (the organizer/provider implicitly agrees by accepting at the
--      proposed rate; a future Stage adds counter-offer support if
--      needed -- out of scope here). It is capped at 10000 bps (100%) of
--      the recruiter's OWN commission, never of the organizer/provider's
--      revenue or VENTS' platform fee -- see the ledger-design comment
--      in the Stage 2+ roadmap (reported separately, not implemented
--      here) for how this avoids inflating total commission liability.

-- 1. recruiters -------------------------------------------------------

CREATE TABLE public.recruiters (
  id            uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  display_name  text,
  bio           text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON public.recruiters FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.recruiters TO authenticated;

ALTER TABLE public.recruiters ENABLE ROW LEVEL SECURITY;

CREATE POLICY recruiters_select_own ON public.recruiters
  FOR SELECT TO authenticated
  USING (id = auth.uid());

-- recruiters_select_partner (letting a partnered organizer/provider see
-- the recruiter's profile) is created further below, AFTER
-- recruiter_partnerships exists -- Postgres validates a policy's USING
-- expression against real tables/columns at CREATE POLICY time, so it
-- cannot reference recruiter_partnerships before that table exists.

CREATE POLICY recruiters_admin_select ON public.recruiters
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- Recruiters are self-registered (becoming a recruiter requires no
-- organizer/provider approval -- only forming a PARTNERSHIP does).
CREATE OR REPLACE FUNCTION public.register_as_recruiter(p_display_name text, p_bio text DEFAULT NULL)
 RETURNS public.recruiters
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.recruiters;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  INSERT INTO public.recruiters (id, display_name, bio)
  VALUES (v_uid, NULLIF(trim(p_display_name), ''), NULLIF(trim(p_bio), ''))
  ON CONFLICT (id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        bio           = EXCLUDED.bio,
        updated_at    = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$;

REVOKE ALL ON FUNCTION public.register_as_recruiter(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_as_recruiter(text, text) TO authenticated;

-- 2. recruiter_partnerships -------------------------------------------
--
-- Exactly one of (organizer_id-via-event, provider_id) is populated per
-- row -- modeled as a nullable provider_id plus a representative
-- organizer_id column (direct, not "via one event") so the relationship
-- is organizer-wide, not event-specific. organizer_event_sample_id in
-- the recruiters policy above is removed in favor of a direct
-- organizer_id column for clarity -- see table below.

CREATE TABLE public.recruiter_partnerships (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recruiter_id         uuid NOT NULL REFERENCES public.recruiters(id) ON DELETE CASCADE,
  organizer_id         uuid REFERENCES public.users(id) ON DELETE CASCADE,
  provider_id          uuid REFERENCES public.service_providers(id) ON DELETE CASCADE,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),
  commission_split_bps integer NOT NULL CHECK (commission_split_bps >= 0 AND commission_split_bps <= 10000),
  invited_at           timestamptz NOT NULL DEFAULT now(),
  responded_at         timestamptz,
  responded_by         uuid REFERENCES public.users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recruiter_partnerships_one_side_only CHECK (
    (organizer_id IS NOT NULL AND provider_id IS NULL) OR
    (organizer_id IS NULL AND provider_id IS NOT NULL)
  ),
  -- responded_at/responded_by are only ever set by the accept/decline
  -- function below, never by a direct client UPDATE (no UPDATE grant is
  -- given to 'authenticated' -- see grants below). This CHECK is a
  -- second, redundant line of defense: a 'pending' row can never already
  -- carry a responder.
  CONSTRAINT recruiter_partnerships_response_consistency CHECK (
    (status = 'pending' AND responded_at IS NULL AND responded_by IS NULL) OR
    (status <> 'pending' AND responded_at IS NOT NULL AND responded_by IS NOT NULL)
  )
);

-- Now that recruiter_partnerships exists, add the deferred policy
-- letting a partnered organizer/provider read the recruiter's profile.
CREATE POLICY recruiters_select_partner ON public.recruiters
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.recruiter_partnerships rp
      WHERE rp.recruiter_id = recruiters.id
        AND (
          rp.organizer_id = auth.uid()
          OR EXISTS (SELECT 1 FROM public.service_providers sp WHERE sp.id = rp.provider_id AND sp.user_id = auth.uid())
        )
    )
  );

-- Idempotent invitations: at most one PENDING invite per
-- (recruiter, organizer) or (recruiter, provider) pair at a time. A
-- declined/revoked row doesn't block a fresh invite (partial index
-- scoped to status='pending').
CREATE UNIQUE INDEX recruiter_partnerships_pending_organizer_uidx
  ON public.recruiter_partnerships (recruiter_id, organizer_id)
  WHERE status = 'pending' AND organizer_id IS NOT NULL;

CREATE UNIQUE INDEX recruiter_partnerships_pending_provider_uidx
  ON public.recruiter_partnerships (recruiter_id, provider_id)
  WHERE status = 'pending' AND provider_id IS NOT NULL;

CREATE INDEX recruiter_partnerships_recruiter_idx ON public.recruiter_partnerships (recruiter_id);
CREATE INDEX recruiter_partnerships_organizer_idx ON public.recruiter_partnerships (organizer_id) WHERE organizer_id IS NOT NULL;
CREATE INDEX recruiter_partnerships_provider_idx ON public.recruiter_partnerships (provider_id) WHERE provider_id IS NOT NULL;

REVOKE ALL ON public.recruiter_partnerships FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.recruiter_partnerships TO authenticated;
-- No INSERT/UPDATE grant to authenticated: all writes go through the
-- two SECURITY DEFINER functions below, which perform their own
-- authorization checks independent of RLS.

ALTER TABLE public.recruiter_partnerships ENABLE ROW LEVEL SECURITY;

CREATE POLICY recruiter_partnerships_select_recruiter ON public.recruiter_partnerships
  FOR SELECT TO authenticated
  USING (recruiter_id = auth.uid());

CREATE POLICY recruiter_partnerships_select_organizer ON public.recruiter_partnerships
  FOR SELECT TO authenticated
  USING (organizer_id = auth.uid());

CREATE POLICY recruiter_partnerships_select_provider ON public.recruiter_partnerships
  FOR SELECT TO authenticated
  USING (
    provider_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.service_providers sp WHERE sp.id = recruiter_partnerships.provider_id AND sp.user_id = auth.uid())
  );

CREATE POLICY recruiter_partnerships_admin_select ON public.recruiter_partnerships
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- 3. Invite: callable only by the recruiter side. ----------------------

CREATE OR REPLACE FUNCTION public.invite_recruiter_partnership(
  p_organizer_id uuid DEFAULT NULL,
  p_provider_id  uuid DEFAULT NULL,
  p_commission_split_bps integer DEFAULT 0
)
 RETURNS public.recruiter_partnerships
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.recruiter_partnerships;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.recruiters r WHERE r.id = v_uid AND r.status = 'active') THEN
    RAISE EXCEPTION 'Caller is not a registered, active recruiter';
  END IF;

  IF (p_organizer_id IS NULL) = (p_provider_id IS NULL) THEN
    RAISE EXCEPTION 'Exactly one of p_organizer_id or p_provider_id must be provided';
  END IF;

  IF p_commission_split_bps IS NULL OR p_commission_split_bps < 0 OR p_commission_split_bps > 10000 THEN
    RAISE EXCEPTION 'commission_split_bps must be between 0 and 10000';
  END IF;

  -- A recruiter cannot invite themselves as the organizer/provider side.
  IF p_organizer_id = v_uid THEN
    RAISE EXCEPTION 'Cannot form a partnership with yourself';
  END IF;
  IF p_provider_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.service_providers sp WHERE sp.id = p_provider_id AND sp.user_id = v_uid
  ) THEN
    RAISE EXCEPTION 'Cannot form a partnership with yourself';
  END IF;

  IF p_organizer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.events e WHERE e.organizer_id = p_organizer_id
  ) THEN
    RAISE EXCEPTION 'Target organizer not found';
  END IF;
  IF p_provider_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.service_providers sp WHERE sp.id = p_provider_id
  ) THEN
    RAISE EXCEPTION 'Target provider not found';
  END IF;

  PERFORM public.check_rate_limit('invite_recruiter_partnership:' || v_uid::text, 20, 3600);

  INSERT INTO public.recruiter_partnerships (recruiter_id, organizer_id, provider_id, commission_split_bps, status)
  VALUES (v_uid, p_organizer_id, p_provider_id, p_commission_split_bps, 'pending')
  RETURNING * INTO v_row;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (
    COALESCE(p_organizer_id, (SELECT sp.user_id FROM public.service_providers sp WHERE sp.id = p_provider_id)),
    'recruiter_invitation',
    'New VENTS Earn partnership invitation',
    'A recruiter wants to partner with you and share part of their commission.',
    false,
    '🤝',
    jsonb_build_object('partnershipId', v_row.id, 'recruiterId', v_uid, 'commissionSplitBps', p_commission_split_bps)
  );

  RETURN v_row;
END;
$function$;

REVOKE ALL ON FUNCTION public.invite_recruiter_partnership(uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invite_recruiter_partnership(uuid, uuid, integer) TO authenticated;

-- 4. Accept/decline: callable ONLY by the organizer/provider side. -----
--
-- This is the structural anti-self-approval control. The function
-- verifies auth.uid() against the row's organizer_id (direct equality)
-- or against service_providers.user_id for the provider side -- never
-- against recruiter_id. There is no code path, grant, or RLS policy in
-- this file that lets the recruiter satisfy this check for their own
-- invitation.

CREATE OR REPLACE FUNCTION public.respond_to_recruiter_invitation(p_partnership_id uuid, p_accept boolean)
 RETURNS public.recruiter_partnerships
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_partnership public.recruiter_partnerships;
  v_is_authorized_responder boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_partnership
    FROM public.recruiter_partnerships
   WHERE id = p_partnership_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Partnership not found';
  END IF;

  IF v_partnership.status <> 'pending' THEN
    RAISE EXCEPTION 'Partnership is not pending (status=%)', v_partnership.status;
  END IF;

  IF v_partnership.organizer_id IS NOT NULL THEN
    v_is_authorized_responder := (v_partnership.organizer_id = v_uid);
  ELSE
    v_is_authorized_responder := EXISTS (
      SELECT 1 FROM public.service_providers sp
      WHERE sp.id = v_partnership.provider_id AND sp.user_id = v_uid
    );
  END IF;

  -- The recruiter themselves is never an authorized responder, even if
  -- the above checks were somehow satisfied by a data anomaly -- belt
  -- and suspenders, since recruiter_id can never equal organizer_id or
  -- a provider's user_id by the invite function's own self-partnership
  -- guard, but this closes the gap if that invariant were ever violated
  -- by a future code path.
  IF v_uid = v_partnership.recruiter_id THEN
    RAISE EXCEPTION 'The recruiter cannot respond to their own invitation';
  END IF;

  IF NOT v_is_authorized_responder THEN
    RAISE EXCEPTION 'Not authorized to respond to this invitation';
  END IF;

  UPDATE public.recruiter_partnerships
     SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'declined' END,
         responded_at = now(),
         responded_by = v_uid,
         updated_at = now()
   WHERE id = p_partnership_id
  RETURNING * INTO v_partnership;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon, push_data)
  VALUES (
    v_partnership.recruiter_id,
    'recruiter_invitation_response',
    CASE WHEN p_accept THEN 'Partnership accepted!' ELSE 'Partnership declined' END,
    CASE WHEN p_accept
      THEN 'Your VENTS Earn partnership invitation was accepted.'
      ELSE 'Your VENTS Earn partnership invitation was declined.'
    END,
    false,
    CASE WHEN p_accept THEN '✅' ELSE '❌' END,
    jsonb_build_object('partnershipId', v_partnership.id)
  );

  RETURN v_partnership;
END;
$function$;

REVOKE ALL ON FUNCTION public.respond_to_recruiter_invitation(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.respond_to_recruiter_invitation(uuid, boolean) TO authenticated;

-- 5. Revocation: either side can end an ACCEPTED partnership. ----------
-- (Does not affect already-recorded historical commission entries --
-- that ledger is Stage 2+ and does not exist yet in this migration.)

CREATE OR REPLACE FUNCTION public.revoke_recruiter_partnership(p_partnership_id uuid)
 RETURNS public.recruiter_partnerships
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_partnership public.recruiter_partnerships;
  v_is_party boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_partnership
    FROM public.recruiter_partnerships
   WHERE id = p_partnership_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Partnership not found';
  END IF;

  IF v_partnership.status <> 'accepted' THEN
    RAISE EXCEPTION 'Only an accepted partnership can be revoked (status=%)', v_partnership.status;
  END IF;

  v_is_party := (v_uid = v_partnership.recruiter_id)
    OR (v_partnership.organizer_id = v_uid)
    OR EXISTS (SELECT 1 FROM public.service_providers sp WHERE sp.id = v_partnership.provider_id AND sp.user_id = v_uid)
    OR public.is_admin();

  IF NOT v_is_party THEN
    RAISE EXCEPTION 'Not authorized to revoke this partnership';
  END IF;

  UPDATE public.recruiter_partnerships
     SET status = 'revoked', updated_at = now()
   WHERE id = p_partnership_id
  RETURNING * INTO v_partnership;

  RETURN v_partnership;
END;
$function$;

REVOKE ALL ON FUNCTION public.revoke_recruiter_partnership(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_recruiter_partnership(uuid) TO authenticated;
