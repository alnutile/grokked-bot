ALTER TABLE llm_calls ADD COLUMN bot_id TEXT;
ALTER TABLE llm_calls ADD COLUMN cost_known INTEGER NOT NULL DEFAULT 1;
ALTER TABLE llm_calls ADD COLUMN usage_known INTEGER NOT NULL DEFAULT 1;
UPDATE llm_calls SET bot_id = (SELECT bot_id FROM runs WHERE runs.id = llm_calls.run_id);
CREATE INDEX llm_calls_bot ON llm_calls(bot_id, created_at);
