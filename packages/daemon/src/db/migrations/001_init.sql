-- Grokked Bot initial schema.
-- Invariant: the daemon holds no run state that is not in here.

-- ============================== identity ==============================
CREATE TABLE bots (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  persona_md       TEXT NOT NULL DEFAULT '',
  model_roles_json TEXT NOT NULL DEFAULT '{}',
  autonomy         TEXT NOT NULL DEFAULT 'supervised',   -- supervised|semi|auto
  container_ref    TEXT,
  status           TEXT NOT NULL DEFAULT 'active',       -- active|paused|archived
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- ============================ conversation ============================
CREATE TABLE threads (
  id              TEXT PRIMARY KEY,
  bot_id          TEXT NOT NULL REFERENCES bots(id),
  kind            TEXT NOT NULL DEFAULT 'chat',          -- chat|run
  title           TEXT,
  summary         TEXT,                                  -- rolling summary of seq <= watermark
  summary_seq     INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX threads_bot ON threads(bot_id, last_message_at DESC);

CREATE TABLE messages (
  id             TEXT PRIMARY KEY,
  thread_id      TEXT NOT NULL REFERENCES threads(id),
  seq            INTEGER NOT NULL,
  role           TEXT NOT NULL,          -- user|assistant|tool|system|event
  content_json   TEXT NOT NULL,          -- OpenAI-shaped content parts
  tool_call_id   TEXT,
  run_id         TEXT,
  step_no        INTEGER,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  UNIQUE(thread_id, seq)
);
CREATE INDEX messages_run ON messages(run_id, step_no);

-- =============================== runs =================================
CREATE TABLE runs (
  id                TEXT PRIMARY KEY,
  bot_id            TEXT NOT NULL REFERENCES bots(id),
  thread_id         TEXT NOT NULL REFERENCES threads(id),
  trigger_id        TEXT,
  trigger_kind      TEXT NOT NULL,        -- user|cron|webhook|poll|manual
  goal              TEXT NOT NULL,
  routine_id        TEXT,
  routine_version   INTEGER,
  params_json       TEXT NOT NULL DEFAULT '{}',
  allowed_domains_json TEXT NOT NULL DEFAULT '[]',
  state             TEXT NOT NULL,        -- queued|running|awaiting_approval|sleeping
                                          -- |blocked|paused_budget|succeeded|failed|cancelled
  state_reason      TEXT,
  wake_at           INTEGER,
  cancel_requested  INTEGER NOT NULL DEFAULT 0,
  lease_owner       TEXT,
  lease_expires_at  INTEGER,
  crash_count       INTEGER NOT NULL DEFAULT 0,
  step_no           INTEGER NOT NULL DEFAULT 0,
  max_steps         INTEGER NOT NULL DEFAULT 40,
  max_usd           REAL    NOT NULL DEFAULT 1.00,
  max_wall_s        INTEGER NOT NULL DEFAULT 3600,
  screenshot_count  INTEGER NOT NULL DEFAULT 0,
  max_screenshots   INTEGER NOT NULL DEFAULT 12,
  spend_usd         REAL    NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  outcome           TEXT,                 -- success|failure|gave_up|cancelled
  outcome_summary   TEXT,
  idem_key          TEXT UNIQUE,
  started_at        INTEGER,
  ended_at          INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE INDEX runs_sched ON runs(state, wake_at);
CREATE INDEX runs_bot   ON runs(bot_id, created_at DESC);

CREATE TABLE run_steps (
  run_id         TEXT NOT NULL REFERENCES runs(id),
  step_no        INTEGER NOT NULL,
  kind           TEXT NOT NULL,      -- llm_call|tool_call|approval|sleep|error|nudge
  status         TEXT NOT NULL,      -- dispatched|ok|error|unknown|denied|timeout
  tool_name      TEXT,
  tool_call_id   TEXT,
  args_json      TEXT,
  result_json    TEXT,               -- truncated; full payload in blobs
  result_blob_id TEXT,
  idem_key       TEXT,
  error          TEXT,
  started_at     INTEGER,
  ended_at       INTEGER,
  PRIMARY KEY (run_id, step_no)
);
-- drives the in-doubt sweep on boot
CREATE INDEX run_steps_indoubt ON run_steps(status) WHERE status = 'dispatched';

CREATE TABLE llm_calls (
  id                TEXT PRIMARY KEY,
  run_id            TEXT,
  step_no           INTEGER,
  role              TEXT NOT NULL,     -- planner|worker|vision|distiller|classifier
  model             TEXT NOT NULL,
  provider          TEXT,
  gen_id            TEXT,              -- OpenRouter id, for /generation reconciliation
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  reasoning_tokens  INTEGER,
  cached_tokens     INTEGER,
  cost_usd          REAL,
  latency_ms        INTEGER,
  finish_reason     TEXT,
  escalated_from    TEXT,
  error             TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX llm_calls_run ON llm_calls(run_id);
CREATE INDEX llm_calls_day ON llm_calls(created_at);

-- ============================= approvals ==============================
CREATE TABLE approvals (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES runs(id),
  step_no          INTEGER NOT NULL,
  bot_id           TEXT NOT NULL,
  tool_name        TEXT NOT NULL,
  tool_call_id     TEXT NOT NULL,
  args_json        TEXT NOT NULL,
  edited_args_json TEXT,
  risk             TEXT NOT NULL DEFAULT 'medium',
  title            TEXT NOT NULL,
  preview_json     TEXT,
  state            TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|denied|expired|cancelled
  decided_by       TEXT,
  decided_at       INTEGER,
  decision_note    TEXT,
  remember_choice  TEXT,                             -- always_allow|always_deny
  expires_at       INTEGER NOT NULL,
  on_timeout       TEXT NOT NULL DEFAULT 'deny',     -- deny|park|approve
  notified_at      INTEGER,
  notify_count     INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  UNIQUE(run_id, step_no)
);
CREATE INDEX approvals_pending ON approvals(state, expires_at);

CREATE TABLE tool_policies (
  id             TEXT PRIMARY KEY,
  bot_id         TEXT NOT NULL,
  tool_name      TEXT NOT NULL,
  mode           TEXT NOT NULL,        -- allow|approve|deny
  condition_json TEXT,                 -- {"amount_usd":{"gt":500}}; NULL = unconditional
  source         TEXT NOT NULL DEFAULT 'user',  -- user|default|routine
  created_at     INTEGER NOT NULL
);
CREATE INDEX tool_policies_lookup ON tool_policies(bot_id, tool_name);

-- ============================== memory ================================
CREATE TABLE entities (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,      -- person|company|account|project|system
  display_name      TEXT NOT NULL,
  aliases_json      TEXT NOT NULL DEFAULT '[]',
  external_ids_json TEXT NOT NULL DEFAULT '{}',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE facts (
  id            TEXT PRIMARY KEY,
  bot_id        TEXT,                  -- NULL = applies to every bot
  scope         TEXT NOT NULL,         -- preference|constraint|identity|howto|context
  body          TEXT NOT NULL,
  entity_id     TEXT REFERENCES entities(id),
  source        TEXT NOT NULL,         -- user_stated|inferred|correction|distilled
  source_ref    TEXT,
  confidence    REAL NOT NULL DEFAULT 0.8,
  pinned        INTEGER NOT NULL DEFAULT 0,
  use_count     INTEGER NOT NULL DEFAULT 0,
  last_used_at  INTEGER,
  supersedes_id TEXT REFERENCES facts(id),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
CREATE INDEX facts_active ON facts(active, pinned, bot_id);

CREATE VIRTUAL TABLE facts_fts USING fts5(
  body, content='facts', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER facts_ad AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, body) VALUES('delete', old.rowid, old.body);
END;
CREATE TRIGGER facts_au AFTER UPDATE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, body) VALUES('delete', old.rowid, old.body);
  INSERT INTO facts_fts(rowid, body) VALUES (new.rowid, new.body);
END;

CREATE TABLE entity_notes (
  id            TEXT PRIMARY KEY,
  entity_id     TEXT NOT NULL REFERENCES entities(id),
  kind          TEXT NOT NULL DEFAULT 'note',   -- note|preference|gotcha|contact
  body          TEXT NOT NULL,
  source_run_id TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
CREATE INDEX entity_notes_e ON entity_notes(entity_id, active);

CREATE VIRTUAL TABLE notes_fts USING fts5(
  body, content='entity_notes', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE TRIGGER notes_ai AFTER INSERT ON entity_notes BEGIN
  INSERT INTO notes_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER notes_ad AFTER DELETE ON entity_notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, body) VALUES('delete', old.rowid, old.body);
END;
CREATE TRIGGER notes_au AFTER UPDATE ON entity_notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, body) VALUES('delete', old.rowid, old.body);
  INSERT INTO notes_fts(rowid, body) VALUES (new.rowid, new.body);
END;

-- ============================== routines ==============================
CREATE TABLE routines (
  id              TEXT PRIMARY KEY,
  bot_id          TEXT NOT NULL REFERENCES bots(id),
  slug            TEXT NOT NULL,
  name            TEXT NOT NULL,
  intent          TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 1,
  trigger_id      TEXT,
  autonomy        TEXT NOT NULL DEFAULT 'supervised',
  status          TEXT NOT NULL DEFAULT 'draft',   -- draft|active|disabled
  success_count   INTEGER NOT NULL DEFAULT 0,
  failure_count   INTEGER NOT NULL DEFAULT 0,
  last_run_id     TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE(bot_id, slug)
);

CREATE TABLE routine_versions (
  routine_id            TEXT NOT NULL REFERENCES routines(id),
  version               INTEGER NOT NULL,
  spec_json             TEXT NOT NULL,   -- RoutineSpec
  procedure_md          TEXT NOT NULL,   -- prose checklist actually injected
  distilled_from_run_id TEXT,
  change_note           TEXT,
  created_at            INTEGER NOT NULL,
  PRIMARY KEY (routine_id, version)
);

CREATE TABLE routine_corrections (
  id                 TEXT PRIMARY KEY,
  routine_id         TEXT NOT NULL REFERENCES routines(id),
  applies_to_version INTEGER,
  correction         TEXT NOT NULL,
  source_message_id  TEXT,
  source_run_id      TEXT,
  status             TEXT NOT NULL DEFAULT 'pending',  -- pending|applied|rejected
  applied_in_version INTEGER,
  created_at         INTEGER NOT NULL
);

-- ============================== triggers ==============================
CREATE TABLE triggers (
  id            TEXT PRIMARY KEY,
  bot_id        TEXT NOT NULL REFERENCES bots(id),
  kind          TEXT NOT NULL,        -- cron|webhook|poll|manual
  name          TEXT NOT NULL,
  spec_json     TEXT NOT NULL,        -- {cron,tz} | {source,query,interval_s} | {}
  routine_id    TEXT,
  goal_template TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  next_fire_at  INTEGER,
  last_fire_at  INTEGER,
  last_cursor   TEXT,                 -- poll watermark
  secret_hash   TEXT,                 -- webhook HMAC
  created_at    INTEGER NOT NULL
);
CREATE INDEX triggers_due ON triggers(enabled, next_fire_at);

-- =========================== infra / ops ==============================
-- The WS is a cache-invalidation channel; this table is the source of truth.
-- Every emitted frame lands here first so `since=` replay can rebuild client state.
CREATE TABLE events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  topic        TEXT NOT NULL,
  type         TEXT NOT NULL,
  bot_id       TEXT,
  run_id       TEXT,
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX events_topic ON events(topic, seq);
CREATE INDEX events_created ON events(created_at);

CREATE TABLE notifications (
  id            TEXT PRIMARY KEY,
  bot_id        TEXT,
  run_id        TEXT,
  approval_id   TEXT,
  level         TEXT NOT NULL,        -- info|needs_approval|error
  title         TEXT NOT NULL,
  body          TEXT,
  channels_json TEXT NOT NULL DEFAULT '[]',
  delivered_at  INTEGER,
  read_at       INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX notifications_unread ON notifications(read_at, created_at DESC);

CREATE TABLE blobs (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,          -- screenshot|tool_result|artifact
  mime       TEXT,
  bytes      INTEGER,
  sha256     TEXT NOT NULL,
  path       TEXT NOT NULL,
  run_id     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX blobs_run ON blobs(run_id);

CREATE TABLE budgets (
  id        TEXT PRIMARY KEY,        -- 'bot:alpha:day:2026-08-30' | 'global:month:2026-08'
  scope     TEXT NOT NULL,
  period    TEXT NOT NULL,           -- day|month
  limit_usd REAL NOT NULL,
  spend_usd REAL NOT NULL DEFAULT 0,
  resets_at INTEGER NOT NULL
);

CREATE TABLE kv (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
