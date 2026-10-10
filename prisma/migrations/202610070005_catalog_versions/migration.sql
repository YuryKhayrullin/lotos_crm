BEGIN;
ALTER TABLE clients ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE coaches ADD COLUMN specialty varchar(150) NOT NULL DEFAULT 'Тренер';
COMMIT;
