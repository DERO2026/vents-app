# Pre-migration state capture: 0170 (F15/F16)

Captured read-only, live, immediately before applying
`0170_drop_legacy_vc_rpc_overloads_and_harden_anon_grants.sql`.
**This file is a report + restore script for manual use if a rollback is
ever needed — nothing in it is executed automatically, and it is not a
migration (not named `NNNN_*.sql`, not in `supabase/migrations/`, so
`supabase db push` will never pick it up).**

- Captured: 2026-10-14, against project `slrtjxtzhowhwhebjprv` ("VENTS").
- Main at commit `dcb21118bb659787cb73f474c5387a34faef21b8` (PR #23 merged; migration 0170 committed, **not yet applied**).

## 1. Function ownership (unchanged by 0170 — recorded for completeness)

All functions below are owned by `postgres`, consistent across every
function checked (`approve_admin_action`, both old overloads, both new
signatures, `admin_get_user_vc_summary`, `admin_get_vc_pool_status`,
`_vc_deduct`, `_vc_pool_move`). 0170 does not change ownership.

## 2. Grants, before 0170 (live, read-only query)

| Function | anon EXECUTE | authenticated EXECUTE | project_admin EXECUTE |
|---|---|---|---|
| `approve_admin_action(uuid)` | false | true | true |
| `admin_credit_vents_cents(uuid, numeric, text)` (OLD, about to be dropped) | false | true | true |
| `admin_debit_vents_cents(uuid, integer, text)` (OLD, about to be dropped) | false | true | true |
| `admin_credit_vents_cents(uuid, numeric, text, boolean, uuid)` (NEW) | **true** → 0170 revokes | true | true |
| `admin_debit_vents_cents(uuid, integer, text, uuid)` (NEW) | **true** → 0170 revokes | true | true |
| `admin_get_user_vc_summary(uuid)` | **true** → 0170 revokes | true | true |
| `admin_get_vc_pool_status()` | **true** → 0170 revokes | true | true |
| `_vc_deduct(uuid, integer, text)` (called by the OLD debit overload) | false | false | true |
| `_vc_pool_move(text, numeric, uuid, uuid, text, uuid)` | true (pre-existing, **outside 0170's scope** — not touched, not part of F16) | true | true |

## 3. Exact live definitions before drop (verbatim `pg_get_functiondef` output)

### `approve_admin_action(uuid)` — BEFORE (still calls the OLD 3-arg overloads)

```sql
CREATE OR REPLACE FUNCTION public.approve_admin_action(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  r public.admin_action_requests;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required (your role: %)', COALESCE((SELECT role FROM public.users WHERE id = auth.uid()),'none');
  END IF;

  SELECT * INTO r FROM public.admin_action_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'Request already %', r.status; END IF;

  IF r.requested_by = auth.uid() THEN
    RAISE EXCEPTION 'Cannot approve your own request';
  END IF;

  CASE r.action_type
    WHEN 'organizer_verification_approve' THEN PERFORM public.admin_approve_organizer_verification((r.payload->>'request_id')::uuid);
    WHEN 'organizer_verification_reject'  THEN PERFORM public.admin_reject_organizer_verification((r.payload->>'request_id')::uuid, r.payload->>'reason');
    WHEN 'hide_event'             THEN PERFORM public.admin_hide_event(r.target_id, r.payload->>'reason');
    WHEN 'reinstate_event'        THEN PERFORM public.admin_reinstate_event(r.target_id);
    WHEN 'soft_delete_event'      THEN PERFORM public.soft_delete_event(r.target_id, r.payload->>'reason');
    WHEN 'restore_deleted_event'  THEN PERFORM public.admin_restore_deleted_event(r.target_id);
    WHEN 'restore_event'          THEN PERFORM public.admin_restore_deleted_event(r.target_id);
    WHEN 'set_user_role'          THEN PERFORM public.admin_set_user_role(r.target_id, r.payload->>'new_role');
    WHEN 'suspend_user'           THEN PERFORM public.admin_suspend_user(r.target_id, NULLIF(r.payload->>'banned_until','')::timestamptz, r.payload->>'reason');
    WHEN 'unsuspend_user'         THEN PERFORM public.admin_unsuspend_user(r.target_id);
    WHEN 'soft_delete_user'       THEN PERFORM public.admin_soft_delete_user(r.target_id, r.payload->>'reason');
    WHEN 'reinstate_user'         THEN PERFORM public.admin_reinstate_user(r.target_id);
    WHEN 'toggle_user_verified'   THEN PERFORM public.admin_toggle_user_verified(r.target_id, (r.payload->>'verified')::boolean, r.payload->>'reason');
    WHEN 'credit_vents_cents'     THEN PERFORM public.admin_credit_vents_cents(r.target_id, (r.payload->>'amount')::numeric, r.payload->>'reason');
    WHEN 'debit_vents_cents'      THEN PERFORM public.admin_debit_vents_cents(r.target_id, (r.payload->>'amount')::integer, r.payload->>'reason');
    WHEN 'approve_payout'         THEN PERFORM public.admin_mark_payout_processing((r.payload->>'request_id')::uuid, r.payload->>'paystack_reference', r.payload->>'transfer_code');
    WHEN 'reject_payout'          THEN PERFORM public.admin_reject_organizer_payout((r.payload->>'request_id')::uuid, r.payload->>'reason');
    WHEN 'cancel_payout'          THEN PERFORM public.admin_cancel_processing_payout((r.payload->>'request_id')::uuid, r.payload->>'reason');
    WHEN 'toggle_event_featured'  THEN PERFORM public.admin_set_event_featured(
                                      r.target_id,
                                      COALESCE((r.payload->>'featured')::boolean, false),
                                      COALESCE((r.payload->>'duration_days')::integer, 14));
    WHEN 'decide_organizer_request' THEN PERFORM public.admin_decide_organizer_request(
                                      (r.payload->>'request_id')::uuid,
                                      COALESCE((r.payload->>'approve')::boolean, false),
                                      r.payload->>'reason');
    WHEN 'decide_service_provider_request' THEN PERFORM public.admin_decide_service_provider_request(
                                      (r.payload->>'request_id')::uuid,
                                      r.payload->>'status',
                                      r.payload->>'admin_note');
    ELSE RAISE EXCEPTION 'No executor mapped for action_type: %', r.action_type;
  END CASE;

  UPDATE public.admin_action_requests
     SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), seen_at = COALESCE(seen_at, now())
   WHERE id = p_request_id RETURNING * INTO r;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'action_approved', CASE WHEN r.target_type = 'user' THEN r.target_id ELSE NULL END,
          jsonb_build_object('request_id', r.id, 'action_type', r.action_type, 'requested_by', r.requested_by,
                             'target_label', r.target_label, 'reviewer_ip', public.client_ip(),
                             'previous_values', r.previous_values, 'requested_changes', r.requested_changes),
          public.actor_role());

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (r.requested_by, 'broadcast', 'Your request has been approved',
          format('Your request (%s) was approved and executed.', COALESCE(r.target_label, r.action_type)), false, '✅');

  RETURN to_jsonb(r);
END; $function$;
```

### `admin_credit_vents_cents(uuid, numeric, text)` — OLD, about to be `DROP`ped

```sql
CREATE OR REPLACE FUNCTION public.admin_credit_vents_cents(p_user_id uuid, p_amount numeric, p_reason text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot credit your own Vents Cents balance';
  END IF;

  IF p_amount <= 0 THEN
    RETURN 'invalid_amount';
  END IF;

  INSERT INTO public.vc_transactions (user_id, amount, type, status, reference_id, earned_at)
  VALUES (p_user_id, p_amount::integer, 'earn', 'active', gen_random_uuid(), now());

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (
    p_user_id,
    'promo',
    'Vents Cents Credited',
    p_amount || ' Vents Cents have been added to your wallet. Reason: ' || p_reason,
    false,
    '🪙'
  );

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'admin_vc_credit', p_user_id, jsonb_build_object('amount', p_amount, 'reason', p_reason), public.actor_role());

  RETURN 'ok';
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_credit_vents_cents(uuid, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_credit_vents_cents(uuid, numeric, text) TO authenticated, project_admin;
```

### `admin_debit_vents_cents(uuid, integer, text)` — OLD, about to be `DROP`ped

```sql
CREATE OR REPLACE FUNCTION public.admin_debit_vents_cents(p_user_id uuid, p_amount integer, p_reason text DEFAULT 'Admin debit'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_balance integer;
BEGIN
  IF NOT public.is_admin_or_root() THEN
    RAISE EXCEPTION 'Super Admin access required';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot debit your own Vents Cents balance';
  END IF;

  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;

  PERFORM public._vc_deduct(p_user_id, p_amount, p_reason);

  SELECT balance INTO v_balance FROM public.vents_wallets WHERE user_id = p_user_id;

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (
    p_user_id,
    'promo',
    'Vents Cents Adjusted',
    p_amount || ' Vents Cents have been removed from your wallet. Reason: ' || p_reason,
    false,
    '🪙'
  );

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'admin_vc_debit', p_user_id, jsonb_build_object('amount', p_amount, 'reason', p_reason), public.actor_role());

  RETURN jsonb_build_object('debited', p_amount, 'target_balance', v_balance);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_debit_vents_cents(uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_debit_vents_cents(uuid, integer, text) TO authenticated, project_admin;
```

**Note:** the exact `REVOKE ALL`/`GRANT` lines above for the two old
overloads are reconstructed from the grant table in section 2 (`anon:
false`, `authenticated: true`, `project_admin: true`) — this matches the
same `REVOKE ALL ... GRANT ... TO authenticated, project_admin` pattern
used elsewhere in this schema (e.g. `0172`'s own backfill functions), not
a literal captured statement (Postgres doesn't store grant statements as
text — only the resulting ACL, which is what section 2's table reflects
exactly).

## 4. Dependency check (live, read-only)

- `pg_depend` search for formal dependencies on either old overload: **zero rows** — no view, default expression, or other catalog-tracked object depends on them.
- Full-text search of every function body in `pg_proc` (`prosrc ILIKE '%admin_credit_vents_cents%'` / `'%admin_debit_vents_cents%'`) for any caller: **exactly one match — `approve_admin_action`**, the function 0170 repoints in the same transaction before dropping the old overloads. No other database function calls either old signature.
- Client-side (`src/`, `api/`) grep for either old signature: **zero matches** (confirmed in an earlier audit pass; `AdminVCScreen.tsx` only ever calls the NEW 5-arg/4-arg signatures by named parameter, which PostgREST can only resolve to the new overloads).
- **Conclusion: dropping both old overloads is safe. No live dependency exists that migration 0170 does not already handle in the same transaction.**

## 5. VC pool accounting, before 0170 (live, read-only — for post-migration comparison)

| Metric | Value |
|---|---|
| `vc_system_pool.balance` | `899401160` |
| `vc_pool_ledger` row count | `2` |
| Total credited (`direction='credit'`) | `0` |
| Total debited (`direction='debit'`) | `100598840` |
| `admin_action_requests` rows with `action_type IN ('credit_vents_cents','debit_vents_cents')` | `0` |

Invariant check: `1,000,000,000 − 100,598,840 + 0 = 899,401,160` ✓ — matches
`vc_system_pool.balance` exactly. **0170 does not touch any of these
numbers** (it changes code paths and grants only) — this table exists
purely so a post-migration re-run of the same query can be diffed against
it to prove nothing moved.

## 6. Restore script (NOT executed — for manual use only, if ever needed)

```sql
-- ============================================================
-- MANUAL ROLLBACK OF 0170 — DO NOT RUN UNLESS EXPLICITLY DECIDED
-- Restores the exact pre-0170 state captured above.
-- ============================================================

-- Step 1: restore approve_admin_action to call the OLD 3-arg overloads
-- (only possible/needed if Step 2 below has NOT yet been run, since this
-- function's old body depends on the old overloads existing).
CREATE OR REPLACE FUNCTION public.approve_admin_action(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  r public.admin_action_requests;
BEGIN
  IF NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Super Admin access required (your role: %)', COALESCE((SELECT role FROM public.users WHERE id = auth.uid()),'none');
  END IF;

  SELECT * INTO r FROM public.admin_action_requests WHERE id = p_request_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'Request already %', r.status; END IF;

  IF r.requested_by = auth.uid() THEN
    RAISE EXCEPTION 'Cannot approve your own request';
  END IF;

  CASE r.action_type
    WHEN 'organizer_verification_approve' THEN PERFORM public.admin_approve_organizer_verification((r.payload->>'request_id')::uuid);
    WHEN 'organizer_verification_reject'  THEN PERFORM public.admin_reject_organizer_verification((r.payload->>'request_id')::uuid, r.payload->>'reason');
    WHEN 'hide_event'             THEN PERFORM public.admin_hide_event(r.target_id, r.payload->>'reason');
    WHEN 'reinstate_event'        THEN PERFORM public.admin_reinstate_event(r.target_id);
    WHEN 'soft_delete_event'      THEN PERFORM public.soft_delete_event(r.target_id, r.payload->>'reason');
    WHEN 'restore_deleted_event'  THEN PERFORM public.admin_restore_deleted_event(r.target_id);
    WHEN 'restore_event'          THEN PERFORM public.admin_restore_deleted_event(r.target_id);
    WHEN 'set_user_role'          THEN PERFORM public.admin_set_user_role(r.target_id, r.payload->>'new_role');
    WHEN 'suspend_user'           THEN PERFORM public.admin_suspend_user(r.target_id, NULLIF(r.payload->>'banned_until','')::timestamptz, r.payload->>'reason');
    WHEN 'unsuspend_user'         THEN PERFORM public.admin_unsuspend_user(r.target_id);
    WHEN 'soft_delete_user'       THEN PERFORM public.admin_soft_delete_user(r.target_id, r.payload->>'reason');
    WHEN 'reinstate_user'         THEN PERFORM public.admin_reinstate_user(r.target_id);
    WHEN 'toggle_user_verified'   THEN PERFORM public.admin_toggle_user_verified(r.target_id, (r.payload->>'verified')::boolean, r.payload->>'reason');
    WHEN 'credit_vents_cents'     THEN PERFORM public.admin_credit_vents_cents(r.target_id, (r.payload->>'amount')::numeric, r.payload->>'reason');
    WHEN 'debit_vents_cents'      THEN PERFORM public.admin_debit_vents_cents(r.target_id, (r.payload->>'amount')::integer, r.payload->>'reason');
    WHEN 'approve_payout'         THEN PERFORM public.admin_mark_payout_processing((r.payload->>'request_id')::uuid, r.payload->>'paystack_reference', r.payload->>'transfer_code');
    WHEN 'reject_payout'          THEN PERFORM public.admin_reject_organizer_payout((r.payload->>'request_id')::uuid, r.payload->>'reason');
    WHEN 'cancel_payout'          THEN PERFORM public.admin_cancel_processing_payout((r.payload->>'request_id')::uuid, r.payload->>'reason');
    WHEN 'toggle_event_featured'  THEN PERFORM public.admin_set_event_featured(
                                      r.target_id,
                                      COALESCE((r.payload->>'featured')::boolean, false),
                                      COALESCE((r.payload->>'duration_days')::integer, 14));
    WHEN 'decide_organizer_request' THEN PERFORM public.admin_decide_organizer_request(
                                      (r.payload->>'request_id')::uuid,
                                      COALESCE((r.payload->>'approve')::boolean, false),
                                      r.payload->>'reason');
    WHEN 'decide_service_provider_request' THEN PERFORM public.admin_decide_service_provider_request(
                                      (r.payload->>'request_id')::uuid,
                                      r.payload->>'status',
                                      r.payload->>'admin_note');
    ELSE RAISE EXCEPTION 'No executor mapped for action_type: %', r.action_type;
  END CASE;

  UPDATE public.admin_action_requests
     SET status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), seen_at = COALESCE(seen_at, now())
   WHERE id = p_request_id RETURNING * INTO r;

  INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
  VALUES (auth.uid(), 'action_approved', CASE WHEN r.target_type = 'user' THEN r.target_id ELSE NULL END,
          jsonb_build_object('request_id', r.id, 'action_type', r.action_type, 'requested_by', r.requested_by,
                             'target_label', r.target_label, 'reviewer_ip', public.client_ip(),
                             'previous_values', r.previous_values, 'requested_changes', r.requested_changes),
          public.actor_role());

  INSERT INTO public.notifications (user_id, type, title, body, read, icon)
  VALUES (r.requested_by, 'broadcast', 'Your request has been approved',
          format('Your request (%s) was approved and executed.', COALESCE(r.target_label, r.action_type)), false, '✅');

  RETURN to_jsonb(r);
END; $function$;

-- Step 2: re-create the two dropped overloads EXACTLY as captured in
-- section 3 above (verbatim CREATE OR REPLACE + REVOKE/GRANT blocks).
-- Only needed if the DROP FUNCTION statements were actually reached.
-- [See section 3 above for the full CREATE OR REPLACE + REVOKE/GRANT text
--  for both admin_credit_vents_cents(uuid, numeric, text) and
--  admin_debit_vents_cents(uuid, integer, text) — not duplicated here to
--  avoid a second, driftable copy of the same statements in this file.]

-- Step 3: restore anon EXECUTE on the four functions 0170 revokes
-- (reversible, independent of Steps 1-2).
GRANT EXECUTE ON FUNCTION public.admin_credit_vents_cents(uuid, numeric, text, boolean, uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_debit_vents_cents(uuid, integer, text, uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_get_user_vc_summary(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_get_vc_pool_status() TO anon;
```

**Rollback limitation, stated plainly:** Steps 1 and 3 are simple,
low-risk, and exactly reverse what 0170 changes. **Step 2 is the real
risk** — once `DROP FUNCTION` has actually run, re-creating the old
overloads from this file restores the *code*, but if `approve_admin_action`
ran against the *new* code in the meantime (crediting/debiting through
the new signatures with real pool accounting), a rollback of the function
code does **not** undo any pool-ledger rows that were written in that
window. A rollback is a code revert, not an undo of any real financial
activity that happened on the new code path.
