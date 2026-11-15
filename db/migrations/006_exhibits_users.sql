-- Migration 006: exhibits (images and tables) for questions and case studies,
-- and user administration (roles, two-factor reset).

-- ------------------------------------------------------------ exhibits
-- Images are stored in the database for now (at most 1 MiB each; checked by
-- the API). Moving them to object storage behind a CDN changes only these
-- functions and the image endpoint.
CREATE TABLE exhibits (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('image', 'table')),
  mime_type  text,
  data       bytea,
  table_data jsonb,
  alt_text   text NOT NULL CHECK (char_length(alt_text) BETWEEN 3 AND 500),
  sha256     text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'image' AND data IS NOT NULL AND table_data IS NULL
          AND mime_type IN ('image/png', 'image/jpeg', 'image/webp'))
      OR (kind = 'table' AND table_data IS NOT NULL AND data IS NULL AND mime_type IS NULL))
);

CREATE TABLE question_exhibits (
  question_version_id uuid NOT NULL REFERENCES question_versions(id) ON DELETE CASCADE,
  exhibit_id          uuid NOT NULL REFERENCES exhibits(id),
  ordinal             smallint NOT NULL,
  PRIMARY KEY (question_version_id, ordinal),
  UNIQUE (question_version_id, exhibit_id)
);

CREATE TABLE case_study_exhibits (
  case_study_id uuid NOT NULL REFERENCES case_studies(id) ON DELETE CASCADE,
  exhibit_id    uuid NOT NULL REFERENCES exhibits(id),
  ordinal       smallint NOT NULL,
  PRIMARY KEY (case_study_id, ordinal),
  UNIQUE (case_study_id, exhibit_id)
);

-- Published question versions are immutable, and so are their exhibits.
CREATE FUNCTION question_exhibits_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM question_versions
             WHERE id = coalesce(NEW.question_version_id, OLD.question_version_id)
               AND workflow_state IN ('published', 'withdrawn')) THEN
    RAISE EXCEPTION 'exhibits of a published question version cannot change';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER question_exhibits_immutable BEFORE INSERT OR UPDATE OR DELETE ON question_exhibits
  FOR EACH ROW EXECUTE FUNCTION question_exhibits_freeze();

CREATE FUNCTION create_exhibit(p_author uuid, p_kind text, p_mime text, p_base64 text, p_table jsonb, p_alt text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  e_id uuid;
  bytes bytea := CASE WHEN p_kind = 'image' THEN decode(p_base64, 'base64') END;
BEGIN
  INSERT INTO exhibits (kind, mime_type, data, table_data, alt_text, sha256, created_by)
  VALUES (p_kind, CASE WHEN p_kind = 'image' THEN p_mime END, bytes,
          CASE WHEN p_kind = 'table' THEN p_table END, p_alt,
          CASE WHEN bytes IS NOT NULL THEN encode(digest(bytes, 'sha256'), 'hex') END, p_author)
  RETURNING id INTO e_id;
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id)
  VALUES (p_author, 'exhibit.create', 'exhibit', e_id::text);
  RETURN e_id;
END $$;

-- Exhibit references as the engine and the API carry them. No image bytes.
CREATE FUNCTION exhibit_refs(p_ids uuid[]) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'altText', e.alt_text)
                            || CASE WHEN e.kind = 'table' THEN jsonb_build_object('table', e.table_data) ELSE '{}'::jsonb END
                            ORDER BY array_position(p_ids, e.id)), '[]'::jsonb)
  FROM exhibits e WHERE e.id = ANY (p_ids);
$$;

