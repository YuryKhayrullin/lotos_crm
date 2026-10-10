BEGIN;
ALTER TABLE mutation_drafts ADD COLUMN requires_credential boolean NOT NULL DEFAULT false;
ALTER TABLE mutation_drafts DROP CONSTRAINT mutation_drafts_action_check;
ALTER TABLE mutation_drafts ADD CONSTRAINT mutation_drafts_action_check CHECK(action IN (
 'createClient','createLesson','createLessonWithClients','recordPayment','recordAdjustment',
 'createBranch','createCoach','updateClient','deleteClient','deleteCoach','updateLesson','cancelLesson','deleteLesson',
 'assignClientLesson','repairLessonLedger','assignUserBranch','deactivateUser','activateUser','resetCoachPassword','revokeUserSessions','linkCoachUser'
));
ALTER TABLE mutation_drafts ADD CONSTRAINT mutation_drafts_no_credentials CHECK(NOT (payload ?| ARRAY['password','newPassword','passwordHash','token','secret','signature']));
COMMIT;
