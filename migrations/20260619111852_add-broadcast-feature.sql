-- Broadcast feature: admin sends a notification to all non-admin users
-- Writes to notifications table for each target user

CREATE OR REPLACE FUNCTION public.admin_send_broadcast(
  p_title text,
  p_body  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_id uuid;
  v_count    int;
BEGIN
  -- Only admins may call this
  v_admin_id := auth.uid();
  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = v_admin_id AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Only admins can send broadcasts';
  END IF;

  -- Insert one notification row per non-admin user
  INSERT INTO public.notifications (id, user_id, type, title, body, read, icon, created_at)
  SELECT
    gen_random_uuid(),
    u.id,
    'broadcast',
    p_title,
    p_body,
    false,
    '📢',
    now()
  FROM public.users u
  WHERE u.role <> 'admin';

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Log the broadcast in admin_logs
  INSERT INTO public.admin_logs (id, admin_id, action, target_type, details, created_at)
  VALUES (
    gen_random_uuid(),
    v_admin_id,
    'broadcast_sent',
    'all_users',
    jsonb_build_object('title', p_title, 'body', p_body, 'recipients', v_count),
    now()
  );

  RETURN jsonb_build_object('success', true, 'recipients', v_count);
END;
$$;

-- Grant execute to authenticated users (RPC enforces admin check internally)
GRANT EXECUTE ON FUNCTION public.admin_send_broadcast(text, text) TO authenticated;
