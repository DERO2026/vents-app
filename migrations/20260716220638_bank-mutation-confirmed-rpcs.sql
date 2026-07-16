-- Bank-mutation RPCs, redesigned to enforce the password gate at the DB layer
-- WITHOUT a service/admin key (the Vercel serverless functions only ever
-- forward the caller's own token — there is no admin key in that env).
--
-- The gate: the wallet endpoints re-verify the organizer's password via
-- InsForge sign-in, which returns a FRESH access token. They call these RPCs
-- with that fresh token. Each RPC requires the JWT's `iat` (issued-at) to be
-- recent — a token that fresh can only be obtained by proving the password
-- (or biometric that unlocks the same sign-in). The organizer's normal
-- long-lived session token has an old `iat` and is rejected, so calling the
-- RPC directly via PostgREST cannot bypass the gate. Ownership is always
-- auth.uid() (never a caller-supplied id).

-- Drop the admin-key variants from the previous migration (unusable — no
-- admin key exists server-side).
DROP FUNCTION IF EXISTS public.admin_add_bank_account(uuid, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.admin_set_default_bank_account(uuid, uuid);
DROP FUNCTION IF EXISTS public.admin_remove_bank_account(uuid, uuid);

-- Proof-of-recent-auth: raises unless the calling JWT was issued in the last
-- 5 minutes (generous window absorbs clock skew; the endpoint mints the token
-- moments before calling).
CREATE OR REPLACE FUNCTION public.assert_recent_auth()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_iat bigint;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  BEGIN
    v_iat := (auth.jwt() ->> 'iat')::bigint;
  EXCEPTION WHEN others THEN v_iat := NULL; END;
  IF v_iat IS NULL OR (extract(epoch FROM now())::bigint - v_iat) > 300 THEN
    RAISE EXCEPTION 'PASSWORD_CONFIRMATION_REQUIRED';
  END IF;
END; $function$;
REVOKE ALL ON FUNCTION public.assert_recent_auth() FROM public;
GRANT EXECUTE ON FUNCTION public.assert_recent_auth() TO authenticated;

-- Add / edit (upsert on the organizer's own account_number).
CREATE OR REPLACE FUNCTION public.add_bank_account_confirmed(
  p_bank_name text, p_bank_code text, p_account_number text,
  p_account_name text, p_recipient_code text
) RETURNS public.organizer_bank_accounts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_uid uuid := auth.uid(); v_row public.organizer_bank_accounts; v_has_default boolean;
BEGIN
  PERFORM public.assert_recent_auth();
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = v_uid AND email_verified) THEN
    RAISE EXCEPTION 'Please verify your email first';
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.organizer_bank_accounts
                 WHERE organizer_id = v_uid AND is_default) INTO v_has_default;
  INSERT INTO public.organizer_bank_accounts
    (organizer_id, bank_name, bank_code, account_number, account_name, recipient_code, is_default, updated_at)
  VALUES
    (v_uid, p_bank_name, p_bank_code, p_account_number, p_account_name, p_recipient_code, NOT v_has_default, now())
  ON CONFLICT (organizer_id, account_number) DO UPDATE SET
    bank_name = EXCLUDED.bank_name, bank_code = EXCLUDED.bank_code,
    account_name = EXCLUDED.account_name, recipient_code = EXCLUDED.recipient_code,
    updated_at = now()
  RETURNING * INTO v_row;
  RETURN v_row;
END; $function$;

CREATE OR REPLACE FUNCTION public.set_default_bank_account_confirmed(p_account_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_uid uuid := auth.uid();
BEGIN
  PERFORM public.assert_recent_auth();
  IF NOT EXISTS (SELECT 1 FROM public.organizer_bank_accounts
                 WHERE id = p_account_id AND organizer_id = v_uid) THEN
    RAISE EXCEPTION 'Bank account not found';
  END IF;
  UPDATE public.organizer_bank_accounts SET is_default = false, updated_at = now()
  WHERE organizer_id = v_uid AND is_default AND id <> p_account_id;
  UPDATE public.organizer_bank_accounts SET is_default = true, updated_at = now()
  WHERE id = p_account_id;
END; $function$;

CREATE OR REPLACE FUNCTION public.remove_bank_account_confirmed(p_account_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_uid uuid := auth.uid(); v_was_default boolean; v_next uuid;
BEGIN
  PERFORM public.assert_recent_auth();
  SELECT is_default INTO v_was_default FROM public.organizer_bank_accounts
  WHERE id = p_account_id AND organizer_id = v_uid;
  IF v_was_default IS NULL THEN RAISE EXCEPTION 'Bank account not found'; END IF;
  DELETE FROM public.organizer_bank_accounts WHERE id = p_account_id AND organizer_id = v_uid;
  IF v_was_default THEN
    SELECT id INTO v_next FROM public.organizer_bank_accounts
    WHERE organizer_id = v_uid ORDER BY created_at DESC LIMIT 1;
    IF v_next IS NOT NULL THEN
      UPDATE public.organizer_bank_accounts SET is_default = true, updated_at = now() WHERE id = v_next;
    END IF;
  END IF;
END; $function$;

REVOKE ALL ON FUNCTION public.add_bank_account_confirmed(text, text, text, text, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.set_default_bank_account_confirmed(uuid) FROM public, anon;
REVOKE ALL ON FUNCTION public.remove_bank_account_confirmed(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.add_bank_account_confirmed(text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_default_bank_account_confirmed(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_bank_account_confirmed(uuid) TO authenticated;