CREATE FUNCTION version_exhibits(p_version uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT exhibit_refs(coalesce(array_agg(exhibit_id ORDER BY ordinal), '{}'))
  FROM question_exhibits WHERE question_version_id = p_version;
$$;

CREATE FUNCTION case_exhibits(p_case uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT exhibit_refs(coalesce(array_agg(exhibit_id ORDER BY ordinal), '{}'))
  FROM case_study_exhibits WHERE case_study_id = p_case;
$$;

CREATE FUNCTION exhibit_image(p_exhibit uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('mimeType', mime_type, 'base64', encode(data, 'base64'), 'sha256', sha256)
  FROM exhibits WHERE id = p_exhibit AND kind = 'image';
$$;

-- Replaces the exhibits of a draft question or case study, in the given order.
CREATE FUNCTION set_question_exhibits(p_version uuid, p_ids jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  wanted integer := coalesce(jsonb_array_length(p_ids), 0);
  found integer;
BEGIN
  IF wanted > 3 THEN RAISE EXCEPTION 'E_TOO_MANY_EXHIBITS'; END IF;
  SELECT count(*) INTO found FROM exhibits
  WHERE id::text IN (SELECT jsonb_array_elements_text(coalesce(p_ids, '[]'::jsonb)));
  IF found <> wanted THEN RAISE EXCEPTION 'E_UNKNOWN_EXHIBIT'; END IF;
  DELETE FROM question_exhibits WHERE question_version_id = p_version;
  INSERT INTO question_exhibits (question_version_id, exhibit_id, ordinal)
  SELECT p_version, x.value::uuid, x.ordinality FROM jsonb_array_elements_text(coalesce(p_ids, '[]'::jsonb)) WITH ORDINALITY x;
END $$;

CREATE FUNCTION set_case_exhibits(p_case uuid, p_ids jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  wanted integer := coalesce(jsonb_array_length(p_ids), 0);
  found integer;
BEGIN
  IF wanted > 5 THEN RAISE EXCEPTION 'E_TOO_MANY_EXHIBITS'; END IF;
  SELECT count(*) INTO found FROM exhibits
  WHERE id::text IN (SELECT jsonb_array_elements_text(coalesce(p_ids, '[]'::jsonb)));
  IF found <> wanted THEN RAISE EXCEPTION 'E_UNKNOWN_EXHIBIT'; END IF;
  DELETE FROM case_study_exhibits WHERE case_study_id = p_case;
  INSERT INTO case_study_exhibits (case_study_id, exhibit_id, ordinal)
  SELECT p_case, x.value::uuid, x.ordinality FROM jsonb_array_elements_text(coalesce(p_ids, '[]'::jsonb)) WITH ORDINALITY x;
END $$;


CREATE OR REPLACE FUNCTION write_draft_content(p_version uuid, p_doc jsonb) RETURNS void LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE FUNCTION create_case_study(p_author uuid, p_doc jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  c_id uuid;
BEGIN
  INSERT INTO case_studies (public_code, title, scenario, language, status, created_by)
  VALUES ('CS-' || lpad(nextval('case_study_code_seq')::text, 4, '0'), p_doc->>'title', p_doc->>'scenario',
          coalesce(p_doc->>'language', 'en'), 'draft', p_author)
  RETURNING id INTO c_id;
  PERFORM set_case_exhibits(c_id, p_doc->'exhibitIds');
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id)
  VALUES (p_author, 'case.create', 'case_study', c_id::text);
  RETURN c_id;
END $$;

CREATE OR REPLACE FUNCTION update_case_study(p_case uuid, p_actor uuid, p_is_admin boolean, p_doc jsonb) RETURNS void LANGUAGE plpgsql AS $$
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
  PERFORM set_case_exhibits(p_case, p_doc->'exhibitIds');
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id)
  VALUES (p_actor, 'case.edit', 'case_study', p_case::text);
END $$;

CREATE OR REPLACE FUNCTION case_study_json(p_case uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', c.id, 'publicCode', c.public_code, 'title', c.title, 'scenario', c.scenario,
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

CREATE OR REPLACE FUNCTION case_study_views(p_ids jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title, 'scenario', c.scenario, 'exhibits', case_exhibits(c.id))), '[]'::jsonb)
  FROM case_studies c WHERE c.id::text IN (SELECT jsonb_array_elements_text(p_ids));
$$;

CREATE OR REPLACE FUNCTION admin_question_json(p_version uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', v.id, 'questionId', v.question_id, 'publicCode', q.public_code, 'versionNo', v.version_no,
    'workflowState', v.workflow_state, 'aiAssisted', v.ai_assisted, 'authorId', v.author_id,
    'publishedAt', v.published_at, 'taskCode', t.code, 'approach', v.approach_code,
    'difficulty', v.difficulty_code, 'type', v.type_code, 'graphic', v.is_graphic,
    'caseStudyId', v.case_study_id, 'caseOrdinal', v.case_ordinal, 'language', v.language, 'stem', v.stem,
    'exhibits', version_exhibits(v.id),
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


-- ------------------------------------------------------------ users
CREATE FUNCTION admin_find_users(p_query text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', u.id, 'email', u.email, 'status', u.status, 'mfaEnabled', u.totp_enabled_at IS NOT NULL,
           'roles', coalesce((SELECT jsonb_agg(r.code ORDER BY r.id) FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                              WHERE ur.user_id = u.id), '[]'::jsonb)) ORDER BY u.email), '[]'::jsonb)
  FROM (SELECT * FROM users
        WHERE p_query = '' OR email ILIKE '%' || replace(replace(p_query, '%', ''), '_', '') || '%'
        ORDER BY email LIMIT 50) u;
$$;

CREATE FUNCTION admin_set_roles(p_user uuid, p_actor uuid, p_roles jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  before jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user) THEN RAISE EXCEPTION 'E_NOT_FOUND'; END IF;
  IF p_user = p_actor AND NOT (p_roles ? 'administrator') THEN RAISE EXCEPTION 'E_SELF_DEMOTE'; END IF;
  IF (SELECT count(*) FROM roles WHERE code IN (SELECT jsonb_array_elements_text(p_roles))) <> jsonb_array_length(p_roles) THEN
    RAISE EXCEPTION 'E_UNKNOWN_ROLE';
  END IF;
  SELECT coalesce(jsonb_agg(r.code ORDER BY r.id), '[]'::jsonb) INTO before
  FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = p_user;
  DELETE FROM user_roles WHERE user_id = p_user;
  INSERT INTO user_roles (user_id, role_id)
  SELECT p_user, id FROM roles WHERE code IN (SELECT jsonb_array_elements_text(p_roles));
  -- A role change ends existing sessions, so new rights apply at the next sign-in.
  UPDATE sessions SET revoked_at = now() WHERE user_id = p_user AND revoked_at IS NULL AND p_user <> p_actor;
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, before, after)
  VALUES (p_actor, 'user.roles', 'user', p_user::text, before, p_roles);
END $$;

-- For a staff member who lost both the authenticator and the recovery codes.
-- The person enrols again at next sign-in.
CREATE FUNCTION admin_reset_mfa(p_user uuid, p_actor uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_user = p_actor THEN RAISE EXCEPTION 'E_SELF_RESET'; END IF;
  UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL WHERE id = p_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'E_NOT_FOUND'; END IF;
  DELETE FROM mfa_recovery_codes WHERE user_id = p_user;
  UPDATE sessions SET revoked_at = now() WHERE user_id = p_user AND revoked_at IS NULL;
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id)
  VALUES (p_actor, 'user.mfa_reset', 'user', p_user::text);
END $$;
