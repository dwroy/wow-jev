-- Mutable WSL-local runtime domain.  This is separate from the v1/world schemas.
CREATE TABLE runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
INSERT INTO runtime_meta VALUES ('schema', 'wow-agent-runtime-v2');

CREATE TABLE artifact (
    sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64),
    byte_size INTEGER NOT NULL CHECK(byte_size>=0),
    media_type TEXT NOT NULL,
    locator TEXT NOT NULL
) STRICT;

CREATE TABLE account_scope (
    account_id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    payload TEXT NOT NULL
) STRICT;
CREATE TABLE character (
    character_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES account_scope(account_id),
    namespace TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    payload TEXT NOT NULL
) STRICT;

CREATE TABLE run (
    run_id TEXT PRIMARY KEY,
    world_pack_sha256 TEXT NOT NULL CHECK(length(world_pack_sha256)=64),
    world_sqlite_sha256 TEXT NOT NULL CHECK(length(world_sqlite_sha256)=64),
    version_key TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('live','simulated','readonly')),
    content_sha256 TEXT NOT NULL,
    payload TEXT NOT NULL,
    expected_last_seq INTEGER CHECK(expected_last_seq>=0),
    end_sha256 TEXT,
    CHECK((expected_last_seq IS NULL)=(end_sha256 IS NULL))
) STRICT;
CREATE TABLE event_index (
    run_id TEXT NOT NULL REFERENCES run(run_id),
    seq INTEGER NOT NULL CHECK(seq>=1),
    event_id TEXT NOT NULL,
    event_sha256 TEXT NOT NULL CHECK(length(event_sha256)=64),
    kind TEXT NOT NULL,
    source_clock TEXT NOT NULL,
    received_clock TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (run_id, seq),
    UNIQUE (run_id, event_id)
) STRICT;
CREATE TABLE event_gap (
    run_id TEXT NOT NULL REFERENCES run(run_id),
    first_seq INTEGER NOT NULL CHECK(first_seq>=1),
    last_seq INTEGER NOT NULL CHECK(last_seq>=first_seq),
    PRIMARY KEY (run_id, first_seq)
) STRICT;

-- History is immutable.  Current progress is derived from source-clock order.
CREATE TABLE progress_observation (
    observation_sha256 TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK(scope IN ('character','account')),
    scope_id TEXT NOT NULL,
    world_pack_sha256 TEXT NOT NULL,
    version_key TEXT NOT NULL,
    namespace TEXT NOT NULL,
    kind TEXT NOT NULL,
    native_id INTEGER NOT NULL,
    field TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('value','unknown','unsupported','not_present')),
    source_run_id TEXT NOT NULL,
    source_seq INTEGER NOT NULL,
    source_clock TEXT NOT NULL,
    payload TEXT NOT NULL,
    FOREIGN KEY(source_run_id,source_seq) REFERENCES event_index(run_id,seq)
) STRICT;
CREATE INDEX progress_lookup ON progress_observation
    (scope,scope_id,world_pack_sha256,version_key,namespace,kind,native_id,field);

CREATE TABLE experience_candidate (
    candidate_sha256 TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>=1),
    world_pack_sha256 TEXT NOT NULL,
    payload TEXT NOT NULL,
    UNIQUE(candidate_id,revision)
) STRICT;
CREATE TABLE candidate_evidence (
    candidate_sha256 TEXT NOT NULL REFERENCES experience_candidate(candidate_sha256),
    role TEXT NOT NULL CHECK(role IN ('sample','counterexample')),
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY(candidate_sha256,role,run_id,seq),
    FOREIGN KEY(run_id,seq) REFERENCES event_index(run_id,seq)
) STRICT;
CREATE TABLE evaluation (
    evaluation_sha256 TEXT PRIMARY KEY,
    evaluation_id TEXT NOT NULL UNIQUE,
    candidate_sha256 TEXT NOT NULL REFERENCES experience_candidate(candidate_sha256),
    outcome TEXT NOT NULL CHECK(outcome IN ('accepted','rejected','inconclusive')),
    payload TEXT NOT NULL
) STRICT;
CREATE TABLE knowledge_release (
    release_id TEXT PRIMARY KEY,
    release_sha256 TEXT NOT NULL UNIQUE,
    content_sha256 TEXT NOT NULL REFERENCES artifact(sha256),
    payload TEXT NOT NULL
) STRICT;
CREATE TABLE release_candidate (
    release_id TEXT NOT NULL REFERENCES knowledge_release(release_id),
    candidate_sha256 TEXT NOT NULL REFERENCES experience_candidate(candidate_sha256),
    evaluation_sha256 TEXT NOT NULL REFERENCES evaluation(evaluation_sha256),
    PRIMARY KEY(release_id,candidate_sha256)
) STRICT;

-- Published rows and evidence references cannot be changed by accidental SQL.
CREATE TRIGGER release_no_update BEFORE UPDATE ON knowledge_release
BEGIN SELECT RAISE(ABORT,'published knowledge is immutable'); END;
CREATE TRIGGER release_no_delete BEFORE DELETE ON knowledge_release
BEGIN SELECT RAISE(ABORT,'published knowledge is immutable'); END;
CREATE TRIGGER release_candidate_no_update BEFORE UPDATE ON release_candidate
BEGIN SELECT RAISE(ABORT,'published knowledge is immutable'); END;
CREATE TRIGGER release_candidate_no_delete BEFORE DELETE ON release_candidate
BEGIN SELECT RAISE(ABORT,'published knowledge is immutable'); END;

PRAGMA application_id=1465012818;
PRAGMA user_version=2;
