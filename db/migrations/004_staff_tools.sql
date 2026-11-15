-- Migration 004: staff tools.
-- Two-factor sign-in for staff, question authoring and versioning, the
-- review workflow as one guarded function, import support, question-report
-- triage, and blueprint versions that reuse the bank by task code.

-- ------------------------------------------------------------ two-factor
ALTER TABLE users
  ADD COLUMN totp_secret_enc text,
  ADD COLUMN totp_pending_enc text,
  ADD COLUMN totp_enabled_at timestamptz,
  -- Last accepted time step; a code can be used only once.
  ADD COLUMN totp_last_step bigint NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN mfa boolean NOT NULL DEFAULT false;

-- ------------------------------------------------------------ reviews
-- Orders reviews reliably, so that approvals given before a return no
-- longer count towards publishing.
ALTER TABLE reviews ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
CREATE INDEX reviews_seq_idx ON reviews (question_version_id, seq);

CREATE OR REPLACE FUNCTION publish_question_version(p_version uuid, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v question_versions%ROWTYPE;
  gates integer;
BEGIN
  SELECT * INTO v FROM question_versions WHERE id = p_version FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'question version not found'; END IF;
  IF v.workflow_state <> 'approved' THEN
    RAISE EXCEPTION 'only an approved version can be published (state is %)', v.workflow_state;
  END IF;
  IF v.originality_declared_at IS NULL THEN
    RAISE EXCEPTION 'originality declaration is missing';
  END IF;
  SELECT count(DISTINCT gate) INTO gates FROM reviews
  WHERE question_version_id = p_version AND decision = 'approved'
    AND seq > coalesce((SELECT max(seq) FROM reviews
                        WHERE question_version_id = p_version AND decision = 'returned'), 0);
  IF gates < 2 THEN RAISE EXCEPTION 'version has not passed every review gate'; END IF;

  UPDATE question_versions SET workflow_state = 'withdrawn'
  WHERE question_id = v.question_id AND workflow_state = 'published' AND id <> p_version;
  UPDATE question_versions SET workflow_state = 'published', published_at = now() WHERE id = p_version;
  UPDATE questions SET current_version_id = p_version, status = 'published', updated_at = now()
  WHERE id = v.question_id;
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id)
  VALUES (p_actor, 'question.publish', 'question_version', p_version::text);
END $$;

-- ------------------------------------------------------------ authoring
CREATE SEQUENCE question_code_seq;

