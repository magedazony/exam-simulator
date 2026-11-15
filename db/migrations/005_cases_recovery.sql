-- Migration 005: case-study authoring and two-factor recovery codes.

-- ------------------------------------------------------------ recovery codes
CREATE TABLE mfa_recovery_codes (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at   timestamptz,
  PRIMARY KEY (user_id, code_hash)
);

-- Replaces all of a user's recovery codes with a new set (hashes only).
CREATE FUNCTION replace_recovery_codes(p_user uuid, p_hashes jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM mfa_recovery_codes WHERE user_id = p_user;
  INSERT INTO mfa_recovery_codes (user_id, code_hash)
  SELECT p_user, h FROM jsonb_array_elements_text(p_hashes) h;
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id)
  VALUES (p_user, 'user.mfa_recovery_codes_issued', 'user', p_user::text);
END $$;

-- Uses one recovery code. False if unknown or already used.
CREATE FUNCTION use_recovery_code(p_user uuid, p_hash text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  UPDATE mfa_recovery_codes SET used_at = now()
  WHERE user_id = p_user AND code_hash = p_hash AND used_at IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id)
  VALUES (p_user, 'user.mfa_recovery_code_used', 'user', p_user::text);
  RETURN true;
END $$;

-- ------------------------------------------------------------ case studies
CREATE SEQUENCE case_study_code_seq;

CREATE FUNCTION create_case_study(p_author uuid, p_doc jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  c_id uuid;
BEGIN
  INSERT INTO case_studies (public_code, title, scenario, language, status, created_by)
  VALUES ('CS-' || lpad(nextval('case_study_code_seq')::text, 4, '0'), p_doc->>'title', p_doc->>'scenario',
          coalesce(p_doc->>'language', 'en'), 'draft', p_author)
  RETURNING id INTO c_id;
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id)
  VALUES (p_author, 'case.create', 'case_study', c_id::text);
  RETURN c_id;
END $$;

-- A published case study is not edited in place: withdraw it and write a new one.
CREATE FUNCTION update_case_study(p_case uuid, p_actor uuid, p_is_admin boolean, p_doc jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  c case_studies%ROWTYPE;
BEGIN
  SELECT * INTO c FROM case_studies WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'E_NOT_FOUND'; END IF;
  IF c.created_by <> p_actor AND NOT p_is_admin THEN RAISE EXCEPTION 'E_FORBIDDEN'; END IF;
  IF c.status <> 'draft' THEN RAISE EXCEPTION 'E_STATE'; END IF;
  UPDATE case_studies SET title = p_doc->>'title', scenario = p_doc->>'scenario',
                          language = coalesce(p_doc->>'language', 'en'), updated_at = now()
  WHERE id = p_case;
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id)
  VALUES (p_actor, 'case.edit', 'case_study', p_case::text);
END $$;

-- Latest version of every question that belongs to a case study.
CREATE FUNCTION case_members(p_case uuid)
RETURNS TABLE (version_id uuid, question_id uuid, workflow_state text, case_ordinal smallint)
LANGUAGE sql STABLE AS $$
  SELECT l.id, l.question_id, l.workflow_state, l.case_ordinal FROM (
    SELECT DISTINCT ON (v.question_id) v.id, v.question_id, v.workflow_state, v.case_ordinal, v.case_study_id
    FROM question_versions v
    WHERE v.question_id IN (SELECT question_id FROM question_versions WHERE case_study_id = p_case)
    ORDER BY v.question_id, v.version_no DESC) l
  WHERE l.case_study_id = p_case;
$$;

-- A case study goes public only when it has 2 to 10 questions and every one is published.
CREATE FUNCTION publish_case_study(p_case uuid, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  c case_studies%ROWTYPE;
  total integer;
  ready integer;
BEGIN
  SELECT * INTO c FROM case_studies WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'E_NOT_FOUND'; END IF;
  IF c.status <> 'draft' THEN RAISE EXCEPTION 'E_STATE'; END IF;
  SELECT count(*), count(*) FILTER (WHERE workflow_state = 'published') INTO total, ready FROM case_members(p_case);
  IF total < 2 OR total > 10 THEN RAISE EXCEPTION 'E_CASE_SIZE'; END IF;
  IF ready <> total THEN RAISE EXCEPTION 'E_CASE_NOT_READY'; END IF;
  UPDATE case_studies SET status = 'published', updated_at = now() WHERE id = p_case;
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id)
  VALUES (p_actor, 'case.publish', 'case_study', p_case::text);
END $$;

CREATE FUNCTION withdraw_case_study(p_case uuid, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE case_studies SET status = 'withdrawn', updated_at = now() WHERE id = p_case AND status = 'published';
  IF NOT FOUND THEN RAISE EXCEPTION 'E_STATE'; END IF;
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id)
  VALUES (p_actor, 'case.withdraw', 'case_study', p_case::text);
END $$;

