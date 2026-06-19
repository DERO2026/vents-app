-- Item 8: Prevent self-follow at the database level (delete any existing self-follows first)
DELETE FROM follows WHERE follower_id = following_id;
ALTER TABLE follows DROP CONSTRAINT IF EXISTS follows_no_self_follow;
ALTER TABLE follows ADD CONSTRAINT follows_no_self_follow
  CHECK (follower_id <> following_id);

-- Item 10: Organizer reviews table
CREATE TABLE IF NOT EXISTS organizer_reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reviewer_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating       smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body         text NOT NULL CHECK (char_length(trim(body)) >= 10),
  created_at   timestamptz DEFAULT now(),
  UNIQUE (organizer_id, reviewer_id)
);

ALTER TABLE organizer_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "organizer_reviews_read" ON organizer_reviews FOR SELECT USING (true);
CREATE POLICY "organizer_reviews_insert" ON organizer_reviews FOR INSERT WITH CHECK (auth.uid() = reviewer_id);
CREATE POLICY "organizer_reviews_update" ON organizer_reviews FOR UPDATE USING (auth.uid() = reviewer_id) WITH CHECK (auth.uid() = reviewer_id);
CREATE POLICY "organizer_reviews_delete" ON organizer_reviews FOR DELETE USING (auth.uid() = reviewer_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON organizer_reviews TO authenticated;

-- SECURITY DEFINER: ticket-gated review submission
CREATE OR REPLACE FUNCTION submit_organizer_review(
  p_organizer_id uuid,
  p_rating       smallint,
  p_body         text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reviewer uuid := auth.uid();
  v_has_ticket boolean;
BEGIN
  IF v_reviewer IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF v_reviewer = p_organizer_id THEN RAISE EXCEPTION 'You cannot review yourself'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM tickets t
    JOIN events e ON e.id = t.event_id
    WHERE t.user_id = v_reviewer
      AND e.organizer_id = p_organizer_id
      AND t.status = 'active'
  ) INTO v_has_ticket;

  IF NOT v_has_ticket THEN
    RAISE EXCEPTION 'You must attend an event by this organizer before leaving a review';
  END IF;

  INSERT INTO organizer_reviews (organizer_id, reviewer_id, rating, body)
  VALUES (p_organizer_id, v_reviewer, p_rating, trim(p_body))
  ON CONFLICT (organizer_id, reviewer_id) DO UPDATE
    SET rating = EXCLUDED.rating, body = EXCLUDED.body, created_at = now();
END;
$$;

CREATE INDEX IF NOT EXISTS organizer_reviews_organizer_idx ON organizer_reviews(organizer_id);
CREATE INDEX IF NOT EXISTS organizer_reviews_reviewer_idx  ON organizer_reviews(reviewer_id);