-- Options and explanation of a draft, replaced as a whole on every save.
CREATE FUNCTION write_draft_content(p_version uuid, p_doc jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM options WHERE question_version_id = p_version;
  INSERT INTO options (question_version_id, ordinal, text, is_correct, rationale)
  SELECT p_version, o.ordinality, o.value->>'text', (o.value->>'isCorrect')::boolean, nullif(o.value->>'rationale', '')
  FROM jsonb_array_elements(p_doc->'options') WITH ORDINALITY o;

  DELETE FROM explanations WHERE question_version_id = p_version;
  IF jsonb_typeof(p_doc->'explanation') = 'object' THEN
    INSERT INTO explanations (question_version_id, language, why_correct, mindset, key_concept, learning_objective)
    VALUES (p_version, coalesce(p_doc->>'language', 'en'), p_doc#>>'{explanation,whyCorrect}',
            p_doc#>>'{explanation,mindset}', p_doc#>>'{explanation,keyConcept}',
            p_doc#>>'{explanation,learningObjective}');
  END IF;
END $$;

CREATE FUNCTION task_by_code(p_blueprint uuid, p_code text) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT t.id FROM tasks t JOIN domains d ON d.id = t.domain_id WHERE d.blueprint_id = p_blueprint AND t.code = p_code;
$$;

CREATE FUNCTION create_question_draft(p_author uuid, p_blueprint uuid, p_doc jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  q_id uuid;
  v_id uuid;
  t_id uuid := task_by_code(p_blueprint, p_doc->>'taskCode');
BEGIN
  IF t_id IS NULL THEN RAISE EXCEPTION 'E_UNKNOWN_TASK'; END IF;
  INSERT INTO questions (public_code) VALUES ('Q-' || lpad(nextval('question_code_seq')::text, 6, '0'))
  RETURNING id INTO q_id;
  INSERT INTO question_versions (question_id, version_no, task_id, approach_code, difficulty_code, type_code,
                                 is_graphic, language, stem, author_id, ai_assisted)
  VALUES (q_id, 1, t_id, p_doc->>'approach', p_doc->>'difficulty', p_doc->>'type',
          coalesce((p_doc->>'graphic')::boolean, false), coalesce(p_doc->>'language', 'en'),
          p_doc->>'stem', p_author, coalesce((p_doc->>'aiAssisted')::boolean, false))
  RETURNING id INTO v_id;
  PERFORM write_draft_content(v_id, p_doc);
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id)
  VALUES (p_author, 'question.create', 'question_version', v_id::text);
  RETURN v_id;
END $$;

CREATE FUNCTION update_question_draft(p_version uuid, p_actor uuid, p_is_admin boolean, p_blueprint uuid, p_doc jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v question_versions%ROWTYPE;
  t_id uuid := task_by_code(p_blueprint, p_doc->>'taskCode');
BEGIN
  SELECT * INTO v FROM question_versions WHERE id = p_version FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'E_NOT_FOUND'; END IF;
  IF v.author_id <> p_actor AND NOT p_is_admin THEN RAISE EXCEPTION 'E_FORBIDDEN'; END IF;
  IF v.workflow_state <> 'draft' THEN RAISE EXCEPTION 'E_STATE'; END IF;
  IF t_id IS NULL THEN RAISE EXCEPTION 'E_UNKNOWN_TASK'; END IF;
  UPDATE question_versions
  SET task_id = t_id, approach_code = p_doc->>'approach', difficulty_code = p_doc->>'difficulty',
      type_code = p_doc->>'type', is_graphic = coalesce((p_doc->>'graphic')::boolean, false),
      language = coalesce(p_doc->>'language', 'en'), stem = p_doc->>'stem',
      ai_assisted = coalesce((p_doc->>'aiAssisted')::boolean, ai_assisted)
  WHERE id = p_version;
  PERFORM write_draft_content(p_version, p_doc);
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id)
  VALUES (p_actor, 'question.edit', 'question_version', p_version::text);
END $$;

-- Starts the next version of a question as a copy of its latest one.
-- Only one version of a question may be open (draft or in review) at a time.
CREATE FUNCTION new_question_version(p_question uuid, p_actor uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  latest question_versions%ROWTYPE;
  v_id uuid;
BEGIN
  PERFORM 1 FROM questions WHERE id = p_question FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'E_NOT_FOUND'; END IF;
  SELECT * INTO latest FROM question_versions WHERE question_id = p_question ORDER BY version_no DESC LIMIT 1;
  IF latest.workflow_state NOT IN ('published', 'withdrawn') THEN RAISE EXCEPTION 'E_OPEN_VERSION'; END IF;

  INSERT INTO question_versions (question_id, version_no, task_id, approach_code, difficulty_code, type_code,
                                 is_graphic, case_study_id, case_ordinal, language, stem, body, author_id)
  VALUES (p_question, latest.version_no + 1, latest.task_id, latest.approach_code, latest.difficulty_code,
          latest.type_code, latest.is_graphic, latest.case_study_id, latest.case_ordinal, latest.language,
          latest.stem, latest.body, p_actor)
  RETURNING id INTO v_id;
  INSERT INTO options (question_version_id, ordinal, text, is_correct, rationale)
  SELECT v_id, ordinal, text, is_correct, rationale FROM options WHERE question_version_id = latest.id;
  INSERT INTO explanations (question_version_id, language, why_correct, mindset, key_concept, learning_objective)
  SELECT v_id, language, why_correct, mindset, key_concept, learning_objective
  FROM explanations WHERE question_version_id = latest.id;
  INSERT INTO question_references (question_version_id, reference_id)
  SELECT v_id, reference_id FROM question_references WHERE question_version_id = latest.id;
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before)
  VALUES (p_actor, 'question.new_version', 'question_version', v_id::text, jsonb_build_object('from', latest.id));
  RETURN v_id;
END $$;

-- ------------------------------------------------------------ workflow
-- The whole review workflow in one place. Role checks are repeated in the
-- API; the rules about states, authorship and evidence live here so that no
-- caller can skip them.
CREATE FUNCTION transition_question_version(p_version uuid, p_actor uuid, p_action text, p_comment text,
                                            p_checklist jsonb, p_originality boolean, p_is_admin boolean)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v question_versions%ROWTYPE;
  total integer;
  correct integer;
  passed integer;
  new_state text;
BEGIN
  SELECT * INTO v FROM question_versions WHERE id = p_version FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'E_NOT_FOUND'; END IF;

  IF p_action = 'submit' THEN
    IF v.workflow_state <> 'draft' THEN RAISE EXCEPTION 'E_STATE'; END IF;
    IF v.author_id <> p_actor AND NOT p_is_admin THEN RAISE EXCEPTION 'E_FORBIDDEN'; END IF;
    IF NOT coalesce(p_originality, false) THEN RAISE EXCEPTION 'E_ORIGINALITY'; END IF;
    SELECT count(*), count(*) FILTER (WHERE is_correct) INTO total, correct
    FROM options WHERE question_version_id = p_version;
    IF total < 2 OR (v.type_code = 'single' AND correct <> 1)
       OR (v.type_code = 'multiple' AND (correct < 2 OR correct >= total)) THEN
      RAISE EXCEPTION 'E_KEY';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM explanations WHERE question_version_id = p_version) THEN
      RAISE EXCEPTION 'E_EXPLANATION';
    END IF;
    UPDATE question_versions SET workflow_state = 'expert_review', originality_declared_at = now() WHERE id = p_version;

  ELSIF p_action IN ('approve', 'return') THEN
    IF v.workflow_state NOT IN ('expert_review', 'language_qa') THEN RAISE EXCEPTION 'E_STATE'; END IF;
    IF v.author_id = p_actor THEN RAISE EXCEPTION 'E_SELF_REVIEW'; END IF;
    IF p_action = 'approve' THEN
      SELECT count(*) INTO passed FROM jsonb_each(coalesce(p_checklist, '{}'::jsonb))
      WHERE value = 'true'::jsonb
        AND key IN ('technical', 'outlineMapping', 'language', 'ambiguity', 'singleAnswer',
                    'distractors', 'difficulty', 'biasFairness');
      IF passed <> 8 THEN RAISE EXCEPTION 'E_CHECKLIST'; END IF;
      INSERT INTO reviews (question_version_id, reviewer_id, gate, decision, checklist, comment)
      VALUES (p_version, p_actor, v.workflow_state, 'approved', p_checklist, nullif(trim(p_comment), ''));
      UPDATE question_versions
      SET workflow_state = CASE v.workflow_state WHEN 'expert_review' THEN 'language_qa' ELSE 'approved' END
      WHERE id = p_version;
    ELSE
      IF coalesce(trim(p_comment), '') = '' THEN RAISE EXCEPTION 'E_COMMENT'; END IF;
      INSERT INTO reviews (question_version_id, reviewer_id, gate, decision, checklist, comment)
      VALUES (p_version, p_actor, v.workflow_state, 'returned', coalesce(p_checklist, '{}'::jsonb), trim(p_comment));
      UPDATE question_versions SET workflow_state = 'draft', originality_declared_at = NULL WHERE id = p_version;
    END IF;

  ELSIF p_action = 'publish' THEN
    IF NOT p_is_admin THEN RAISE EXCEPTION 'E_FORBIDDEN'; END IF;
    PERFORM publish_question_version(p_version, p_actor);

  ELSIF p_action = 'withdraw' THEN
    IF NOT p_is_admin THEN RAISE EXCEPTION 'E_FORBIDDEN'; END IF;
    IF v.workflow_state <> 'published' THEN RAISE EXCEPTION 'E_STATE'; END IF;
    PERFORM withdraw_question(v.question_id, p_actor);

  ELSE
    RAISE EXCEPTION 'E_ACTION';
  END IF;

  SELECT workflow_state INTO new_state FROM question_versions WHERE id = p_version;
  IF p_action NOT IN ('publish', 'withdraw') THEN
    INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before, after)
    VALUES (p_actor, 'question.' || p_action, 'question_version', p_version::text,
            jsonb_build_object('state', v.workflow_state), jsonb_build_object('state', new_state));
  END IF;
  RETURN new_state;
