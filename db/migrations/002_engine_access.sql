-- Migration 002: the database side of the exam engine.
-- Blueprint import and activation, controlled publishing, the JSON the engine
-- reads (blueprint and question pool), and attempt persistence.
-- All application access to exams goes through these functions.

ALTER TABLE exam_attempts
  ADD COLUMN session_state jsonb,
  ADD COLUMN duration_minutes integer CHECK (duration_minutes > 0),
  -- Incremented on every state change; lets concurrent writers detect each other.
  ADD COLUMN state_version integer NOT NULL DEFAULT 0;

-- --------------------------------------------------------------- blueprint

-- Stores a blueprint document (same shape as blueprint-2026-07.json) as a draft.
CREATE FUNCTION import_blueprint(doc jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  bp_id uuid;
  d record;
  d_id uuid;
BEGIN
  INSERT INTO exam_blueprints (code, version, status, effective_from, total_questions, duration_minutes,
                               min_per_task, domain_tolerance_questions, partial_credit)
  VALUES (doc->>'code', (doc->>'version')::integer, 'draft', (doc->>'effectiveFrom')::date,
          (doc->>'totalQuestions')::integer, (doc->>'durationMinutes')::integer,
          (doc->>'minPerTask')::integer, (doc->>'domainToleranceQuestions')::integer,
          coalesce((doc#>>'{scoring,partialCredit}')::boolean, false))
  RETURNING id INTO bp_id;

  FOR d IN SELECT value, ordinality FROM jsonb_array_elements(doc->'domains') WITH ORDINALITY LOOP
    INSERT INTO domains (blueprint_id, code, name, weight_pct, ordinal)
    VALUES (bp_id, d.value->>'id', d.value->>'name', (d.value->>'weightPct')::numeric, d.ordinality)
    RETURNING id INTO d_id;
    INSERT INTO tasks (domain_id, code, name, ordinal)
    SELECT d_id, t.value->>'id', t.value->>'name', t.ordinality
    FROM jsonb_array_elements(d.value->'tasks') WITH ORDINALITY t;
  END LOOP;

  INSERT INTO blueprint_mix_rules (blueprint_id, dimension, keys, target_pct, tolerance_pct, source)
  SELECT bp_id, r->>'dimension', ARRAY(SELECT jsonb_array_elements_text(r->'keys')),
         (r->>'targetPct')::numeric, (r->>'tolerancePct')::numeric, r->>'source'
  FROM jsonb_array_elements(doc->'mixRules') r;

  INSERT INTO blueprint_sections (blueprint_id, ordinal, kind, question_count, break_after_minutes)
  SELECT bp_id, s.ordinality - 1, s.value->>'kind', (s.value->>'questionCount')::integer,
         (s.value->>'breakAfterMinutes')::integer
  FROM jsonb_array_elements(doc->'sections') WITH ORDINALITY s;

  RETURN bp_id;
END $$;

-- Activates a draft blueprint after checking it, and retires the previous one.
CREATE FUNCTION activate_blueprint(p_blueprint uuid, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  bp exam_blueprints%ROWTYPE;
  weights numeric;
  section_total integer;
BEGIN
  SELECT * INTO bp FROM exam_blueprints WHERE id = p_blueprint FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'blueprint not found'; END IF;
  IF bp.status <> 'draft' THEN RAISE EXCEPTION 'only a draft blueprint can be activated'; END IF;

  SELECT coalesce(sum(weight_pct), 0) INTO weights FROM domains WHERE blueprint_id = p_blueprint;
  IF weights <> 100 THEN RAISE EXCEPTION 'domain weights sum to %, expected 100', weights; END IF;
  SELECT coalesce(sum(question_count), 0) INTO section_total FROM blueprint_sections WHERE blueprint_id = p_blueprint;
  IF section_total <> bp.total_questions THEN
    RAISE EXCEPTION 'sections hold % questions, expected %', section_total, bp.total_questions;
  END IF;

  UPDATE exam_blueprints SET status = 'retired' WHERE code = bp.code AND status = 'active';
  UPDATE exam_blueprints SET status = 'active' WHERE id = p_blueprint;
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id)
  VALUES (p_actor, 'blueprint.activate', 'exam_blueprint', p_blueprint::text);
END $$;

-- The blueprint in the exact shape the engine expects.
CREATE FUNCTION engine_blueprint(p_blueprint uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'code', b.code,
    'version', b.version,
    'effectiveFrom', b.effective_from,
    'totalQuestions', b.total_questions,
    'durationMinutes', b.duration_minutes,
    'minPerTask', b.min_per_task,
    'domainToleranceQuestions', b.domain_tolerance_questions,
    'scoring', jsonb_build_object('partialCredit', b.partial_credit),
    'domains', (
      SELECT jsonb_agg(jsonb_build_object(
        'id', d.code, 'name', d.name, 'weightPct', d.weight_pct,
        'tasks', (SELECT jsonb_agg(jsonb_build_object('id', t.code, 'name', t.name) ORDER BY t.ordinal)
                  FROM tasks t WHERE t.domain_id = d.id)) ORDER BY d.ordinal)
      FROM domains d WHERE d.blueprint_id = b.id),
    'mixRules', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'dimension', r.dimension, 'keys', to_jsonb(r.keys), 'targetPct', r.target_pct,
        'tolerancePct', r.tolerance_pct, 'source', r.source) ORDER BY r.dimension, r.keys), '[]'::jsonb)
      FROM blueprint_mix_rules r WHERE r.blueprint_id = b.id),
    'sections', (
      SELECT jsonb_agg(jsonb_build_object(
        'kind', s.kind, 'questionCount', s.question_count, 'breakAfterMinutes', s.break_after_minutes)
        ORDER BY s.ordinal)
      FROM blueprint_sections s WHERE s.blueprint_id = b.id))
  FROM exam_blueprints b WHERE b.id = p_blueprint;
