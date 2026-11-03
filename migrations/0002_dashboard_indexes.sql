-- Dashboard analytics: keep date-ordered reads and donor lookups cheap as the
-- table grows. Existing indexes already cover (status, completed_at) and
-- (status, created_at); these add the all-status timeline and user recency.
CREATE INDEX IF NOT EXISTS idx_donations_created
  ON donations (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_donations_completed_desc
  ON donations (completed_at DESC);

CREATE INDEX IF NOT EXISTS idx_users_last_seen
  ON users (last_seen_at DESC);
