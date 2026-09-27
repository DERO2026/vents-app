-- Provider Reviews: closes the confirmed audit gap that
-- provider_reviews_insert_own required only payment_status = 'paid', not
-- status = 'completed', even though the app's own service-booking lifecycle
-- (0054_service_bookings_marketplace.sql CHECK constraint, 0098_service_
-- booking_completion.sql's complete_service_booking RPC) treats
-- 'completed' as the terminal "the service was actually delivered" state.
-- Without this, a customer could review a booking that was merely paid for
-- but never fulfilled (still 'pending_payment'/'confirmed'/'cancelled').
--
-- This ONLY narrows provider_reviews_insert_own's WITH CHECK clause by
-- adding "AND b.status = 'completed'" to its existing EXISTS subquery.
-- Nothing else about the policy, or about any other provider_reviews
-- policy, changes:
--   - reviewer_id = auth.uid() (own account only) -- unchanged
--   - b.customer_id = auth.uid() (own booking only) -- unchanged
--   - b.provider_id = provider_reviews.provider_id (booking must match the
--     provider being reviewed) -- unchanged
--   - b.payment_status = 'paid' -- kept; a completed-but-refunded booking
--     (payment_status would move to 'refunded'/'refund_pending' via
--     cancel_service_booking, which itself only fires on 'confirmed', so a
--     'completed' booking can never be simultaneously non-'paid' today, but
--     keeping this clause costs nothing and preserves defense in depth).
--   - provider_reviews_public_select (public read), provider_reviews_
--     update_own, provider_reviews_delete_own, provider_reviews_admin_all,
--     the provider_reviews_booking_unique UNIQUE(booking_id) constraint,
--     and the rating/body CHECK constraints are all untouched.
--
-- No RPC is introduced -- per the explicit product decision, RLS alone is
-- authoritative and a direct client-side insert is sufficient.

DROP POLICY IF EXISTS provider_reviews_insert_own ON public.provider_reviews;

CREATE POLICY provider_reviews_insert_own
  ON public.provider_reviews
  FOR INSERT
  WITH CHECK (
    reviewer_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
        FROM public.service_bookings b
       WHERE b.id = provider_reviews.booking_id
         AND b.customer_id = (SELECT auth.uid())
         AND b.provider_id = provider_reviews.provider_id
         AND b.payment_status = 'paid'
         AND b.status = 'completed'
    )
  );