CREATE FUNCTION case_study_json(p_case uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', c.id, 'publicCode', c.public_code, 'title', c.title, 'scenario', c.scenario,
    'language', c.language, 'status', c.status, 'createdBy', c.created_by,
    'questions', coalesce((
      SELECT jsonb_agg(jsonb_build_object('versionId', m.version_id, 'questionId', m.question_id,
               'publicCode', q.public_code, 'caseOrdinal', m.case_ordinal, 'workflowState', m.workflow_state,
               'stem', v.stem) ORDER BY m.case_ordinal)
      FROM case_members(c.id) m
      JOIN questions q ON q.id = m.question_id
      JOIN question_versions v ON v.id = m.version_id), '[]'::jsonb))
  FROM case_studies c WHERE c.id = p_case;
$$;

CREATE FUNCTION list_case_studies(p_status text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'publicCode', c.public_code, 'title', c.title, 'status', c.status,
           'questionCount', (SELECT count(*) FROM case_members(c.id))) ORDER BY c.public_code), '[]'::jsonb)
  FROM case_studies c WHERE p_status IS NULL OR c.status = p_status;
$$;

-- Scenario text for the case studies of an exam section (server builds per-attempt keys).
CREATE FUNCTION case_study_views(p_ids jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title, 'scenario', c.scenario)), '[]'::jsonb)
  FROM case_studies c WHERE c.id::text IN (SELECT jsonb_array_elements_text(p_ids));
$$;

CREATE FUNCTION list_blueprints() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'code', code, 'version', version, 'status', status,
                                               'effectiveFrom', effective_from) ORDER BY version DESC), '[]'::jsonb)
  FROM exam_blueprints;
$$;

-- Drafts may now belong to a case study; the question is appended to the set.
CREATE OR REPLACE FUNCTION create_question_draft(p_author uuid, p_blueprint uuid, p_doc jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  q_id uuid;
  v_id uuid;
  t_id uuid := task_by_code(p_blueprint, p_doc->>'taskCode');
  c_id uuid;
  c_ord smallint;
BEGIN
  IF t_id IS NULL THEN RAISE EXCEPTION 'E_UNKNOWN_TASK'; END IF;
  IF p_doc->>'caseStudyId' IS NOT NULL THEN
    SELECT id INTO c_id FROM case_studies WHERE id = (p_doc->>'caseStudyId')::uuid AND status = 'draft' FOR UPDATE;
    IF c_id IS NULL THEN RAISE EXCEPTION 'E_UNKNOWN_CASE'; END IF;
    SELECT coalesce(max(case_ordinal), 0) + 1 INTO c_ord FROM case_members(c_id);
  END IF;
  INSERT INTO questions (public_code) VALUES ('Q-' || lpad(nextval('question_code_seq')::text, 6, '0'))
  RETURNING id INTO q_id;
  INSERT INTO question_versions (question_id, version_no, task_id, approach_code, difficulty_code, type_code,
                                 is_graphic, language, stem, author_id, ai_assisted, case_study_id, case_ordinal)
  VALUES (q_id, 1, t_id, p_doc->>'approach', p_doc->>'difficulty', p_doc->>'type',
          coalesce((p_doc->>'graphic')::boolean, false), coalesce(p_doc->>'language', 'en'),
          p_doc->>'stem', p_author, coalesce((p_doc->>'aiAssisted')::boolean, false), c_id, c_ord)
  RETURNING id INTO v_id;
  PERFORM write_draft_content(v_id, p_doc);
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id)
  VALUES (p_author, 'question.create', 'question_version', v_id::text);
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION admin_question_json(p_version uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', v.id, 'questionId', v.question_id, 'publicCode', q.public_code, 'versionNo', v.version_no,
    'workflowState', v.workflow_state, 'aiAssisted', v.ai_assisted, 'authorId', v.author_id,
    'publishedAt', v.published_at, 'taskCode', t.code, 'approach', v.approach_code,
    'difficulty', v.difficulty_code, 'type', v.type_code, 'graphic', v.is_graphic,
    'caseStudyId', v.case_study_id, 'caseOrdinal', v.case_ordinal, 'language', v.language, 'stem', v.stem,
    'options', coalesce((SELECT jsonb_agg(jsonb_build_object('text', o.text, 'isCorrect', o.is_correct,
                                                             'rationale', coalesce(o.rationale, ''))
                                          ORDER BY o.ordinal)
                         FROM options o WHERE o.question_version_id = v.id), '[]'::jsonb),
    'explanation', (SELECT jsonb_build_object('whyCorrect', e.why_correct, 'mindset', e.mindset,
                                              'keyConcept', e.key_concept, 'learningObjective', e.learning_objective)
                    FROM explanations e WHERE e.question_version_id = v.id AND e.language = v.language),
    'lastReview', (SELECT jsonb_build_object('gate', r.gate, 'decision', r.decision, 'comment', r.comment,
                                             'at', r.created_at)
                   FROM reviews r WHERE r.question_version_id = v.id ORDER BY r.seq DESC LIMIT 1))
  FROM question_versions v
  JOIN questions q ON q.id = v.question_id
  JOIN tasks t ON t.id = v.task_id
  WHERE v.id = p_version;
$$;
