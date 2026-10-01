-- Business decision locked in: enable first_ticket_purchase at its seeded
-- default of 100 VC, one-time per user. Uses the existing campaign-
-- management architecture (vc_reward_campaigns + award_vc_reward) -- no
-- new reward system. Already subject to the existing idempotency
-- (vc_transactions_earn_dedup_idx), per-user cap (cap_per_user = 1,
-- unchanged), refund/reversal (reverse_vc_reward, already wired into
-- refund_ticket/finalize_ticket_refund), and the fact that it only ever
-- fires from confirm_ticket_payment/confirm_ticket_payment_via_wallet on a
-- genuine first paid ticket -- never from signup/login/app-open.
UPDATE public.vc_reward_campaigns
SET enabled = true, updated_at = now()
WHERE key = 'first_ticket_purchase';

INSERT INTO public.admin_logs (admin_id, action, target_user_id, details, actor_role)
VALUES (
  NULL, 'vc_campaign_update', NULL,
  jsonb_build_object(
    'campaign_key', 'first_ticket_purchase',
    'reason', 'Business decision: enable first-ticket-purchase bonus at its seeded default (100 VC, one-time per user)',
    'old', jsonb_build_object('enabled', false),
    'new', jsonb_build_object('enabled', true, 'amount_vc', 100, 'cap_per_user', 1)
  ),
  'migration'
);
