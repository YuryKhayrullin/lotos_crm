BEGIN;
ALTER TABLE accounts ADD CONSTRAINT accounts_credential_identity CHECK (provider_id <> 'credential' OR account_id = user_id);
CREATE TABLE auth_rate_buckets (
  key CHAR(64) PRIMARY KEY,
  hits INTEGER NOT NULL,
  expires_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT auth_rate_buckets_valid CHECK (key ~ '^[a-f0-9]{64}$' AND hits BETWEEN 1 AND 1000000)
);
CREATE INDEX auth_rate_buckets_expires_at_idx ON auth_rate_buckets(expires_at);
CREATE TABLE registration_attempts (
  key CHAR(64) PRIMARY KEY,
  fingerprint CHAR(64) NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT registration_attempts_valid CHECK (key ~ '^[a-f0-9]{64}$' AND fingerprint ~ '^[a-f0-9]{64}$')
);
CREATE INDEX registration_attempts_user_id_idx ON registration_attempts(user_id);
CREATE TRIGGER registration_attempts_immutable BEFORE UPDATE OR DELETE ON registration_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
COMMIT;
