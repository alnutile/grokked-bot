-- Saved logins. The secret is AES-256-GCM ciphertext (see vault.ts); the key
-- lives in ~/.config/grokked/vault.key, never in this database.
CREATE TABLE credentials (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  url          TEXT NOT NULL DEFAULT '',
  domain       TEXT NOT NULL,          -- passwords are only typed on this host or its subdomains
  username     TEXT NOT NULL DEFAULT '',
  secret_enc   TEXT NOT NULL DEFAULT '',
  notes        TEXT NOT NULL DEFAULT '',
  bot_ids_json TEXT NOT NULL DEFAULT '[]',  -- empty = every bot may use it
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
