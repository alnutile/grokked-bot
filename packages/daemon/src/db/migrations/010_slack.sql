-- A bot's own Slack app (one per bot, so each shows up in Slack with its own name
-- and face). Tokens are AES-256-GCM (see vault.ts). Socket Mode, so no public URL.
CREATE TABLE slack_apps (
  bot_id             TEXT PRIMARY KEY REFERENCES bots(id),
  bot_token_enc      TEXT NOT NULL,          -- xoxb-…
  app_token_enc      TEXT NOT NULL,          -- xapp-… (connections:write)
  team_id            TEXT,
  team_name          TEXT,
  team_url           TEXT,
  bot_user_id        TEXT,
  bot_user_name      TEXT,
  app_id             TEXT,
  enabled            INTEGER NOT NULL DEFAULT 1,
  allow_all          INTEGER NOT NULL DEFAULT 0,
  allowed_users_json TEXT NOT NULL DEFAULT '[]',   -- [{id, name}]; the first person to message it is added
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- A Slack thread (or a DM) is a conversation with the bot.
CREATE TABLE slack_threads (
  bot_id     TEXT NOT NULL REFERENCES bots(id),
  channel    TEXT NOT NULL,
  thread_key TEXT NOT NULL,                  -- the thread's ts, or 'dm' for a DM's top level
  thread_id  TEXT NOT NULL REFERENCES threads(id),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, channel, thread_key)
);
