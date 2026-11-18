-- Migration 018: bulk approve-and-publish for administrators.
-- A one-owner bank has nobody else to run the two review gates, so an
-- administrator may approve many versions at once, including their own.
-- Each version still has to pass every content check (answer key, explanation),
-- and every approval is recorded in reviews and audit_logs as a bulk owner approval.
-- No BEGIN/COMMIT here: scripts/migrate.ts wraps every file in one transaction.

-- The self-review block stays on everywhere except inside bulk_approve_publish,
-- which sets app.owner_bulk_approval for its own transaction only.
CREATE OR REPLACE FUNCTION reviews_block_self_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('app.owner_bulk_approval', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM question_versions v
             WHERE v.id = NEW.question_version_id AND v.author_id = NEW.reviewer_id) THEN
    RAISE EXCEPTION 'authors cannot review their own question versions';
  END IF;
  RETURN NEW;
END $$;

-- Returns {"published": [ids], "failed": [{"id", "code", "publicCode"}]}.
-- Codes: E_NOT_FOUND, E_STATE, E_KEY, E_EXPLANATION, E_OTHER.
CREATE OR REPLACE FUNCTION bulk_approve_publish(p_versions uuid[], p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  vid uuid;
  v question_versions%ROWTYPE;
  total integer;
  correct integer;
  ok jsonb := '[]'::jsonb;
  bad jsonb := '[]'::jsonb;
  code text;
  checklist constant jsonb := '{"technical": true, "outlineMapping": true, "language": true, "ambiguity": true,
    "singleAnswer": true, "distractors": true, "difficulty": true, "biasFairness": true, "bulkOwnerApproval": true}';
BEGIN
  PERFORM set_config('app.owner_bulk_approval', 'on', true);
  FOREACH vid IN ARRAY p_versions LOOP
    BEGIN
      SELECT * INTO v FROM question_versions WHERE id = vid FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'E_NOT_FOUND'; END IF;
      IF v.workflow_state NOT IN ('draft', 'expert_review', 'language_qa', 'approved') THEN RAISE EXCEPTION 'E_STATE'; END IF;
      SELECT count(*), count(*) FILTER (WHERE is_correct) INTO total, correct
      FROM options WHERE question_version_id = vid;
      IF total < 2 OR (v.type_code = 'single' AND correct <> 1)
         OR (v.type_code = 'multiple' AND (correct < 2 OR correct >= total)) THEN
        RAISE EXCEPTION 'E_KEY';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM explanations WHERE question_version_id = vid) THEN
        RAISE EXCEPTION 'E_EXPLANATION';
      END IF;
      IF v.workflow_state = 'draft' THEN
        UPDATE question_versions SET workflow_state = 'expert_review', originality_declared_at = now() WHERE id = vid;
        v.workflow_state := 'expert_review';
      END IF;
      IF v.workflow_state = 'expert_review' THEN
        INSERT INTO reviews (question_version_id, reviewer_id, gate, decision, checklist, comment)
        VALUES (vid, p_actor, 'expert_review', 'approved', checklist, 'Bulk approval by administrator');
        v.workflow_state := 'language_qa';
      END IF;
      IF v.workflow_state = 'language_qa' THEN
        INSERT INTO reviews (question_version_id, reviewer_id, gate, decision, checklist, comment)
        VALUES (vid, p_actor, 'language_qa', 'approved', checklist, 'Bulk approval by administrator');
      END IF;
      UPDATE question_versions SET workflow_state = 'approved',
             originality_declared_at = coalesce(originality_declared_at, now())
      WHERE id = vid;
      INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before, after)
      VALUES (p_actor, 'question.bulk_approve', 'question_version', vid::text,
              jsonb_build_object('state', v.workflow_state), jsonb_build_object('state', 'approved'));
      PERFORM publish_question_version(vid, p_actor);
      ok := ok || to_jsonb(vid);
    EXCEPTION WHEN OTHERS THEN
      code := CASE WHEN SQLERRM IN ('E_NOT_FOUND', 'E_STATE', 'E_KEY', 'E_EXPLANATION') THEN SQLERRM ELSE 'E_OTHER' END;
      bad := bad || jsonb_build_object('id', vid, 'code', code,
               'publicCode', (SELECT q.public_code FROM question_versions x JOIN questions q ON q.id = x.question_id WHERE x.id = vid));
    END;
  END LOOP;
  PERFORM set_config('app.owner_bulk_approval', 'off', true);
  RETURN jsonb_build_object('published', ok, 'failed', bad);
END $$;
