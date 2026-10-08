BEGIN;
ALTER TABLE lessons ADD COLUMN roster_confirmed boolean NOT NULL DEFAULT false;
ALTER TABLE attendance_events ADD COLUMN lesson_snapshot jsonb NOT NULL DEFAULT '{}';
CREATE TABLE attendance_drafts (
  id text PRIMARY KEY,
  actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  lesson_id text NOT NULL REFERENCES lessons(id) ON DELETE RESTRICT,
  request_key varchar(150) NOT NULL CHECK (length(btrim(request_key)) > 0),
  fingerprint char(64) NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX attendance_drafts_actor_id_request_key_key ON attendance_drafts(actor_id, request_key);
CREATE INDEX attendance_drafts_actor_id_lesson_id_created_at_idx ON attendance_drafts(actor_id, lesson_id, created_at);
COMMIT;
