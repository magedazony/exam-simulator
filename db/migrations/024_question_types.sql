-- Migration 024: new question types, as on the July 2026 exam: matching, ordering (drag and
-- drop into the right order), numeric fill-in-the-blank and hotspot (pick a cell of a table or
-- board shown with the question). Extra per-option data lives in options.meta:
--   matching  {"match": "...", "matchAr": "..."}   the right-hand item paired with this option
--   numeric   {"tolerance": 0}                      one option: its text is the correct number
--   hotspot   {"cell": [row, col]}                  position in the question's first table exhibit
-- Ordering questions list their options in the correct order.
-- One function now decides whether an answer key is complete, for every type.
-- No BEGIN/COMMIT here: scripts/migrate.ts wraps every file in one transaction.

INSERT INTO question_types (code, name) VALUES
  ('matching', 'Matching'),
  ('ordering', 'Drag and drop into order'),
  ('numeric', 'Fill in the blank (number)'),
  ('hotspot', 'Hotspot')
ON CONFLICT (code) DO NOTHING;

ALTER TABLE options ADD COLUMN IF NOT EXISTS meta jsonb;

CREATE OR REPLACE FUNCTION version_key_ok(p_version uuid, p_type text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE p_type
    WHEN 'single'   THEN count(*) >= 2 AND count(*) FILTER (WHERE is_correct) = 1
    WHEN 'multiple' THEN count(*) FILTER (WHERE is_correct) >= 2 AND count(*) FILTER (WHERE is_correct) < count(*)
    WHEN 'hotspot'  THEN count(*) >= 2 AND count(*) FILTER (WHERE is_correct) = 1
                         AND bool_and(jsonb_typeof(meta->'cell') = 'array')
    WHEN 'matching' THEN count(*) >= 2 AND count(*) <= 6 AND bool_and(coalesce(btrim(meta->>'match'), '') <> '')
    WHEN 'ordering' THEN count(*) >= 2 AND count(*) <= 6
    WHEN 'numeric'  THEN count(*) = 1 AND bool_and(is_correct) AND bool_and(text ~ '^-?[0-9]+(\.[0-9]+)?$')
    ELSE false END
  FROM options WHERE question_version_id = p_version;
$$;

CREATE OR REPLACE FUNCTION question_versions_require_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workflow_state = 'published' AND OLD.workflow_state <> 'published' THEN
    IF NOT coalesce(version_key_ok(NEW.id, NEW.type_code), false) THEN
      RAISE EXCEPTION 'question version % has no valid answer key', NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION write_draft_content(p_version uuid, p_doc jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM options WHERE question_version_id = p_version;
  INSERT INTO options (question_version_id, ordinal, text, is_correct, rationale, text_ar, rationale_ar, meta)
  SELECT p_version, o.ordinality, o.value->>'text', (o.value->>'isCorrect')::boolean, nullif(o.value->>'rationale', ''),
         nullif(o.value->>'textAr', ''), nullif(o.value->>'rationaleAr', ''),
         CASE WHEN jsonb_typeof(o.value->'meta') = 'object' THEN o.value->'meta' END
  FROM jsonb_array_elements(p_doc->'options') WITH ORDINALITY o;

  DELETE FROM explanations WHERE question_version_id = p_version;
  IF jsonb_typeof(p_doc->'explanation') = 'object' THEN
    INSERT INTO explanations (question_version_id, language, why_correct, mindset, key_concept, learning_objective)
    VALUES (p_version, coalesce(p_doc->>'language', 'en'), p_doc#>>'{explanation,whyCorrect}',
            p_doc#>>'{explanation,mindset}', p_doc#>>'{explanation,keyConcept}',
            p_doc#>>'{explanation,learningObjective}');
  END IF;
  UPDATE question_versions SET stem_ar = nullif(p_doc->>'stemAr', '') WHERE id = p_version;
  IF jsonb_typeof(p_doc->'explanationAr') = 'object' AND coalesce(p_doc->>'language', 'en') <> 'ar' THEN
    INSERT INTO explanations (question_version_id, language, why_correct, mindset, key_concept, learning_objective)
    VALUES (p_version, 'ar', p_doc#>>'{explanationAr,whyCorrect}', p_doc#>>'{explanationAr,mindset}',
            p_doc#>>'{explanationAr,keyConcept}', p_doc#>>'{explanationAr,learningObjective}');
  END IF;
  PERFORM set_question_exhibits(p_version, p_doc->'exhibitIds');
END $$;

CREATE OR REPLACE FUNCTION new_question_version(p_question uuid, p_actor uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  latest question_versions%ROWTYPE;
  v_id uuid;
BEGIN
  PERFORM 1 FROM questions WHERE id = p_question FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'E_NOT_FOUND'; END IF;
  SELECT * INTO latest FROM question_versions WHERE question_id = p_question ORDER BY version_no DESC LIMIT 1;
  IF latest.workflow_state NOT IN ('published', 'withdrawn') THEN RAISE EXCEPTION 'E_OPEN_VERSION'; END IF;

  INSERT INTO question_versions (question_id, version_no, task_id, approach_code, difficulty_code, type_code,
                                 is_graphic, case_study_id, case_ordinal, language, stem, stem_ar, body, author_id)
  VALUES (p_question, latest.version_no + 1, latest.task_id, latest.approach_code, latest.difficulty_code,
          latest.type_code, latest.is_graphic, latest.case_study_id, latest.case_ordinal, latest.language,
          latest.stem, latest.stem_ar, latest.body, p_actor)
  RETURNING id INTO v_id;
  INSERT INTO options (question_version_id, ordinal, text, is_correct, rationale, text_ar, rationale_ar, meta)
  SELECT v_id, ordinal, text, is_correct, rationale, text_ar, rationale_ar, meta FROM options WHERE question_version_id = latest.id;
  INSERT INTO explanations (question_version_id, language, why_correct, mindset, key_concept, learning_objective)
  SELECT v_id, language, why_correct, mindset, key_concept, learning_objective
  FROM explanations WHERE question_version_id = latest.id;
  INSERT INTO question_exhibits (question_version_id, exhibit_id, ordinal)
  SELECT v_id, exhibit_id, ordinal FROM question_exhibits WHERE question_version_id = latest.id;
  INSERT INTO question_references (question_version_id, reference_id)
  SELECT v_id, reference_id FROM question_references WHERE question_version_id = latest.id;
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before)
  VALUES (p_actor, 'question.new_version', 'question_version', v_id::text, jsonb_build_object('from', latest.id));
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION engine_question(p_version uuid, p_status text) RETURNS jsonb LANGUAGE sql STABLE AS $$
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
      'exhibits', version_exhibits(v.id),
      'stem', v.stem,
      'stemAr', v.stem_ar,
      'options', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'id', o.id, 'text', o.text, 'isCorrect', o.is_correct, 'rationale', o.rationale,
          'textAr', o.text_ar, 'rationaleAr', o.rationale_ar, 'meta', o.meta) ORDER BY o.ordinal)
        FROM options o WHERE o.question_version_id = v.id), '[]'::jsonb))
    || CASE WHEN v.case_study_id IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('caseSetId', v.case_study_id, 'caseOrdinal', v.case_ordinal) END
  FROM question_versions v
  JOIN tasks t ON t.id = v.task_id
  JOIN domains d ON d.id = t.domain_id
  WHERE v.id = p_version;