END $$;

-- ------------------------------------------------------------ admin views
CREATE FUNCTION admin_question_json(p_version uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', v.id, 'questionId', v.question_id, 'publicCode', q.public_code, 'versionNo', v.version_no,
    'workflowState', v.workflow_state, 'aiAssisted', v.ai_assisted, 'authorId', v.author_id,
    'publishedAt', v.published_at, 'taskCode', t.code, 'approach', v.approach_code,
    'difficulty', v.difficulty_code, 'type', v.type_code, 'graphic', v.is_graphic,
    'caseStudyId', v.case_study_id, 'language', v.language, 'stem', v.stem,
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

-- The latest version of each question, filtered, in public-code order.
CREATE FUNCTION admin_list_questions(p_state text, p_task text, p_after text, p_limit integer)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(admin_question_json(x.id) ORDER BY x.public_code), '[]'::jsonb)
  FROM (
    SELECT l.id, l.public_code FROM (
      SELECT DISTINCT ON (q.id) v.id, q.public_code, v.workflow_state, t.code AS task_code
      FROM questions q
      JOIN question_versions v ON v.question_id = q.id
      JOIN tasks t ON t.id = v.task_id
      ORDER BY q.id, v.version_no DESC) l
    WHERE (p_state IS NULL OR l.workflow_state = p_state)
      AND (p_task IS NULL OR l.task_code = p_task)
      AND (p_after IS NULL OR l.public_code > p_after)
    ORDER BY l.public_code
    LIMIT p_limit) x;
