-- "This site signs in with Google": the site's login holds no password of its
-- own, it points at the saved provider account (another credential) instead.
ALTER TABLE credentials ADD COLUMN sign_in_with TEXT NOT NULL DEFAULT '';      -- ''|google|microsoft|apple|github
ALTER TABLE credentials ADD COLUMN via_credential_id TEXT NOT NULL DEFAULT '';
