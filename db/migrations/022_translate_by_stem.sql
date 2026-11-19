-- Migration 022: "translations only" import. Fills the Arabic text, Arabic explanation and any
-- missing English rationales or explanation of every question whose stem matches, without
-- touching anything else (task, approach, difficulty, answer key, case study, order of options).
-- Published questions get a new version holding the additions; drafts are filled in place.
-- Options are matched by their English text, so copies with options in a different order work.
-- Also: archived questions no longer count as duplicates or as matches for "update existing".
-- No BEGIN/COMMIT here: scripts/migrate.ts wraps every file in one transaction.

CREATE OR REPLACE FUNCTION norm_text(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g'));
$$;

CREATE OR REPLACE FUNCTION existing_stems(p_norms jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(DISTINCT n), '[]'::jsonb)
  FROM jsonb_array_elements_text(p_norms) n
  WHERE EXISTS (SELECT 1 FROM question_versions v JOIN questions q ON q.id = v.question_id
                WHERE q.status <> 'archived' AND norm_text(v.stem) = n);
$$;

CREATE OR REPLACE FUNCTION find_question_by_stem(p_norms jsonb) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT v.question_id
  FROM question_versions v
  JOIN questions q ON q.id = v.question_id
  WHERE q.status <> 'archived'
    AND norm_text(v.stem) IN (SELECT jsonb_array_elements_text(p_norms))
  ORDER BY q.created_at, v.version_no DESC
  LIMIT 1;
$$;

-- Returns {"versions": [ids of drafts that now hold the additions], "skipped": n in review}.
CREATE OR REPLACE FUNCTION translate_questions_by_stem(p_actor uuid, p_norms jsonb, p_doc jsonb)
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
BEGIN
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
             rationale = coalesce(nullif(btrim(rationale), ''), nullif(btrim(o->>'rationale'), ''))
       WHERE question_version_id = vid AND norm_text(text) = norm_text(o->>'text');
    END LOOP;

    IF ex IS NOT NULL AND nullif(btrim(ex->>'whyCorrect'), '') IS NOT NULL THEN
      INSERT INTO explanations (question_version_id, language, why_correct, mindset, key_concept, learning_objective)
      SELECT vid, v.language, ex->>'whyCorrect', nullif(ex->>'mindset', ''), nullif(ex->>'keyConcept', ''), nullif(ex->>'learningObjective', '')
      FROM question_versions v WHERE v.id = vid
      ON CONFLICT (question_version_id, language) DO NOTHING;
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
    VALUES (p_actor, 'question.translate', 'question_version', vid::text, jsonb_build_object('fromImport', true));
    ids := ids || vid;
  END LOOP;
  RETURN jsonb_build_object('versions', to_jsonb(ids), 'skipped', skipped);
END $$;