$$;

CREATE FUNCTION active_blueprint(p_code text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('id', b.id, 'blueprint', engine_blueprint(b.id))
  FROM exam_blueprints b WHERE b.code = p_code AND b.status = 'active';
$$;

-- ------------------------------------------------------------- publishing

-- The only way a question version becomes public. Requires the version to be
-- approved and to hold an approval from each review gate. (The trigger on
-- reviews already guarantees that no approval came from the author.)
CREATE FUNCTION publish_question_version(p_version uuid, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
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
  WHERE question_version_id = p_version AND decision = 'approved';
  IF gates < 2 THEN RAISE EXCEPTION 'version has not passed every review gate'; END IF;

  -- Retire the previously published version of the same question, if any.
  UPDATE question_versions SET workflow_state = 'withdrawn'
  WHERE question_id = v.question_id AND workflow_state = 'published' AND id <> p_version;

  UPDATE question_versions SET workflow_state = 'published', published_at = now() WHERE id = p_version;
  UPDATE questions SET current_version_id = p_version, status = 'published', updated_at = now()
  WHERE id = v.question_id;
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id)
  VALUES (p_actor, 'question.publish', 'question_version', p_version::text);
END $$;

CREATE FUNCTION withdraw_question(p_question uuid, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE question_versions SET workflow_state = 'withdrawn'
  WHERE question_id = p_question AND workflow_state = 'published';
  UPDATE questions SET status = 'withdrawn', updated_at = now() WHERE id = p_question;
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id)
  VALUES (p_actor, 'question.withdraw', 'question', p_question::text);
END $$;

-- ------------------------------------------------------- engine question pool

-- One question version in the engine's shape. Contains the answer key:
-- server-side use only.
CREATE FUNCTION engine_question(p_version uuid, p_status text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
      'id', v.question_id,
      'versionId', v.id,
      'status', p_status,
      'domainId', d.code,
      'taskId', t.code,
      'approach', v.approach_code,
      'difficulty', v.difficulty_code,
      'type', v.type_code,
      'graphic', v.is_graphic,
      'stem', v.stem,
      'options', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'id', o.id, 'text', o.text, 'isCorrect', o.is_correct, 'rationale', o.rationale) ORDER BY o.ordinal)
        FROM options o WHERE o.question_version_id = v.id), '[]'::jsonb))
    || CASE WHEN v.case_study_id IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('caseSetId', v.case_study_id, 'caseOrdinal', v.case_ordinal) END
  FROM question_versions v
  JOIN tasks t ON t.id = v.task_id
  JOIN domains d ON d.id = t.domain_id
  WHERE v.id = p_version;
