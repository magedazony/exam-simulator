-- Increment 19: Arabic translation beside English questions.
-- A question keeps one authoring language. An English question may also carry
-- an Arabic translation of its stem, options and option rationales, and an
-- Arabic explanation (a second row in explanations). Candidates who use the
-- app in Arabic see the translation under the English text.

ALTER TABLE question_versions ADD COLUMN stem_ar text;
ALTER TABLE options ADD COLUMN text_ar text, ADD COLUMN rationale_ar text;

CREATE OR REPLACE FUNCTION write_draft_content(p_version uuid, p_doc jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM options WHERE question_version_id = p_version;
  INSERT INTO options (question_version_id, ordinal, text, is_correct, rationale, text_ar, rationale_ar)
  SELECT p_version, o.ordinality, o.value->>'text', (o.value->>'isCorrect')::boolean, nullif(o.value->>'rationale', ''),
         nullif(o.value->>'textAr', ''), nullif(o.value->>'rationaleAr', '')
  FROM jsonb_array_elements(p_doc->'options') WITH ORDINALITY o;

  DELETE FROM explanations WHERE question_version_id = p_version;
  IF jsonb_typeof(p_doc->'explanation') = 'object' THEN
    INSERT INTO explanations (question_version_id, language, why_correct, mindset, key_concept, learning_objective)
    VALUES (p_version, coalesce(p_doc->>'language', 'en'), p_doc#>>'{explanation,whyCorrect}',
            p_doc#>>'{explanation,mindset}', p_doc#>>'{explanation,keyConcept}',
            p_doc#>>'{explanation,learningObjective}');
  END IF;
  -- Arabic translation shown beside an English question: stem, options, explanation.
  UPDATE question_versions SET stem_ar = nullif(p_doc->>'stemAr', '') WHERE id = p_version;
  IF jsonb_typeof(p_doc->'explanationAr') = 'object' AND coalesce(p_doc->>'language', 'en') <> 'ar' THEN
    INSERT INTO explanations (question_version_id, language, why_correct, mindset, key_concept, learning_objective)
    VALUES (p_version, 'ar', p_doc#>>'{explanationAr,whyCorrect}', p_doc#>>'{explanationAr,mindset}',
            p_doc#>>'{explanationAr,keyConcept}', p_doc#>>'{explanationAr,learningObjective}');
  END IF;
  PERFORM set_question_exhibits(p_version, p_doc->'exhibitIds');
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
          'textAr', o.text_ar, 'rationaleAr', o.rationale_ar) ORDER BY o.ordinal)
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
                                                             'textAr', coalesce(o.text_ar, ''), 'rationaleAr', coalesce(o.rationale_ar, ''))
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
  INSERT INTO options (question_version_id, ordinal, text, is_correct, rationale, text_ar, rationale_ar)
  SELECT v_id, ordinal, text, is_correct, rationale, text_ar, rationale_ar FROM options WHERE question_version_id = latest.id;
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