$$;

CREATE OR REPLACE FUNCTION admin_question_json(p_version uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', v.id, 'questionId', v.question_id, 'publicCode', q.public_code, 'versionNo', v.version_no,
    'workflowState', v.workflow_state, 'aiAssisted', v.ai_assisted, 'authorId', v.author_id,
    'publishedAt', v.published_at, 'taskCode', t.code, 'approach', v.approach_code,
    'difficulty', v.difficulty_code, 'type', v.type_code, 'graphic', v.is_graphic,
    'caseStudyId', v.case_study_id, 'caseOrdinal', v.case_ordinal, 'language', v.language, 'stem', v.stem, 'stemAr', coalesce(v.stem_ar, ''),
    'exhibits', version_exhibits(v.id),
    'options', coalesce((SELECT jsonb_agg(jsonb_build_object('text', o.text, 'isCorrect', o.is_correct,
                                                             'rationale', coalesce(o.rationale, ''),
                                                             'textAr', coalesce(o.text_ar, ''), 'rationaleAr', coalesce(o.rationale_ar, ''), 'meta', o.meta)
                                          ORDER BY o.ordinal)
                         FROM options o WHERE o.question_version_id = v.id), '[]'::jsonb),
    'explanation', (SELECT jsonb_build_object('whyCorrect', e.why_correct, 'mindset', e.mindset,
                                              'keyConcept', e.key_concept, 'learningObjective', e.learning_objective)
                    FROM explanations e WHERE e.question_version_id = v.id AND e.language = v.language),
    'explanationAr', (SELECT jsonb_build_object('whyCorrect', e.why_correct, 'mindset', e.mindset,
                                                'keyConcept', e.key_concept, 'learningObjective', e.learning_objective)
                      FROM explanations e WHERE e.question_version_id = v.id AND e.language = 'ar' AND v.language <> 'ar'),
    'lastReview', (SELECT jsonb_build_object('gate', r.gate, 'decision', r.decision, 'comment', r.comment,
                                             'at', r.created_at)
                   FROM reviews r WHERE r.question_version_id = v.id ORDER BY r.seq DESC LIMIT 1))
  FROM question_versions v
  JOIN questions q ON q.id = v.question_id
  JOIN tasks t ON t.id = v.task_id
  WHERE v.id = p_version;
