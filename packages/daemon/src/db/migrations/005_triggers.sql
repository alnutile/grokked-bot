-- Webhooks and schedules (the triggers table is from 001). A webhook's bearer
-- token is stored as a SHA-256 in secret_hash; goal_template is the hook's
-- standing instruction; spec_json is {cron, tz} for schedules.
ALTER TABLE triggers ADD COLUMN public INTEGER NOT NULL DEFAULT 0;      -- reachable via Tailscale Funnel
ALTER TABLE triggers ADD COLUMN thread_id TEXT;                          -- its own conversation
ALTER TABLE triggers ADD COLUMN last_run_id TEXT;
ALTER TABLE triggers ADD COLUMN allowed_domains_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE triggers ADD COLUMN max_usd REAL;
ALTER TABLE triggers ADD COLUMN fire_count INTEGER NOT NULL DEFAULT 0;
