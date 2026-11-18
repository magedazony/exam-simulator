-- Migration 019: import can update questions that already exist.
-- A question is found by its normalised stem (English stem, or the Arabic stem for
-- questions that were first imported in Arabic only). Drafts are edited in place;
-- a published or withdrawn question gets a new version holding the new content, which
-- replaces the old one when it is published. Questions that are in review are left alone.
-- No BEGIN/COMMIT here: scripts/migrate.ts wraps every file in one transaction.

-- Returns the existing question id for a document, or NULL.
CREATE OR REPLACE FUNCTION find_question_by_stem(p_norms jsonb) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT v.question_id
  FROM question_versions v
  JOIN questions q ON q.id = v.question_id
  WHERE lower(regexp_replace(btrim(v.stem), '\s+', ' ', 'g')) IN (SELECT jsonb_array_elements_text(p_norms))
  ORDER BY q.created_at, v.version_no DESC
  LIMIT 1;
$$;

-- Returns {"action": "updated"|"new_version"|"skipped", "versionId": uuid|null}.
CREATE OR REPLACE FUNCTION update_question_by_stem(p_actor uuid, p_blueprint uuid, p_norms jsonb, p_doc jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  qid uuid := find_question_by_stem(p_norms);
  latest question_versions%ROWTYPE;
  vid uuid;
BEGIN
  IF qid IS NULL THEN RETURN jsonb_build_object('action', 'skipped', 'versionId', NULL); END IF;
  SELECT * INTO latest FROM question_versions WHERE question_id = qid ORDER BY version_no DESC LIMIT 1;
  IF latest.workflow_state = 'draft' THEN
    PERFORM update_question_draft(latest.id, p_actor, true, p_blueprint, p_doc);
    RETURN jsonb_build_object('action', 'updated', 'versionId', latest.id);
  ELSIF latest.workflow_state IN ('published', 'withdrawn') THEN
    vid := new_question_version(qid, p_actor);
    PERFORM update_question_draft(vid, p_actor, true, p_blueprint, p_doc);
    RETURN jsonb_build_object('action', 'new_version', 'versionId', vid);
  END IF;
  RETURN jsonb_build_object('action', 'skipped', 'versionId', latest.id);
END $$;
