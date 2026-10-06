-- Additive extension; the base runtime v2 schema and frozen world pack are unchanged.
CREATE TABLE local_assertion_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE local_assertion (
  sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64),
  world_pack_sha256 TEXT NOT NULL,
  version_key TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES character(character_id),
  session_key TEXT NOT NULL,
  local_key TEXT NOT NULL,
  predicate TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  payload TEXT NOT NULL,
  FOREIGN KEY(source_run_id,source_seq) REFERENCES event_index(run_id,seq)
) STRICT;
CREATE INDEX local_assertion_lookup ON local_assertion(world_pack_sha256,version_key,actor_id,session_key,local_key,predicate);
CREATE TRIGGER local_assertion_no_update BEFORE UPDATE ON local_assertion
BEGIN SELECT RAISE(ABORT,'local assertion history is immutable'); END;
CREATE TRIGGER local_assertion_no_delete BEFORE DELETE ON local_assertion
BEGIN SELECT RAISE(ABORT,'local assertion evidence is immutable'); END;
