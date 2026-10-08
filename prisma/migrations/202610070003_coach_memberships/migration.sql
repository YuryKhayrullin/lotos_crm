BEGIN;

CREATE TABLE "coach_branches" (
  "id" TEXT NOT NULL,
  "coach_id" TEXT NOT NULL,
  "branch_id" TEXT NOT NULL,
  "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at" TIMESTAMPTZ(3),
  CONSTRAINT "coach_branches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "coach_branches_dates_valid" CHECK (ended_at >= assigned_at)
);
CREATE UNIQUE INDEX "coach_branches_coach_id_branch_id_key" ON "coach_branches" ("coach_id", "branch_id");
CREATE INDEX "coach_branches_branch_id_ended_at_idx" ON "coach_branches" ("branch_id", "ended_at");
ALTER TABLE "coach_branches" ADD CONSTRAINT "coach_branches_coach_id_fkey"
  FOREIGN KEY ("coach_id") REFERENCES "coaches" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "coach_branches" ADD CONSTRAINT "coach_branches_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "branches" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Existing lessons already obeyed the old coach/branch composite FK. Preserve
-- this association before changing those FKs; no lesson or person is moved.
INSERT INTO "coach_branches" ("id", "coach_id", "branch_id", "assigned_at")
  SELECT 'coach-branch:' || id || ':' || branch_id, id, branch_id, created_at FROM "coaches";

ALTER TABLE "lesson_series" DROP CONSTRAINT "lesson_series_coach_id_branch_id_fkey";
ALTER TABLE "lessons" DROP CONSTRAINT "lessons_coach_id_branch_id_fkey";
ALTER TABLE "lesson_series" ADD CONSTRAINT "lesson_series_coach_id_fkey"
  FOREIGN KEY ("coach_id") REFERENCES "coaches" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_coach_id_fkey"
  FOREIGN KEY ("coach_id") REFERENCES "coaches" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "lesson_series" ADD CONSTRAINT "lesson_series_coach_id_branch_id_fkey"
  FOREIGN KEY ("coach_id", "branch_id") REFERENCES "coach_branches" ("coach_id", "branch_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_coach_id_branch_id_fkey"
  FOREIGN KEY ("coach_id", "branch_id") REFERENCES "coach_branches" ("coach_id", "branch_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

COMMIT;
