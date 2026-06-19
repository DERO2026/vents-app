-- Item 4: Soft-delete for admin event removal.
-- Events are hidden (not deleted), preserving all data. Admin can reinstate.

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS hidden_by_admin boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hidden_at       timestamptz,
  ADD COLUMN IF NOT EXISTS hidden_by       uuid REFERENCES public.users(id);

-- Index for fast filtering of hidden events in public feeds.
CREATE INDEX IF NOT EXISTS idx_events_hidden ON public.events (hidden_by_admin)
  WHERE hidden_by_admin = false;

-- admin_hide_event: marks an event as hidden from all public views.
CREATE OR REPLACE FUNCTION public.admin_hide_event(
  p_event_id uuid,
  p_reason   text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role text;
BEGIN
  SELECT role INTO v_caller_role FROM public.users WHERE id = auth.uid();
  IF v_caller_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only admins can hide events';
  END IF;

  UPDATE public.events
  SET hidden_by_admin = true,
      hidden_at       = now(),
      hidden_by       = auth.uid()
  WHERE id = p_event_id;

  INSERT INTO public.admin_logs (admin_id, action, details)
  VALUES (
    auth.uid(),
    'hide_event',
    jsonb_build_object('event_id', p_event_id, 'reason', p_reason)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_hide_event(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_hide_event(uuid, text) TO authenticated;

-- admin_reinstate_event: restores a hidden event to all public views.
CREATE OR REPLACE FUNCTION public.admin_reinstate_event(p_event_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role text;
BEGIN
  SELECT role INTO v_caller_role FROM public.users WHERE id = auth.uid();
  IF v_caller_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Only admins can reinstate events';
  END IF;

  UPDATE public.events
  SET hidden_by_admin = false,
      hidden_at       = NULL,
      hidden_by       = NULL
  WHERE id = p_event_id;

  INSERT INTO public.admin_logs (admin_id, action, details)
  VALUES (
    auth.uid(),
    'reinstate_event',
    jsonb_build_object('event_id', p_event_id)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_reinstate_event(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_reinstate_event(uuid) TO authenticated;
