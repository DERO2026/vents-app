-- Backend for the new in-app chat action menu's "Clear Chat" / "Delete
-- Chat" actions. Neither wipes the other party's copy of the messages —
-- this only records a per-user cutoff timestamp, so the conversation
-- (and its history before the cutoff) simply stops appearing in *this*
-- user's inbox/conversation view. A new incoming message after the cutoff
-- naturally brings the thread back into the inbox. "Block User" already
-- exists (block_user/unblock_user, migrations/20260710004704_*.sql).
CREATE TABLE IF NOT EXISTS public.conversation_clears (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  other_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  cleared_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, other_user_id)
);

ALTER TABLE public.conversation_clears ENABLE ROW LEVEL SECURITY;

CREATE POLICY cc_own ON public.conversation_clears
  FOR ALL USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversation_clears TO authenticated;

CREATE OR REPLACE FUNCTION public.clear_conversation(p_other_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  INSERT INTO public.conversation_clears (user_id, other_user_id, cleared_at)
  VALUES (auth.uid(), p_other_user_id, now())
  ON CONFLICT (user_id, other_user_id) DO UPDATE SET cleared_at = now();
END;
$function$;

GRANT EXECUTE ON FUNCTION public.clear_conversation(uuid) TO authenticated;
