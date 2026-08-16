-- RLS: ENABLE ROW LEVEL SECURITY per table, then every policy (84 policies
-- across 40 tables), verbatim from the live InsForge database. Two tables
-- (rate_limits, search_synonyms) intentionally have no RLS in the source
-- system — both are internal-only, never read/written directly by
-- anon/authenticated (accessed solely through SECURITY DEFINER RPCs) — this
-- matches current production behavior, not an oversight introduced here.
-- Policies call helper functions (is_admin(), is_root(), etc) — 0004 must
-- run before this file.

ALTER TABLE admin_action_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocked_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_clears ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE deleted_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE deleted_phones ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_fingerprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_push_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE direct_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_reminder_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE highlights ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizer_bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizer_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizer_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizer_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizer_verification_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizer_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizer_withdrawal_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE promo_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE referred_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_privacy_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE vc_bonuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE vc_event_boosts ENABLE ROW LEVEL SECURITY;
ALTER TABLE vc_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE vents_wallets ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_insert_logs ON admin_logs FOR INSERT TO authenticated WITH CHECK (is_admin());
CREATE POLICY admin_select_logs ON admin_logs FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY self_organizer_promotion_log ON admin_logs FOR INSERT TO authenticated WITH CHECK (((( SELECT auth.uid() AS uid) = admin_id) OR is_admin()));
CREATE POLICY app_config_read_all ON app_config FOR SELECT TO authenticated USING (true);
CREATE POLICY app_config_root_update ON app_config FOR UPDATE TO authenticated USING (is_root()) WITH CHECK (is_root());
CREATE POLICY blocked_users_own_delete ON blocked_users FOR DELETE TO public USING ((auth.uid() = blocker_id));
CREATE POLICY blocked_users_own_insert ON blocked_users FOR INSERT TO public WITH CHECK ((auth.uid() = blocker_id));
CREATE POLICY blocked_users_own_select ON blocked_users FOR SELECT TO public USING ((auth.uid() = blocker_id));
CREATE POLICY organizer_insert_checkins ON checkins FOR INSERT TO authenticated WITH CHECK ((event_id IN ( SELECT events.id
   FROM events
  WHERE (events.organizer_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY organizer_select_checkins ON checkins FOR SELECT TO authenticated USING (((event_id IN ( SELECT events.id
   FROM events
  WHERE (events.organizer_id = ( SELECT auth.uid() AS uid)))) OR (scanned_by = ( SELECT auth.uid() AS uid))));
CREATE POLICY owner_select_checkins ON checkins FOR SELECT TO authenticated USING ((ticket_id IN ( SELECT tickets.id
   FROM tickets
  WHERE (tickets.user_id = ( SELECT auth.uid() AS uid)))));
CREATE POLICY cc_own ON conversation_clears FOR ALL TO public USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));
CREATE POLICY conversation_requests_select ON conversation_requests FOR SELECT TO authenticated USING (((requester_id = auth.uid()) OR (recipient_id = auth.uid())));
CREATE POLICY admin_only ON deleted_emails FOR ALL TO authenticated USING (is_admin());
CREATE POLICY admin_only ON deleted_phones FOR ALL TO authenticated USING (is_admin());
CREATE POLICY dp_own ON device_fingerprints FOR ALL TO public USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY dm_delete ON direct_messages FOR DELETE TO authenticated USING ((( SELECT auth.uid() AS uid) = sender_id));
CREATE POLICY dm_select ON direct_messages FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) = sender_id) OR (( SELECT auth.uid() AS uid) = recipient_id)));
CREATE POLICY dm_update ON direct_messages FOR UPDATE TO authenticated USING (((( SELECT auth.uid() AS uid) = sender_id) OR (( SELECT auth.uid() AS uid) = recipient_id))) WITH CHECK (((( SELECT auth.uid() AS uid) = sender_id) OR (( SELECT auth.uid() AS uid) = recipient_id)));
CREATE POLICY delete_event_promotions ON event_promotions FOR DELETE TO authenticated USING ((organizer_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY insert_event_promotions ON event_promotions FOR INSERT TO authenticated WITH CHECK (((organizer_id = ( SELECT auth.uid() AS uid)) AND (event_id IN ( SELECT events.id
   FROM events
  WHERE (events.organizer_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY select_event_promotions ON event_promotions FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY update_event_promotions ON event_promotions FOR UPDATE TO authenticated USING ((organizer_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((organizer_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY delete_events ON events FOR DELETE TO public USING (((organizer_id = ( SELECT auth.uid() AS uid)) OR is_admin()));
CREATE POLICY insert_events ON events FOR INSERT TO public WITH CHECK (((auth.uid() = organizer_id) OR is_admin()));
CREATE POLICY select_events ON events FOR SELECT TO public USING (((deleted_at IS NULL) OR (organizer_id = ( SELECT auth.uid() AS uid)) OR is_admin()));
CREATE POLICY update_events ON events FOR UPDATE TO authenticated USING (((( SELECT auth.uid() AS uid) = organizer_id) OR is_admin())) WITH CHECK (((( SELECT auth.uid() AS uid) = organizer_id) OR is_admin()));
CREATE POLICY highlights_delete_own ON highlights FOR DELETE TO authenticated USING ((user_id = auth.uid()));
CREATE POLICY highlights_insert_own ON highlights FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));
CREATE POLICY highlights_select_auth ON highlights FOR SELECT TO authenticated USING (true);
CREATE POLICY media_delete_own ON media_assets FOR DELETE TO authenticated USING (((user_id = ( SELECT auth.uid() AS uid)) OR is_admin()));
CREATE POLICY media_insert_own ON media_assets FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY media_select_all ON media_assets FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY message_reactions_delete ON message_reactions FOR DELETE TO authenticated USING ((user_id = auth.uid()));
CREATE POLICY message_reactions_insert ON message_reactions FOR INSERT TO authenticated WITH CHECK (((user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM direct_messages dm
  WHERE ((dm.id = message_reactions.message_id) AND ((dm.sender_id = auth.uid()) OR (dm.recipient_id = auth.uid())))))));
CREATE POLICY message_reactions_select ON message_reactions FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM direct_messages dm
  WHERE ((dm.id = message_reactions.message_id) AND ((dm.sender_id = auth.uid()) OR (dm.recipient_id = auth.uid()))))));
CREATE POLICY delete_notifications ON notifications FOR DELETE TO public USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY insert_notifications ON notifications FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY select_notifications ON notifications FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY update_notifications ON notifications FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY org_bank_admin_read ON organizer_bank_accounts FOR SELECT TO public USING (is_admin());
CREATE POLICY org_bank_own ON organizer_bank_accounts FOR ALL TO authenticated USING ((( SELECT auth.uid() AS uid) = organizer_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = organizer_id));
CREATE POLICY organizer_requests_admin_select ON organizer_requests FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY organizer_requests_admin_update ON organizer_requests FOR UPDATE TO authenticated USING (is_admin());
CREATE POLICY organizer_requests_insert_own ON organizer_requests FOR INSERT TO authenticated WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY organizer_requests_select_own ON organizer_requests FOR SELECT TO authenticated USING (((( SELECT auth.uid() AS uid) = user_id) OR is_admin()));
CREATE POLICY organizer_reviews_delete ON organizer_reviews FOR DELETE TO authenticated USING ((( SELECT auth.uid() AS uid) = reviewer_id));
CREATE POLICY organizer_reviews_insert ON organizer_reviews FOR INSERT TO authenticated WITH CHECK ((( SELECT auth.uid() AS uid) = reviewer_id));
CREATE POLICY organizer_reviews_read ON organizer_reviews FOR SELECT TO public USING (true);
CREATE POLICY organizer_reviews_update ON organizer_reviews FOR UPDATE TO authenticated USING ((( SELECT auth.uid() AS uid) = reviewer_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = reviewer_id));
CREATE POLICY org_txns_admin_write ON organizer_transactions FOR INSERT TO public WITH CHECK (is_admin());
CREATE POLICY org_txns_own_read ON organizer_transactions FOR SELECT TO authenticated USING ((( SELECT auth.uid() AS uid) = organizer_id));
CREATE POLICY organizer_verif_insert_own ON organizer_verification_requests FOR INSERT TO public WITH CHECK ((auth.uid() = user_id));
CREATE POLICY organizer_verif_select_own ON organizer_verification_requests FOR SELECT TO public USING (((auth.uid() = user_id) OR is_admin()));
CREATE POLICY organizer_wallets_admin_write ON organizer_wallets FOR ALL TO public USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY organizer_wallets_own_read ON organizer_wallets FOR SELECT TO authenticated USING ((( SELECT auth.uid() AS uid) = organizer_id));
CREATE POLICY org_withdraw_admin_read ON organizer_withdrawal_requests FOR SELECT TO public USING (is_admin());
CREATE POLICY org_withdraw_admin_update ON organizer_withdrawal_requests FOR UPDATE TO public USING (is_admin());
CREATE POLICY org_withdraw_own_insert ON organizer_withdrawal_requests FOR INSERT TO authenticated WITH CHECK ((( SELECT auth.uid() AS uid) = organizer_id));
CREATE POLICY org_withdraw_own_read ON organizer_withdrawal_requests FOR SELECT TO authenticated USING ((( SELECT auth.uid() AS uid) = organizer_id));
CREATE POLICY referrals_delete ON referrals FOR DELETE TO public USING ((referrer_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY referrals_insert ON referrals FOR INSERT TO public WITH CHECK (((referrer_id = ( SELECT auth.uid() AS uid)) AND (referral_count_today(( SELECT auth.uid() AS uid)) < 5)));
CREATE POLICY referrals_select ON referrals FOR SELECT TO public USING ((referrer_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY re_insert ON referred_emails FOR INSERT TO public WITH CHECK ((referrer_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY re_read ON referred_emails FOR SELECT TO authenticated USING ((( SELECT auth.uid() AS uid) = referrer_id));
CREATE POLICY reports_admin_all ON reports FOR ALL TO authenticated USING (is_admin());
CREATE POLICY reports_insert ON reports FOR INSERT TO authenticated WITH CHECK ((( SELECT auth.uid() AS uid) = reporter_id));
CREATE POLICY reports_select_own ON reports FOR SELECT TO authenticated USING ((( SELECT auth.uid() AS uid) = reporter_id));
CREATE POLICY delete_saved_events ON saved_events FOR DELETE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY insert_saved_events ON saved_events FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY select_saved_events ON saved_events FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY insert_tickets ON tickets FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY select_tickets ON tickets FOR SELECT TO authenticated USING (((user_id = ( SELECT auth.uid() AS uid)) OR (event_id IN ( SELECT events.id
   FROM events
  WHERE (events.organizer_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY update_tickets ON tickets FOR UPDATE TO authenticated USING (((user_id = ( SELECT auth.uid() AS uid)) OR (event_id IN ( SELECT events.id
   FROM events
  WHERE (events.organizer_id = ( SELECT auth.uid() AS uid)))))) WITH CHECK (((user_id = ( SELECT auth.uid() AS uid)) OR (event_id IN ( SELECT events.id
   FROM events
  WHERE (events.organizer_id = ( SELECT auth.uid() AS uid))))));
CREATE POLICY ups_own ON user_privacy_settings FOR ALL TO public USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY admin_select_users ON users FOR SELECT TO public USING (is_admin());
CREATE POLICY admin_update_users ON users FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY select_own_user ON users FOR SELECT TO public USING ((id = ( SELECT auth.uid() AS uid)));
CREATE POLICY update_own_user ON users FOR UPDATE TO authenticated USING ((( SELECT auth.uid() AS uid) = id)) WITH CHECK ((( SELECT auth.uid() AS uid) = id));
CREATE POLICY vcb_own ON vc_bonuses FOR ALL TO public USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY vceb_own ON vc_event_boosts FOR ALL TO public USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY vc_transactions_admin_select ON vc_transactions FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY vc_transactions_select ON vc_transactions FOR SELECT TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY wallets_select ON vents_wallets FOR SELECT TO public USING ((user_id = ( SELECT auth.uid() AS uid)));