$$;

-- Normalised stems (trimmed, single-spaced, lower case) that already exist in the bank.
CREATE FUNCTION existing_stems(p_norms jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(DISTINCT n), '[]'::jsonb)
  FROM jsonb_array_elements_text(p_norms) n
  WHERE EXISTS (SELECT 1 FROM question_versions v
                WHERE lower(regexp_replace(btrim(v.stem), '\s+', ' ', 'g')) = n);
$$;

CREATE FUNCTION admin_question_reports(p_status text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'publicCode', q.public_code, 'versionNo', v.version_no, 'reason', r.reason,
           'comment', r.comment, 'status', r.status, 'createdAt', r.created_at) ORDER BY r.created_at DESC), '[]'::jsonb)
  FROM (SELECT * FROM question_reports WHERE status = p_status ORDER BY created_at DESC LIMIT 200) r
  JOIN question_versions v ON v.id = r.question_version_id
  JOIN questions q ON q.id = v.question_id;
$$;

-- ------------------------------------------------------------ blueprint versions
-- A new blueprint version gets its own task rows. Questions stay linked to the
-- task rows they were written for and are matched to any blueprint version by
-- domain and task code, so activating a version with the same codes reuses
-- the whole bank. A version that renames or splits tasks needs a remapping
-- migration of the bank first.

