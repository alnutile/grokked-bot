-- A bot's own step and time limits per message, over the Settings defaults: a
-- coding bot runs long, a shopping bot stays tight. NULL means use Settings.
ALTER TABLE bots ADD COLUMN default_max_steps INTEGER;
ALTER TABLE bots ADD COLUMN default_max_wall_s INTEGER;
