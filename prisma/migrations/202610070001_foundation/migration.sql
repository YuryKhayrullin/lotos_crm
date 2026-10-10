BEGIN;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'coach');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('pending', 'active', 'disabled');

-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('active', 'paused', 'archived');

-- CreateEnum
CREATE TYPE "Category" AS ENUM ('swimming', 'synchronized_swimming');

-- CreateEnum
CREATE TYPE "LessonStatus" AS ENUM ('scheduled', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('active', 'removed');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('attended', 'absent');

-- CreateEnum
CREATE TYPE "LedgerType" AS ENUM ('opening_balance', 'purchase', 'attendance', 'attendance_correction', 'adjustment', 'audit_repair');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "username" TEXT,
    "role" "Role" NOT NULL DEFAULT 'coach',
    "status" "UserStatus" NOT NULL DEFAULT 'pending',
    "auth_version" INTEGER NOT NULL DEFAULT 1,
    "branch_id" TEXT,
    "disabled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "auth_version" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "password" TEXT,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMPTZ(3),
    "refresh_token_expires_at" TIMESTAMPTZ(3),
    "scope" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branches" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "address" VARCHAR(300) NOT NULL,
    "time_zone" VARCHAR(100) NOT NULL DEFAULT 'Europe/Moscow',
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coaches" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "branch_id" TEXT NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "phone" VARCHAR(40),
    "birth_date" DATE,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coaches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "child_name" VARCHAR(150) NOT NULL,
    "parent_name" VARCHAR(150) NOT NULL,
    "phone" VARCHAR(40),
    "email" VARCHAR(254),
    "birth_date" DATE,
    "category" "Category" NOT NULL DEFAULT 'swimming',
    "lessons_per_week" INTEGER NOT NULL DEFAULT 1,
    "status" "ClientStatus" NOT NULL DEFAULT 'active',
    "remaining_lessons" INTEGER NOT NULL DEFAULT 0,
    "total_lessons" INTEGER NOT NULL DEFAULT 0,
    "ledger_version" INTEGER NOT NULL DEFAULT 0,
    "paid_amount_minor" BIGINT NOT NULL DEFAULT 0,
    "payment_balance_minor" BIGINT NOT NULL DEFAULT 0,
    "purchased_at" TIMESTAMPTZ(3),
    "comment" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lesson_series" (
    "id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "title" VARCHAR(150) NOT NULL,
    "location" VARCHAR(150),
    "category" "Category" NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "local_time" TIME(0) NOT NULL,
    "time_zone" VARCHAR(100) NOT NULL,
    "weekdays" INTEGER[],
    "interval_weeks" INTEGER NOT NULL DEFAULT 1,
    "duration_minutes" INTEGER NOT NULL DEFAULT 60,
    "cancelled_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lesson_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "series_enrollments" (
    "id" TEXT NOT NULL,
    "series_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'active',
    "effective_from" DATE NOT NULL,
    "effective_until" DATE,

    CONSTRAINT "series_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lessons" (
    "id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "coach_id" TEXT NOT NULL,
    "series_id" TEXT,
    "created_by_id" TEXT NOT NULL,
    "title" VARCHAR(150) NOT NULL,
    "location" VARCHAR(150),
    "category" "Category" NOT NULL,
    "local_date" DATE NOT NULL,
    "time_zone" VARCHAR(100) NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "LessonStatus" NOT NULL DEFAULT 'scheduled',
    "capacity" INTEGER NOT NULL DEFAULT 10,
    "version" INTEGER NOT NULL DEFAULT 1,
    "cancellation_reason" VARCHAR(500),
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "lessons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lesson_enrollments" (
    "id" TEXT NOT NULL,
    "lesson_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(3),

    CONSTRAINT "lesson_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance" (
    "id" TEXT NOT NULL,
    "enrollment_id" TEXT NOT NULL,
    "lesson_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_events" (
    "id" TEXT NOT NULL,
    "attendance_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "previous_status" "AttendanceStatus",
    "status" "AttendanceStatus" NOT NULL,
    "version" INTEGER NOT NULL,
    "reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'RUB',
    "category" "Category" NOT NULL,
    "lessons_per_week" INTEGER NOT NULL,
    "package_price_minor" BIGINT NOT NULL,
    "package_lessons" INTEGER NOT NULL,
    "packages_count" INTEGER NOT NULL,
    "lessons_added" INTEGER NOT NULL,
    "paid_at" TIMESTAMPTZ(3) NOT NULL,
    "comment" VARCHAR(2000),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lesson_ledger" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "payment_id" TEXT,
    "attendance_event_id" TEXT,
    "type" "LedgerType" NOT NULL,
    "lessons_delta" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "total_lessons_delta" INTEGER NOT NULL,
    "balance_before" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "total_before" INTEGER NOT NULL,
    "total_after" INTEGER NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "comment" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lesson_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mutation_requests" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "request_key" VARCHAR(150) NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "result" JSONB NOT NULL,
    "completed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mutation_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "request_id" TEXT,
    "action" VARCHAR(64) NOT NULL,
    "entity_type" VARCHAR(64) NOT NULL,
    "entity_id" TEXT NOT NULL,
    "branch_id" TEXT,
    "changed_fields" TEXT[],
    "reason" VARCHAR(500),
    "source" VARCHAR(64) NOT NULL DEFAULT 'api',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "uploaded_by_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "storage_key" VARCHAR(100) NOT NULL,
    "original_name" VARCHAR(200) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "superseded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_branch_id_status_idx" ON "users"("branch_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "accounts_user_id_idx" ON "accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_id_account_id_key" ON "accounts"("provider_id", "account_id");

-- CreateIndex
CREATE INDEX "verifications_identifier_idx" ON "verifications"("identifier");

-- CreateIndex
CREATE INDEX "verifications_expires_at_idx" ON "verifications"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "coaches_user_id_key" ON "coaches"("user_id");

-- CreateIndex
CREATE INDEX "coaches_branch_id_archived_at_idx" ON "coaches"("branch_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "coaches_id_branch_id_key" ON "coaches"("id", "branch_id");

-- CreateIndex
CREATE INDEX "clients_branch_id_status_child_name_id_idx" ON "clients"("branch_id", "status", "child_name", "id");

-- CreateIndex
CREATE UNIQUE INDEX "clients_id_branch_id_key" ON "clients"("id", "branch_id");

-- CreateIndex
CREATE INDEX "lesson_series_branch_id_start_date_idx" ON "lesson_series"("branch_id", "start_date");

-- CreateIndex
CREATE INDEX "lesson_series_coach_id_branch_id_idx" ON "lesson_series"("coach_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "lesson_series_id_branch_id_key" ON "lesson_series"("id", "branch_id");

-- CreateIndex
CREATE INDEX "series_enrollments_client_id_branch_id_idx" ON "series_enrollments"("client_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "series_enrollments_series_id_client_id_key" ON "series_enrollments"("series_id", "client_id");

-- CreateIndex
CREATE INDEX "lessons_branch_id_local_date_starts_at_idx" ON "lessons"("branch_id", "local_date", "starts_at");

-- CreateIndex
CREATE INDEX "lessons_coach_id_starts_at_idx" ON "lessons"("coach_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "lessons_id_branch_id_key" ON "lessons"("id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "lessons_series_id_local_date_key" ON "lessons"("series_id", "local_date");

-- CreateIndex
CREATE INDEX "lesson_enrollments_client_id_branch_id_status_idx" ON "lesson_enrollments"("client_id", "branch_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "lesson_enrollments_lesson_id_client_id_key" ON "lesson_enrollments"("lesson_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "lesson_enrollments_id_lesson_id_client_id_branch_id_key" ON "lesson_enrollments"("id", "lesson_id", "client_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_enrollment_id_key" ON "attendance"("enrollment_id");

-- CreateIndex
CREATE INDEX "attendance_client_id_updated_at_idx" ON "attendance"("client_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_lesson_id_client_id_key" ON "attendance"("lesson_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_id_client_id_branch_id_key" ON "attendance"("id", "client_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_enrollment_id_lesson_id_client_id_branch_id_key" ON "attendance"("enrollment_id", "lesson_id", "client_id", "branch_id");

-- CreateIndex
CREATE INDEX "attendance_events_request_id_idx" ON "attendance_events"("request_id");

-- CreateIndex
CREATE INDEX "attendance_events_actor_id_idx" ON "attendance_events"("actor_id");

-- CreateIndex
CREATE INDEX "attendance_events_client_id_created_at_idx" ON "attendance_events"("client_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_events_attendance_id_version_key" ON "attendance_events"("attendance_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_events_id_client_id_branch_id_key" ON "attendance_events"("id", "client_id", "branch_id");

-- CreateIndex
CREATE INDEX "payments_client_id_paid_at_idx" ON "payments"("client_id", "paid_at");

-- CreateIndex
CREATE INDEX "payments_branch_id_paid_at_idx" ON "payments"("branch_id", "paid_at");

-- CreateIndex
CREATE INDEX "payments_actor_id_idx" ON "payments"("actor_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_request_id_client_id_key" ON "payments"("request_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_id_client_id_branch_id_key" ON "payments"("id", "client_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "lesson_ledger_payment_id_key" ON "lesson_ledger"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "lesson_ledger_attendance_event_id_key" ON "lesson_ledger"("attendance_event_id");

-- CreateIndex
CREATE INDEX "lesson_ledger_client_id_created_at_id_idx" ON "lesson_ledger"("client_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "lesson_ledger_request_id_idx" ON "lesson_ledger"("request_id");

-- CreateIndex
CREATE INDEX "lesson_ledger_actor_id_idx" ON "lesson_ledger"("actor_id");

-- CreateIndex
CREATE UNIQUE INDEX "lesson_ledger_payment_id_client_id_branch_id_key" ON "lesson_ledger"("payment_id", "client_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "lesson_ledger_client_id_sequence_key" ON "lesson_ledger"("client_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "lesson_ledger_attendance_event_id_client_id_branch_id_key" ON "lesson_ledger"("attendance_event_id", "client_id", "branch_id");

-- CreateIndex
CREATE INDEX "mutation_requests_completed_at_idx" ON "mutation_requests"("completed_at");

-- CreateIndex
CREATE UNIQUE INDEX "mutation_requests_actor_id_request_key_key" ON "mutation_requests"("actor_id", "request_key");

-- CreateIndex
CREATE UNIQUE INDEX "mutation_requests_id_actor_id_key" ON "mutation_requests"("id", "actor_id");

-- CreateIndex
CREATE INDEX "audit_events_entity_type_entity_id_created_at_idx" ON "audit_events"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_branch_id_created_at_idx" ON "audit_events"("branch_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_actor_id_idx" ON "audit_events"("actor_id");

-- CreateIndex
CREATE INDEX "audit_events_request_id_idx" ON "audit_events"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "documents_storage_key_key" ON "documents"("storage_key");

-- CreateIndex
CREATE INDEX "documents_client_id_created_at_idx" ON "documents"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "documents_uploaded_by_id_idx" ON "documents"("uploaded_by_id");

-- CreateIndex
CREATE INDEX "documents_request_id_idx" ON "documents"("request_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coaches" ADD CONSTRAINT "coaches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coaches" ADD CONSTRAINT "coaches_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_series" ADD CONSTRAINT "lesson_series_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_series" ADD CONSTRAINT "lesson_series_coach_id_branch_id_fkey" FOREIGN KEY ("coach_id", "branch_id") REFERENCES "coaches"("id", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "series_enrollments" ADD CONSTRAINT "series_enrollments_series_id_branch_id_fkey" FOREIGN KEY ("series_id", "branch_id") REFERENCES "lesson_series"("id", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "series_enrollments" ADD CONSTRAINT "series_enrollments_client_id_branch_id_fkey" FOREIGN KEY ("client_id", "branch_id") REFERENCES "clients"("id", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_coach_id_branch_id_fkey" FOREIGN KEY ("coach_id", "branch_id") REFERENCES "coaches"("id", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_series_id_branch_id_fkey" FOREIGN KEY ("series_id", "branch_id") REFERENCES "lesson_series"("id", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_enrollments" ADD CONSTRAINT "lesson_enrollments_lesson_id_branch_id_fkey" FOREIGN KEY ("lesson_id", "branch_id") REFERENCES "lessons"("id", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_enrollments" ADD CONSTRAINT "lesson_enrollments_client_id_branch_id_fkey" FOREIGN KEY ("client_id", "branch_id") REFERENCES "clients"("id", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_enrollment_id_lesson_id_client_id_branch_id_fkey" FOREIGN KEY ("enrollment_id", "lesson_id", "client_id", "branch_id") REFERENCES "lesson_enrollments"("id", "lesson_id", "client_id", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_attendance_id_client_id_branch_id_fkey" FOREIGN KEY ("attendance_id", "client_id", "branch_id") REFERENCES "attendance"("id", "client_id", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_request_id_actor_id_fkey" FOREIGN KEY ("request_id", "actor_id") REFERENCES "mutation_requests"("id", "actor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_client_id_branch_id_fkey" FOREIGN KEY ("client_id", "branch_id") REFERENCES "clients"("id", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_request_id_actor_id_fkey" FOREIGN KEY ("request_id", "actor_id") REFERENCES "mutation_requests"("id", "actor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_ledger" ADD CONSTRAINT "lesson_ledger_client_id_branch_id_fkey" FOREIGN KEY ("client_id", "branch_id") REFERENCES "clients"("id", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_ledger" ADD CONSTRAINT "lesson_ledger_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_ledger" ADD CONSTRAINT "lesson_ledger_request_id_actor_id_fkey" FOREIGN KEY ("request_id", "actor_id") REFERENCES "mutation_requests"("id", "actor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_ledger" ADD CONSTRAINT "lesson_ledger_payment_id_client_id_branch_id_fkey" FOREIGN KEY ("payment_id", "client_id", "branch_id") REFERENCES "payments"("id", "client_id", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_ledger" ADD CONSTRAINT "lesson_ledger_attendance_event_id_client_id_branch_id_fkey" FOREIGN KEY ("attendance_event_id", "client_id", "branch_id") REFERENCES "attendance_events"("id", "client_id", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mutation_requests" ADD CONSTRAINT "mutation_requests_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_request_id_actor_id_fkey" FOREIGN KEY ("request_id", "actor_id") REFERENCES "mutation_requests"("id", "actor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_client_id_branch_id_fkey" FOREIGN KEY ("client_id", "branch_id") REFERENCES "clients"("id", "branch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_request_id_uploaded_by_id_fkey" FOREIGN KEY ("request_id", "uploaded_by_id") REFERENCES "mutation_requests"("id", "actor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
