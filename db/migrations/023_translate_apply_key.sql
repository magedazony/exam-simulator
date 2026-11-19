-- Migration 023: the "translations only" import can also apply the answer key and the English
-- explanation from the file, when the administrator asks for it. Options are still matched by
-- their English text, so copies with options in a different order get the right key.
-- No BEGIN/COMMIT here: scripts/migrate.ts wraps every file in one transaction.

DROP FUNCTION IF EXISTS translate_questions_by_stem(uuid, jsonb, jsonb);

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
                              ELSE coalesce(nullif(btrim(rationale), ''), nullif(btrim(o->>'rationale'), '')) END
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