$$;

-- Every question the generator may consider for a blueprint. Case-set
-- questions are always listed, with a non-published status when they or
-- their case study are not public, so the engine can skip the whole set.
CREATE FUNCTION engine_pool(p_blueprint uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
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
  WHERE d.blueprint_id = p_blueprint
    AND q.status <> 'archived'
    AND ((q.status = 'published' AND v.workflow_state = 'published') OR v.case_study_id IS NOT NULL);
$$;

-- ---------------------------------------------------------------- attempts

-- Questions a user met in their most recent mock exams, for repeat exclusion.
CREATE FUNCTION recent_question_ids(p_user uuid, p_attempts integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(DISTINCT aq.question_id), '[]'::jsonb)
  FROM attempt_questions aq
  WHERE aq.attempt_id IN (
    SELECT id FROM exam_attempts WHERE user_id = p_user ORDER BY started_at DESC LIMIT p_attempts);
$$;

-- Stores a generated exam and its initial session state. The partial unique
-- index on exam_attempts guarantees one active attempt per user.
CREATE FUNCTION create_attempt(p_user uuid, p_blueprint uuid, p_form jsonb, p_state jsonb)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  a_id uuid;
  unpublished integer;
BEGIN
  SELECT count(*) INTO unpublished
  FROM jsonb_array_elements(p_form->'items') i
  LEFT JOIN question_versions v ON v.id = (i->>'versionId')::uuid AND v.workflow_state = 'published'
  WHERE v.id IS NULL;
  IF unpublished > 0 THEN RAISE EXCEPTION 'form contains % unpublished question versions', unpublished; END IF;

  INSERT INTO exam_attempts (user_id, blueprint_id, seed, state, started_at, deadline_at,
                             session_state, duration_minutes)
  VALUES (p_user, p_blueprint, (p_form->>'seed')::bigint, 'in_progress',
          to_timestamp((p_state->>'startedAtMs')::double precision / 1000),
          to_timestamp((p_state->>'deadlineMs')::double precision / 1000),
          p_state, (p_form->>'durationMinutes')::integer)
  RETURNING id INTO a_id;

  INSERT INTO attempt_sections (attempt_id, ordinal, state, opened_at)
  SELECT a_id, s.ordinality - 1, s.value->>'state',
         CASE WHEN s.value->>'openedAtMs' IS NULL THEN NULL
              ELSE to_timestamp((s.value->>'openedAtMs')::double precision / 1000) END
  FROM jsonb_array_elements(p_state->'sections') WITH ORDINALITY s;

  INSERT INTO attempt_questions (attempt_id, ordinal, section_ordinal, question_id, question_version_id)
  SELECT a_id, (i->>'ordinal')::integer, (i->>'sectionIndex')::smallint,
         (i->>'questionId')::uuid, (i->>'versionId')::uuid
  FROM jsonb_array_elements(p_form->'items') i;

  RETURN a_id;
END $$;

-- Everything the session rules need for one attempt. Returns NULL when the
-- attempt does not belong to the user, which the API reports as not found.
CREATE FUNCTION load_attempt(p_attempt uuid, p_user uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'attemptId', a.id,
    'blueprintId', a.blueprint_id,
    'state', a.session_state,
    'version', a.state_version,
    'result', a.result,
    'form', jsonb_build_object(
      'blueprintCode', b.code,
      'blueprintVersion', b.version,
      'seed', a.seed,
      'durationMinutes', a.duration_minutes,
      'items', (SELECT jsonb_agg(jsonb_build_object(
                  'ordinal', aq.ordinal, 'sectionIndex', aq.section_ordinal,
                  'questionId', aq.question_id, 'versionId', aq.question_version_id) ORDER BY aq.ordinal)
                FROM attempt_questions aq WHERE aq.attempt_id = a.id)),
    'pool', (SELECT jsonb_agg(engine_question(aq.question_version_id, 'published'))
             FROM attempt_questions aq WHERE aq.attempt_id = a.id))
  FROM exam_attempts a JOIN exam_blueprints b ON b.id = a.blueprint_id
  WHERE a.id = p_attempt AND a.user_id = p_user;
$$;

-- Persists the session state after any change, and optionally one answer.
-- Optimistic concurrency: the write succeeds only if nobody else changed the
-- attempt since it was loaded. Returns false on a conflict; the caller
-- reloads and applies its change again.
CREATE FUNCTION save_progress(p_attempt uuid, p_state jsonb, p_expected_version integer,
                              p_ordinal integer DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  aq_id uuid;
  ans jsonb;
BEGIN
  UPDATE exam_attempts
  SET session_state = p_state,
      state = p_state->>'status',
      deadline_at = to_timestamp((p_state->>'deadlineMs')::double precision / 1000),
      state_version = state_version + 1
  WHERE id = p_attempt AND result IS NULL AND state_version = p_expected_version;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE attempt_sections s
  SET state = x.value->>'state',
      opened_at = CASE WHEN x.value->>'openedAtMs' IS NULL THEN NULL
                       ELSE to_timestamp((x.value->>'openedAtMs')::double precision / 1000) END,
      closed_at = CASE WHEN x.value->>'closedAtMs' IS NULL THEN NULL
                       ELSE to_timestamp((x.value->>'closedAtMs')::double precision / 1000) END
  FROM jsonb_array_elements(p_state->'sections') WITH ORDINALITY x
  WHERE s.attempt_id = p_attempt AND s.ordinal = x.ordinality - 1;

  UPDATE attempt_questions aq
  SET flagged = (p_state->'flags') @> to_jsonb(aq.ordinal)
  WHERE aq.attempt_id = p_attempt AND aq.flagged IS DISTINCT FROM ((p_state->'flags') @> to_jsonb(aq.ordinal));

  IF p_ordinal IS NOT NULL THEN
    SELECT id INTO aq_id FROM attempt_questions WHERE attempt_id = p_attempt AND ordinal = p_ordinal;
    ans := p_state->'answers'->(p_ordinal::text);
    IF aq_id IS NOT NULL AND ans IS NOT NULL THEN
      INSERT INTO answers (attempt_question_id, response, answered_at)
      VALUES (aq_id, ans->'selected', to_timestamp((ans->>'savedAtMs')::double precision / 1000))
      ON CONFLICT (attempt_question_id)
      DO UPDATE SET response = EXCLUDED.response, answered_at = EXCLUDED.answered_at;
    END IF;
  END IF;
  RETURN true;
END $$;

-- Records the final state and the score. Calling it again changes nothing.
CREATE FUNCTION finalize_attempt(p_attempt uuid, p_state jsonb, p_result jsonb)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  IF p_state->>'status' NOT IN ('submitted', 'expired') THEN
    RAISE EXCEPTION 'attempt is not finished';
  END IF;
  UPDATE exam_attempts
  SET session_state = p_state,
      state = p_state->>'status',
      deadline_at = to_timestamp((p_state->>'deadlineMs')::double precision / 1000),
      submitted_at = to_timestamp((p_state->>'finishedAtMs')::double precision / 1000),
      score_percent = (p_result#>>'{overall,percent}')::numeric,
      result = p_result - 'perQuestion',
      state_version = state_version + 1
  WHERE id = p_attempt AND result IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE attempt_sections SET state = 'closed', closed_at = coalesce(closed_at,
         to_timestamp((p_state->>'finishedAtMs')::double precision / 1000))
  WHERE attempt_id = p_attempt AND state <> 'closed';

  UPDATE answers a
  SET is_correct = (pq->>'correct')::boolean, points = (pq->>'points')::numeric
  FROM jsonb_array_elements(p_result->'perQuestion') pq
  JOIN attempt_questions aq ON aq.attempt_id = p_attempt AND aq.ordinal = (pq->>'ordinal')::integer
  WHERE a.attempt_question_id = aq.id;
  RETURN true;
END $$;
