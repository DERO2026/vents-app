-- Fix broadcast function: correct admin_logs columns + create alias used by UI

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
  v_admin_id := auth.uid();
  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = v_admin_id AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Only admins can send broadcasts';
  END IF;

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

  INSERT INTO public.admin_logs (id, admin_id, action, target_user_id, details, created_at)
  VALUES (
    gen_random_uuid(),
    v_admin_id,
    'broadcast_sent',
    NULL,
    jsonb_build_object('title', p_title, 'body', p_body, 'recipients', v_count),
    now()
  );

  RETURN jsonb_build_object('success', true, 'recipients', v_count);
END;
$$;

-- Alias matching the UI's RPC call: admin_broadcast(p_title, p_body, p_type)
CREATE OR REPLACE FUNCTION public.admin_broadcast(
  p_title text,
  p_body  text,
  p_type  text DEFAULT 'announcement'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.admin_send_broadcast(p_title, p_body);
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_send_broadcast(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_broadcast(text, text, text) TO authenticated;
