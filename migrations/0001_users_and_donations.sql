-- Everyone who interacted with the bot (messages, button taps, contacts).
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, -- Telegram user id
  first_name TEXT,
  username TEXT,
  language_code TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  interactions INTEGER NOT NULL DEFAULT 1
);

-- One row per checkout attempt. `session_id` is unique so retries and
-- reconciliations can never create a duplicate donation.
CREATE TABLE IF NOT EXISTS donations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  session_id TEXT NOT NULL UNIQUE,
  amount_minor INTEGER NOT NULL, -- ETB santim (100 = 1.00 ETB)
  currency TEXT NOT NULL DEFAULT 'ETB',
  gateway TEXT NOT NULL, -- telebirr | mpesa | cbe
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'expired')),
  order_id TEXT,
  created_at INTEGER NOT NULL, -- unix ms
  completed_at INTEGER -- unix ms, set when a payment is confirmed
);

CREATE INDEX IF NOT EXISTS idx_donations_user ON donations (user_id);
CREATE INDEX IF NOT EXISTS idx_donations_pending
  ON donations (status, created_at);
CREATE INDEX IF NOT EXISTS idx_donations_completed
  ON donations (status, completed_at);
