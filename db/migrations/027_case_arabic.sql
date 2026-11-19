-- Case studies in two languages, and case studies kept in the Excel bank.
-- create/update store the Arabic title and scenario (the columns existed but
-- were never written), and the mock exam view returns them.

CREATE OR REPLACE FUNCTION create_case_study(p_author uuid, p_doc jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE c_id uuid;
BEGIN
  INSERT INTO case_studies (public_code, title, scenario, title_ar, scenario_ar, language, status, created_by)
  VALUES ('CS-' || lpad(nextval('case_study_code_seq')::text, 4, '0'), p_doc->>'title', p_doc->>'scenario',
          nullif(p_doc->>'titleAr', ''), nullif(p_doc->>'scenarioAr', ''), coalesce(p_doc->>'language', 'en'), 'draft', p_author)
  RETURNING id INTO c_id;
  PERFORM set_case_exhibits(c_id, p_doc->'exhibitIds');
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (p_author, 'case.create', 'case_study', c_id::text);
  RETURN c_id;
END $$;

CREATE OR REPLACE FUNCTION update_case_study(p_case uuid, p_actor uuid, p_is_admin boolean, p_doc jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c case_studies%ROWTYPE;
BEGIN
  SELECT * INTO c FROM case_studies WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'E_NOT_FOUND'; END IF;
  IF c.created_by <> p_actor AND NOT p_is_admin THEN RAISE EXCEPTION 'E_FORBIDDEN'; END IF;
  IF c.status <> 'draft' THEN RAISE EXCEPTION 'E_STATE'; END IF;
  UPDATE case_studies SET title = p_doc->>'title', scenario = p_doc->>'scenario',
         title_ar = nullif(p_doc->>'titleAr', ''), scenario_ar = nullif(p_doc->>'scenarioAr', ''),
         language = coalesce(p_doc->>'language', 'en'), updated_at = now()
  WHERE id = p_case;
  PERFORM set_case_exhibits(p_case, p_doc->'exhibitIds');
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (p_actor, 'case.edit', 'case_study', p_case::text);
END $$;

CREATE OR REPLACE FUNCTION case_study_views(p_ids jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', c.id, 'title', c.title, 'scenario', c.scenario,
           'titleAr', c.title_ar, 'scenarioAr', c.scenario_ar)) || jsonb_build_object('exhibits', case_exhibits(c.id))), '[]'::jsonb)
  FROM case_studies c WHERE c.id::text IN (SELECT jsonb_array_elements_text(p_ids));
$$;

CREATE OR REPLACE FUNCTION case_study_json(p_case uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', c.id, 'publicCode', c.public_code, 'title', c.title, 'scenario', c.scenario,
    'titleAr', coalesce(c.title_ar, ''), 'scenarioAr', coalesce(c.scenario_ar, ''),
    'language', c.language, 'status', c.status, 'createdBy', c.created_by,
    'exhibits', case_exhibits(c.id),
    'questions', coalesce((
      SELECT jsonb_agg(jsonb_build_object('versionId', m.version_id, 'questionId', m.question_id,
               'publicCode', q.public_code, 'caseOrdinal', m.case_ordinal, 'workflowState', m.workflow_state,
               'stem', v.stem) ORDER BY m.case_ordinal)
      FROM case_members(c.id) m
      JOIN questions q ON q.id = m.question_id
      JOIN question_versions v ON v.id = m.version_id), '[]'::jsonb))
  FROM case_studies c WHERE c.id = p_case;
$$;

-- Case studies for the Excel export, keyed by their public code.
CREATE OR REPLACE FUNCTION admin_export_cases() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'caseKey', c.public_code, 'title', c.title, 'scenario', c.scenario,
           'titleAr', coalesce(c.title_ar, ''), 'scenarioAr', coalesce(c.scenario_ar, ''), 'status', c.status) ORDER BY c.public_code), '[]'::jsonb)
  FROM case_studies c WHERE c.status <> 'withdrawn';
$$;
