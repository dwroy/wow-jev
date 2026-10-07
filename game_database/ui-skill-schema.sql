-- Additive runtime extension; no base runtime or frozen world schema changes.
CREATE TABLE ui_skill_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE ui_state (
  state_key TEXT PRIMARY KEY, state_id TEXT NOT NULL, scope_key TEXT NOT NULL,
  hard_stop INTEGER NOT NULL CHECK(hard_stop IN (0,1)), review_status TEXT NOT NULL,
  content_sha256 TEXT NOT NULL, payload TEXT NOT NULL,
  UNIQUE(state_id,scope_key)
) STRICT;
CREATE TABLE ui_signature (
  signature_id TEXT PRIMARY KEY, state_key TEXT NOT NULL REFERENCES ui_state(state_key),
  content_sha256 TEXT NOT NULL, payload TEXT NOT NULL
) STRICT;
CREATE TABLE ui_element (
  element_key TEXT PRIMARY KEY, state_key TEXT NOT NULL REFERENCES ui_state(state_key),
  content_sha256 TEXT NOT NULL, payload TEXT NOT NULL
) STRICT;
CREATE TABLE ui_skill (
  skill_id TEXT PRIMARY KEY, state_key TEXT NOT NULL REFERENCES ui_state(state_key),
  signature_id TEXT NOT NULL REFERENCES ui_signature(signature_id),
  element_key TEXT NOT NULL REFERENCES ui_element(element_key),
  status TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
  confirmed_count INTEGER NOT NULL DEFAULT 0, failure_streak INTEGER NOT NULL DEFAULT 0,
  requalify_after INTEGER NOT NULL DEFAULT 0, last_failure TEXT,
  content_sha256 TEXT NOT NULL, payload TEXT NOT NULL
) STRICT;
CREATE TABLE ui_attempt (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL UNIQUE,
  skill_id TEXT NOT NULL REFERENCES ui_skill(skill_id), content_sha256 TEXT NOT NULL,
  live_confirmed INTEGER NOT NULL CHECK(live_confirmed IN (0,1)),
  before_frame_id TEXT NOT NULL, after_frame_id TEXT, receipt_key TEXT,
  payload TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX ui_attempt_native_once ON ui_attempt(receipt_key) WHERE live_confirmed=1;
CREATE INDEX ui_attempt_skill_order ON ui_attempt(skill_id,ordinal);
CREATE TABLE ui_skill_request (
  request_id TEXT PRIMARY KEY, content_sha256 TEXT NOT NULL, result TEXT NOT NULL
) STRICT;
CREATE TABLE ui_skill_checkpoint (
  queue_key TEXT PRIMARY KEY, byte_offset INTEGER NOT NULL,
  prefix_sha256 TEXT NOT NULL
) STRICT;
CREATE TRIGGER ui_attempt_no_update BEFORE UPDATE ON ui_attempt
BEGIN SELECT RAISE(ABORT,'UI attempt evidence is immutable'); END;
CREATE TRIGGER ui_attempt_no_delete BEFORE DELETE ON ui_attempt
BEGIN SELECT RAISE(ABORT,'UI attempt evidence is immutable'); END;
CREATE TRIGGER ui_skill_request_no_update BEFORE UPDATE ON ui_skill_request
BEGIN SELECT RAISE(ABORT,'UI learning request identity is immutable'); END;
CREATE TRIGGER ui_skill_request_no_delete BEFORE DELETE ON ui_skill_request
BEGIN SELECT RAISE(ABORT,'UI learning request history is immutable'); END;
