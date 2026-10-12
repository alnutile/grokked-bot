-- Responses the human pinned to come back to. The text is copied in, so a pin
-- survives its conversation being long or the run being gone.
CREATE TABLE pins (
  id         TEXT PRIMARY KEY,
  bot_id     TEXT NOT NULL REFERENCES bots(id),
  thread_id  TEXT,
  run_id     TEXT,
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX pins_recent ON pins(created_at DESC);
CREATE INDEX pins_thread ON pins(thread_id);