CREATE OR REPLACE FUNCTION engine_pool(p_blueprint uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(engine_question(
           v.id,
           CASE WHEN q.status = 'published' AND v.workflow_state = 'published'
                     AND (cs.id IS NULL OR cs.status = 'published')
                THEN 'published' ELSE 'draft' END)), '[]'::jsonb)
  FROM questions q
  JOIN question_versions v ON v.id = coalesce(
         q.current_version_id,
         (SELECT x.id FROM question_versions x WHERE x.question_id = q.id ORDER BY x.version_no DESC LIMIT 1))
  JOIN tasks t ON t.id = v.task_id
  JOIN domains d ON d.id = t.domain_id
  LEFT JOIN case_studies cs ON cs.id = v.case_study_id
  WHERE (d.code, t.code) IN (SELECT d2.code, t2.code FROM domains d2 JOIN tasks t2 ON t2.domain_id = d2.id
                             WHERE d2.blueprint_id = p_blueprint)
    AND q.status <> 'archived'
    AND ((q.status = 'published' AND v.workflow_state = 'published') OR v.case_study_id IS NOT NULL);
$$;

CREATE OR REPLACE FUNCTION create_practice_session(p_user uuid, p_blueprint_code text, p_mode text,
                                        p_filters jsonb, p_count integer)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  bp_id uuid;
  s_id uuid;
  picked integer;
  weak_tasks uuid[];
BEGIN
  SELECT id INTO bp_id FROM exam_blueprints WHERE code = p_blueprint_code AND status = 'active';
  IF bp_id IS NULL THEN RAISE EXCEPTION 'no active blueprint'; END IF;

  IF p_mode = 'weak_areas' THEN
    SELECT array_agg(task_id) INTO weak_tasks FROM (
      SELECT v.task_id, avg(e.is_correct::int) AS accuracy
      FROM user_answer_events(p_user) e JOIN question_versions v ON v.id = e.question_version_id
      GROUP BY v.task_id HAVING count(*) >= 5
      ORDER BY accuracy ASC LIMIT 5) w;
  END IF;

  INSERT INTO practice_sessions (user_id, blueprint_id, mode, filters, question_count)
  VALUES (p_user, bp_id, p_mode, coalesce(p_filters, '{}'::jsonb), p_count)
  RETURNING id INTO s_id;

  INSERT INTO practice_items (session_id, ordinal, question_id, question_version_id)
  SELECT s_id, row_number() OVER (), c.qid, c.vid
  FROM (
    SELECT q.id AS qid, v.id AS vid
    FROM questions q
    JOIN question_versions v ON v.id = q.current_version_id
    JOIN tasks t ON t.id = v.task_id
    JOIN domains d ON d.id = t.domain_id
    WHERE (d.code, t.code) IN (SELECT d2.code, t2.code FROM domains d2 JOIN tasks t2 ON t2.domain_id = d2.id
                               WHERE d2.blueprint_id = bp_id)
      AND q.status = 'published' AND v.workflow_state = 'published' AND v.case_study_id IS NULL
      AND filter_allows(p_filters->'domainCodes', d.code)
      AND filter_allows(p_filters->'taskCodes', t.code)
      AND filter_allows(p_filters->'approaches', v.approach_code)
      AND filter_allows(p_filters->'difficulties', v.difficulty_code)
      AND filter_allows(p_filters->'types', v.type_code)
      AND (weak_tasks IS NULL OR v.task_id = ANY (weak_tasks))
      AND (p_mode <> 'incorrect_only' OR q.id IN (
            SELECT e.question_id FROM user_answer_events(p_user) e
            GROUP BY e.question_id
            HAVING NOT (array_agg(e.is_correct ORDER BY e.answered_at DESC))[1]))
      AND q.id NOT IN (
            SELECT aq.question_id FROM attempt_questions aq
            JOIN exam_attempts ea ON ea.id = aq.attempt_id
            WHERE ea.user_id = p_user AND ea.result IS NULL)
    ORDER BY random()
    LIMIT p_count
  ) c;
  GET DIAGNOSTICS picked = ROW_COUNT;

  IF picked = 0 THEN RAISE EXCEPTION 'no questions match the filters'; END IF;
  UPDATE practice_sessions SET question_count = picked WHERE id = s_id;
  RETURN s_id;
END $$;

