BEGIN;
ALTER TABLE clients ADD COLUMN receipt_document_id text, ADD COLUMN receipt_version integer NOT NULL DEFAULT 0 CHECK (receipt_version >= 0);
ALTER TABLE documents ADD CONSTRAINT documents_id_client_id_branch_id_key UNIQUE (id, client_id, branch_id);
ALTER TABLE clients ADD CONSTRAINT clients_receipt_document_id_id_branch_id_fkey FOREIGN KEY (receipt_document_id,id,branch_id) REFERENCES documents(id,client_id,branch_id) ON DELETE RESTRICT ON UPDATE RESTRICT;
-- Keep old files and their metadata. Selecting a current document does not
-- delete/rewrite any financial or attendance history.
WITH ranked AS (SELECT id,client_id,row_number() OVER (PARTITION BY client_id ORDER BY created_at DESC,id DESC) AS position FROM documents WHERE superseded_at IS NULL)
UPDATE documents SET superseded_at=now() WHERE id IN (SELECT id FROM ranked WHERE position>1);
UPDATE clients c SET receipt_document_id=d.id,receipt_version=1 FROM documents d WHERE d.client_id=c.id AND d.superseded_at IS NULL;
CREATE UNIQUE INDEX documents_one_current_per_client ON documents(client_id) WHERE superseded_at IS NULL;
CREATE TABLE document_uploads (
  id text PRIMARY KEY,
  actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  client_id text NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  request_key varchar(150) NOT NULL CHECK (length(btrim(request_key))>0),
  fingerprint char(64) NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  storage_key varchar(100) NOT NULL UNIQUE CHECK (storage_key ~ '^[a-f0-9]{32}$'),
  state varchar(20) NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','attached')),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (actor_id,request_key)
);
CREATE INDEX document_uploads_state_created_at_idx ON document_uploads(state,created_at);
COMMIT;
