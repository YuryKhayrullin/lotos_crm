-- Prisma 7 does not express CHECK constraints, functional indexes or immutable
-- history triggers. Keep them versioned here; never replace migrations with db push.
BEGIN;

ALTER TABLE users ADD CONSTRAINT users_username_canonical CHECK (
  username IS NULL OR username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'
);
ALTER TABLE users ADD CONSTRAINT users_email_canonical CHECK (
  email IS NULL OR (email = lower(btrim(email)) AND length(email) > 0)
);
ALTER TABLE users ADD CONSTRAINT users_auth_version_valid CHECK (auth_version > 0);
ALTER TABLE sessions ADD CONSTRAINT sessions_auth_version_valid CHECK (auth_version > 0);

ALTER TABLE clients ADD CONSTRAINT clients_credits_valid CHECK (
  remaining_lessons >= 0 AND total_lessons >= 0 AND remaining_lessons <= total_lessons AND ledger_version >= 0
);
ALTER TABLE clients ADD CONSTRAINT clients_money_valid CHECK (
  paid_amount_minor >= 0 AND payment_balance_minor >= 0
);
ALTER TABLE clients ADD CONSTRAINT clients_frequency_valid CHECK (lessons_per_week IN (1, 2, 3));
ALTER TABLE clients ADD CONSTRAINT clients_names_valid CHECK (
  length(btrim(child_name)) > 0 AND length(btrim(parent_name)) > 0
);
ALTER TABLE coaches ADD CONSTRAINT coaches_name_valid CHECK (length(btrim(name)) > 0);
ALTER TABLE branches ADD CONSTRAINT branches_name_valid CHECK (length(btrim(name)) > 0);
ALTER TABLE clients ADD CONSTRAINT clients_birth_date_valid CHECK (birth_date >= DATE '1900-01-01');
ALTER TABLE coaches ADD CONSTRAINT coaches_birth_date_valid CHECK (birth_date >= DATE '1900-01-01');

ALTER TABLE lesson_series ADD CONSTRAINT lesson_series_dates_valid CHECK (end_date >= start_date);
ALTER TABLE lesson_series ADD CONSTRAINT lesson_series_schedule_valid CHECK (
  interval_weeks BETWEEN 1 AND 52 AND duration_minutes BETWEEN 1 AND 1440
  AND cardinality(weekdays) BETWEEN 1 AND 7
  AND weekdays <@ ARRAY[0,1,2,3,4,5,6] AND array_position(weekdays, NULL) IS NULL AND version > 0
);
ALTER TABLE series_enrollments ADD CONSTRAINT series_enrollments_dates_valid CHECK (effective_until >= effective_from);
ALTER TABLE lessons ADD CONSTRAINT lessons_time_valid CHECK (
  ends_at > starts_at AND local_date = (starts_at AT TIME ZONE time_zone)::date
);
ALTER TABLE lessons ADD CONSTRAINT lessons_limits_valid CHECK (capacity BETWEEN 1 AND 100 AND version > 0);
ALTER TABLE lessons ADD CONSTRAINT lessons_cancellation_valid CHECK (
  (status = 'cancelled' AND cancelled_at IS NOT NULL AND length(btrim(cancellation_reason)) > 0 AND cancellation_reason IS NOT NULL)
  OR (status <> 'cancelled' AND cancelled_at IS NULL AND cancellation_reason IS NULL)
);
ALTER TABLE attendance ADD CONSTRAINT attendance_version_valid CHECK (version > 0);
ALTER TABLE attendance_events ADD CONSTRAINT attendance_events_version_valid CHECK (version > 0);

ALTER TABLE payments ADD CONSTRAINT payments_amount_valid CHECK (
  amount_minor > 0 AND package_price_minor > 0 AND currency = 'RUB'
);
ALTER TABLE payments ADD CONSTRAINT payments_package_valid CHECK (
  lessons_per_week IN (1,2,3) AND package_lessons > 0 AND packages_count > 0
  AND lessons_added > 0 AND lessons_added = package_lessons::bigint * packages_count
);
ALTER TABLE lesson_ledger ADD CONSTRAINT lesson_ledger_balances_valid CHECK (
  sequence > 0 AND balance_before >= 0 AND balance_after >= 0 AND total_before >= 0 AND total_after >= 0
  AND balance_before <= total_before AND balance_after <= total_after
  AND balance_before::bigint + lessons_delta = balance_after
  AND total_before::bigint + total_lessons_delta = total_after
);
ALTER TABLE lesson_ledger ADD CONSTRAINT lesson_ledger_references_valid CHECK (
  NOT (payment_id IS NOT NULL AND attendance_event_id IS NOT NULL)
  AND (type <> 'purchase' OR (payment_id IS NOT NULL AND lessons_delta >= 0 AND total_lessons_delta = lessons_delta))
  AND (type NOT IN ('attendance', 'attendance_correction') OR (attendance_event_id IS NOT NULL AND total_lessons_delta = 0 AND lessons_delta BETWEEN -1 AND 1))
  AND length(btrim(reason)) > 0
);
ALTER TABLE mutation_requests ADD CONSTRAINT mutation_requests_key_valid CHECK (
  length(btrim(request_key)) > 0 AND length(btrim(action)) > 0 AND fingerprint ~ '^[a-f0-9]{64}$'
);
ALTER TABLE audit_events ADD CONSTRAINT audit_events_actor_valid CHECK (request_id IS NULL OR actor_id IS NOT NULL);
ALTER TABLE documents ADD CONSTRAINT documents_private_key_valid CHECK (storage_key ~ '^[a-zA-Z0-9_-]{20,100}$');
ALTER TABLE documents ADD CONSTRAINT documents_file_valid CHECK (
  size_bytes BETWEEN 1 AND 5242880 AND sha256 ~ '^[a-f0-9]{64}$'
  AND mime_type IN ('image/jpeg', 'image/png', 'application/pdf') AND length(btrim(original_name)) > 0
);

CREATE INDEX clients_child_name_prefix_idx ON clients (branch_id, lower(child_name) text_pattern_ops);
CREATE INDEX clients_parent_name_prefix_idx ON clients (branch_id, lower(parent_name) text_pattern_ops);

-- History and durable confirmations cannot be rewritten by an ordinary UPDATE
-- or DELETE. Corrections are new rows; controlled migrations can alter triggers.
CREATE FUNCTION reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'History is append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER attendance_events_immutable BEFORE UPDATE OR DELETE ON attendance_events
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER lesson_ledger_immutable BEFORE UPDATE OR DELETE ON lesson_ledger
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER payments_immutable BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER mutation_requests_immutable BEFORE UPDATE OR DELETE ON mutation_requests
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

COMMIT;