$$;

CREATE OR REPLACE FUNCTION transition_question_version(p_version uuid, p_actor uuid, p_action text, p_comment text,
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
    IF NOT version_key_ok(p_version, v.type_code) THEN
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
      IF NOT version_key_ok(vid, v.type_code) THEN
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

-- Translations import: also fills meta (see 023).
CREATE OR REPLACE FUNCTION translate_questions_by_stem(p_actor uuid, p_norms jsonb, p_doc jsonb, p_apply_key boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  r record;
  latest question_versions%ROWTYPE;
  vid uuid;
  o jsonb;
  ids uuid[] := ARRAY[]::uuid[];
  skipped int := 0;
  ex jsonb := p_doc->'explanation';
  exar jsonb := p_doc->'explanationAr';
  keys text[];
BEGIN
  SELECT array_agg(norm_text(x->>'text')) INTO keys
  FROM jsonb_array_elements(coalesce(p_doc->'options', '[]'::jsonb)) x WHERE (x->>'isCorrect')::boolean;

  FOR r IN
    SELECT DISTINCT q.id
    FROM questions q
    JOIN LATERAL (SELECT * FROM question_versions x WHERE x.question_id = q.id ORDER BY x.version_no DESC LIMIT 1) l ON true
    WHERE q.status <> 'archived' AND norm_text(l.stem) IN (SELECT jsonb_array_elements_text(p_norms))
  LOOP
    SELECT * INTO latest FROM question_versions WHERE question_id = r.id ORDER BY version_no DESC LIMIT 1;
    IF latest.workflow_state = 'draft' THEN
      vid := latest.id;
    ELSIF latest.workflow_state IN ('published', 'withdrawn') THEN
      vid := new_question_version(r.id, p_actor);
    ELSE
      skipped := skipped + 1;
      CONTINUE;
    END IF;

    UPDATE question_versions
       SET stem_ar = coalesce(nullif(btrim(p_doc->>'stemAr'), ''), stem_ar),
           language = CASE WHEN p_doc->>'language' IN ('en', 'ar') THEN p_doc->>'language' ELSE language END
     WHERE id = vid;

    FOR o IN SELECT * FROM jsonb_array_elements(coalesce(p_doc->'options', '[]'::jsonb)) LOOP
      UPDATE options
         SET text_ar = coalesce(nullif(btrim(o->>'textAr'), ''), text_ar),
             rationale_ar = coalesce(nullif(btrim(o->>'rationaleAr'), ''), rationale_ar),
             rationale = CASE WHEN p_apply_key THEN coalesce(nullif(btrim(o->>'rationale'), ''), rationale)
                              ELSE coalesce(nullif(btrim(rationale), ''), nullif(btrim(o->>'rationale'), '')) END,
             -- Arabic of a matching pair always; the rest of meta (pair, cell, tolerance) only with the key.
             meta = CASE WHEN jsonb_typeof(o->'meta') <> 'object' THEN meta
                         WHEN p_apply_key THEN coalesce(meta, '{}'::jsonb) || (o->'meta')
                         ELSE coalesce(meta, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('matchAr', nullif(btrim(o#>>'{meta,matchAr}'), ''))) END
       WHERE question_version_id = vid AND norm_text(text) = norm_text(o->>'text');
    END LOOP;

    IF p_apply_key AND keys IS NOT NULL AND cardinality(keys) > 0
       AND (SELECT count(*) FROM options WHERE question_version_id = vid AND norm_text(text) = ANY (keys)) = cardinality(keys) THEN
      UPDATE options SET is_correct = (norm_text(text) = ANY (keys)) WHERE question_version_id = vid;
      UPDATE question_versions SET type_code = CASE WHEN cardinality(keys) > 1 THEN 'multiple' ELSE 'single' END WHERE id = vid;
    END IF;

    IF ex IS NOT NULL AND nullif(btrim(ex->>'whyCorrect'), '') IS NOT NULL THEN
      IF p_apply_key THEN
        INSERT INTO explanations (question_version_id, language, why_correct, mindset, key_concept, learning_objective)
        SELECT vid, v.language, ex->>'whyCorrect', nullif(ex->>'mindset', ''), nullif(ex->>'keyConcept', ''), nullif(ex->>'learningObjective', '')
        FROM question_versions v WHERE v.id = vid
        ON CONFLICT (question_version_id, language) DO UPDATE
          SET why_correct = EXCLUDED.why_correct,
              mindset = coalesce(EXCLUDED.mindset, explanations.mindset),
              key_concept = coalesce(EXCLUDED.key_concept, explanations.key_concept),
              learning_objective = coalesce(EXCLUDED.learning_objective, explanations.learning_objective);
      ELSE
        INSERT INTO explanations (question_version_id, language, why_correct, mindset, key_concept, learning_objective)
        SELECT vid, v.language, ex->>'whyCorrect', nullif(ex->>'mindset', ''), nullif(ex->>'keyConcept', ''), nullif(ex->>'learningObjective', '')
        FROM question_versions v WHERE v.id = vid
        ON CONFLICT (question_version_id, language) DO NOTHING;
      END IF;
    END IF;
    IF exar IS NOT NULL AND nullif(btrim(exar->>'whyCorrect'), '') IS NOT NULL THEN
      INSERT INTO explanations (question_version_id, language, why_correct, mindset, key_concept, learning_objective)
      SELECT vid, 'ar', exar->>'whyCorrect', nullif(exar->>'mindset', ''), nullif(exar->>'keyConcept', ''), nullif(exar->>'learningObjective', '')
      FROM question_versions v WHERE v.id = vid AND v.language <> 'ar'
      ON CONFLICT (question_version_id, language) DO UPDATE
        SET why_correct = EXCLUDED.why_correct,
            mindset = coalesce(EXCLUDED.mindset, explanations.mindset),
            key_concept = coalesce(EXCLUDED.key_concept, explanations.key_concept),
            learning_objective = coalesce(EXCLUDED.learning_objective, explanations.learning_objective);
    END IF;

    INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, after)
    VALUES (p_actor, 'question.translate', 'question_version', vid::text, jsonb_build_object('fromImport', true, 'applyKey', p_apply_key));
    ids := ids || vid;
  END LOOP;
  RETURN jsonb_build_object('versions', to_jsonb(ids), 'skipped', skipped);
END $$;
