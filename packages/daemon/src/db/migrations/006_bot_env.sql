-- A bot's environment variables: what its shell gets on every run_bash. The
-- whole set is one AES-256-GCM blob (see vault.ts), since it is mostly tokens.
ALTER TABLE bots ADD COLUMN env_enc TEXT NOT NULL DEFAULT '';
