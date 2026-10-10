BEGIN;
ALTER TABLE document_uploads ADD COLUMN payload jsonb;
ALTER TABLE document_uploads DROP CONSTRAINT document_uploads_state_check;
ALTER TABLE document_uploads ADD CONSTRAINT document_uploads_state_check CHECK(state IN ('pending','attached','abandoned'));
ALTER TABLE document_uploads ADD CONSTRAINT document_uploads_payload_object CHECK (payload IS NULL OR jsonb_typeof(payload)='object');
CREATE TABLE import_batches (
 namespace varchar(80) PRIMARY KEY CHECK(namespace ~ '^[a-z0-9][a-z0-9_-]{2,79}$'),
 source_sha256 char(64) NOT NULL UNIQUE CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 plan_sha256 char(64) NOT NULL CHECK(plan_sha256 ~ '^[a-f0-9]{64}$'),
 actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 report jsonb NOT NULL CHECK(jsonb_typeof(report)='object'),
 created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE TABLE import_records (
 id text PRIMARY KEY,
 namespace varchar(80) NOT NULL REFERENCES import_batches(namespace) ON DELETE RESTRICT,
 entity_type varchar(80) NOT NULL,
 source_id varchar(150) NOT NULL,
 target_id text,
 disposition varchar(40) NOT NULL CHECK(disposition IN ('imported','quarantined','excluded_by_owner','credential_reset_required')),
 payload jsonb NOT NULL,
 UNIQUE(namespace,entity_type,source_id)
);
CREATE INDEX import_records_namespace_entity_type_idx ON import_records(namespace,entity_type);
CREATE TRIGGER import_batches_immutable BEFORE UPDATE OR DELETE ON import_batches FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER import_records_immutable BEFORE UPDATE OR DELETE ON import_records FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TABLE mutation_drafts (
 id text PRIMARY KEY,
 actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 request_key varchar(150) NOT NULL,
 action varchar(64) NOT NULL CHECK(action IN ('createClient','createLesson','createLessonWithClients','recordPayment','recordAdjustment')),
 fingerprint char(64) NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 state varchar(20) NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','closed','acknowledged')),
 created_at timestamptz(3) NOT NULL DEFAULT now(),
 UNIQUE(actor_id,request_key)
);
CREATE INDEX mutation_drafts_actor_id_state_created_at_idx ON mutation_drafts(actor_id,state,created_at);
COMMIT;
