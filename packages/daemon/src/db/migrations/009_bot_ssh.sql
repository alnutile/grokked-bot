-- A bot's SSH identity: its ed25519 private key (AES-256-GCM, see vault.ts), the
-- public half people put in authorized_keys, and the servers it may log in to.
ALTER TABLE bots ADD COLUMN ssh_key_enc TEXT NOT NULL DEFAULT '';
ALTER TABLE bots ADD COLUMN ssh_public TEXT NOT NULL DEFAULT '';
ALTER TABLE bots ADD COLUMN ssh_created_at INTEGER;
ALTER TABLE bots ADD COLUMN ssh_hosts_json TEXT NOT NULL DEFAULT '[]';
