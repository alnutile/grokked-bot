-- A bot's profile: what it's for, how it looks, and the defaults a new message
-- gets when the composer doesn't override them.
ALTER TABLE bots ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE bots ADD COLUMN avatar_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE bots ADD COLUMN default_domains_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE bots ADD COLUMN default_max_usd REAL;

-- A title the human typed is never overwritten by an automatic one.
ALTER TABLE threads ADD COLUMN title_source TEXT NOT NULL DEFAULT 'auto';  -- auto|human
