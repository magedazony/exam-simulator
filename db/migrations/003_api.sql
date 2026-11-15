-- Migration 003: what the HTTP API needs beyond the exam engine.
-- Account tokens, refresh-token families, practice mode, explanations,
-- answer review, analytics, dashboard and question reports.

ALTER TABLE users
  ADD COLUMN explanation_language text NOT NULL DEFAULT 'en' CHECK (explanation_language IN ('en', 'ar'));

-- All refresh tokens issued from one login share a family, so that reuse of
-- an old token can revoke the whole chain.
ALTER TABLE sessions ADD COLUMN family_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE INDEX sessions_family_idx ON sessions (family_id);

CREATE TABLE email_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    text NOT NULL CHECK (purpose IN ('verify', 'reset')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

CREATE TABLE practice_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blueprint_id   uuid NOT NULL REFERENCES exam_blueprints(id),
  mode           text NOT NULL CHECK (mode IN ('quick', 'focused', 'weak_areas', 'timed', 'incorrect_only')),
  filters        jsonb NOT NULL DEFAULT '{}'::jsonb,
  question_count integer NOT NULL CHECK (question_count > 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX practice_sessions_user_idx ON practice_sessions (user_id, created_at DESC);

CREATE TABLE practice_items (
  session_id          uuid NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
  ordinal             integer NOT NULL CHECK (ordinal > 0),
  question_id         uuid NOT NULL REFERENCES questions(id),
  question_version_id uuid NOT NULL REFERENCES question_versions(id),
  response            jsonb,
  is_correct          boolean,
  time_spent_ms       integer CHECK (time_spent_ms >= 0),
  answered_at         timestamptz,
  PRIMARY KEY (session_id, ordinal),
  UNIQUE (session_id, question_id)
);

CREATE TABLE question_reports (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_version_id uuid NOT NULL REFERENCES question_versions(id),
  reason              text NOT NULL CHECK (reason IN ('wrong_answer', 'ambiguous', 'typo', 'outdated', 'other')),
  comment             text,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'triaged', 'resolved')),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX question_reports_open_idx ON question_reports (question_version_id) WHERE status = 'open';

-- True when a filter list is absent or empty, or contains the value.
CREATE FUNCTION filter_allows(p_list jsonb, p_value text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_list IS NULL OR jsonb_typeof(p_list) <> 'array' OR jsonb_array_length(p_list) = 0 OR p_list ? p_value;
$$;

-- Every answer a user has given that counts for analytics: answers of scored
-- mock exams and practice answers.
CREATE FUNCTION user_answer_events(p_user uuid)
RETURNS TABLE (question_id uuid, question_version_id uuid, is_correct boolean, answered_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT aq.question_id, aq.question_version_id, a.is_correct, a.answered_at
  FROM answers a
  JOIN attempt_questions aq ON aq.id = a.attempt_question_id
  JOIN exam_attempts ea ON ea.id = aq.attempt_id
  WHERE ea.user_id = p_user AND ea.result IS NOT NULL
    AND a.is_correct IS NOT NULL AND jsonb_array_length(a.response) > 0
  UNION ALL
  SELECT pi.question_id, pi.question_version_id, pi.is_correct, pi.answered_at
  FROM practice_items pi JOIN practice_sessions ps ON ps.id = pi.session_id
  WHERE ps.user_id = p_user AND pi.answered_at IS NOT NULL;
$$;

-- ---------------------------------------------------------------- practice

-- Picks published independent questions that match the filters. Questions of
-- the user's unfinished mock exam are never offered, so practice cannot be
-- used to look up answers during an exam.
CREATE FUNCTION create_practice_session(p_user uuid, p_blueprint_code text, p_mode text,
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
    WHERE d.blueprint_id = bp_id
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

CREATE FUNCTION practice_session_json(p_session uuid, p_user uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('id', id, 'mode', mode, 'questionCount', question_count)
  FROM practice_sessions WHERE id = p_session AND user_id = p_user;
$$;

-- One practice item with its key (server-side only). NULL when not the user's.
CREATE FUNCTION practice_item(p_session uuid, p_user uuid, p_ordinal integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'question', engine_question(pi.question_version_id, 'published'),
    'taskName', t.name,
    'answered', pi.answered_at IS NOT NULL,
    'response', pi.response)
  FROM practice_items pi
  JOIN practice_sessions ps ON ps.id = pi.session_id
  JOIN question_versions v ON v.id = pi.question_version_id
  JOIN tasks t ON t.id = v.task_id
  WHERE pi.session_id = p_session AND ps.user_id = p_user AND pi.ordinal = p_ordinal;
$$;

-- Stores a practice answer once. Returns false when it was already answered.
CREATE FUNCTION record_practice_answer(p_session uuid, p_user uuid, p_ordinal integer, p_response jsonb,
                                       p_is_correct boolean, p_time_ms integer, p_now timestamptz)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  UPDATE practice_items pi
  SET response = p_response, is_correct = p_is_correct, time_spent_ms = p_time_ms, answered_at = p_now
  FROM practice_sessions ps
  WHERE ps.id = pi.session_id AND ps.user_id = p_user
    AND pi.session_id = p_session AND pi.ordinal = p_ordinal AND pi.answered_at IS NULL
  RETURNING pi.question_version_id INTO v_id;
  IF v_id IS NULL THEN RETURN false; END IF;
  INSERT INTO practice_answers (user_id, question_version_id, response, is_correct, time_spent_ms, answered_at)
  VALUES (p_user, v_id, p_response, p_is_correct, coalesce(p_time_ms, 0), p_now);
  RETURN true;
END $$;

-- Explanation of a question version in the requested language, falling back to English.
CREATE FUNCTION explanation_json(p_version uuid, p_language text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'language', coalesce(e.language, 'en'),
    'whyCorrect', coalesce(e.why_correct, ''),
    'mindset', e.mindset,
    'keyConcept', e.key_concept,
    'learningObjective', e.learning_objective,
    'domainName', d.name,
    'taskName', t.name,
    'references', coalesce((
      SELECT jsonb_agg(jsonb_build_object('title', r.title, 'section', r.section, 'sourceType', r.source_type))
      FROM question_references qr JOIN content_references r ON r.id = qr.reference_id
      WHERE qr.question_version_id = v.id), '[]'::jsonb))
  FROM question_versions v
  JOIN tasks t ON t.id = v.task_id
  JOIN domains d ON d.id = t.domain_id
  LEFT JOIN LATERAL (
    SELECT * FROM explanations x
    WHERE x.question_version_id = v.id AND x.language IN (p_language, 'en')
    ORDER BY (x.language = p_language) DESC LIMIT 1) e ON true
  WHERE v.id = p_version;
$$;

-- ------------------------------------------------------------ tallies

CREATE FUNCTION tally_json(p_key text, p_label text, p_total bigint, p_correct bigint) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('key', p_key, 'label', p_label, 'total', p_total, 'answered', p_total,
                            'correct', p_correct,
                            'percent', CASE WHEN p_total = 0 THEN 0 ELSE round(p_correct * 100.0 / p_total, 1) END);
$$;

CREATE FUNCTION practice_summary(p_session uuid, p_user uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'questionCount', ps.question_count,
    'overall', (SELECT tally_json('overall', 'Overall', count(*) FILTER (WHERE pi.answered_at IS NOT NULL),
                                  count(*) FILTER (WHERE pi.is_correct))
                FROM practice_items pi WHERE pi.session_id = ps.id),
    'byTask', coalesce((
      SELECT jsonb_agg(x.t ORDER BY x.code) FROM (
        SELECT t.code, tally_json(t.code, t.name, count(*), count(*) FILTER (WHERE pi.is_correct)) AS t
        FROM practice_items pi
        JOIN question_versions v ON v.id = pi.question_version_id
        JOIN tasks t ON t.id = v.task_id
        WHERE pi.session_id = ps.id AND pi.answered_at IS NOT NULL
        GROUP BY t.code, t.name) x), '[]'::jsonb))
  FROM practice_sessions ps WHERE ps.id = p_session AND ps.user_id = p_user;
$$;

-- Accuracy by one dimension over everything the user has answered.
CREATE FUNCTION user_analytics(p_user uuid, p_dimension text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(tally_json(g.key, g.label, g.total, g.correct) ORDER BY g.sort, g.key), '[]'::jsonb)
  FROM (
    SELECT k.key, k.label, min(k.sort) AS sort, count(*) AS total, count(*) FILTER (WHERE e.is_correct) AS correct
    FROM user_answer_events(p_user) e
    JOIN question_versions v ON v.id = e.question_version_id
    JOIN tasks t ON t.id = v.task_id
    JOIN domains d ON d.id = t.domain_id
    CROSS JOIN LATERAL (
      SELECT CASE p_dimension
               WHEN 'domain' THEN d.code WHEN 'task' THEN t.code WHEN 'approach' THEN v.approach_code
               WHEN 'difficulty' THEN v.difficulty_code WHEN 'type' THEN v.type_code END AS key,
             CASE p_dimension
               WHEN 'domain' THEN d.name WHEN 'task' THEN t.name WHEN 'approach' THEN v.approach_code
               WHEN 'difficulty' THEN v.difficulty_code WHEN 'type' THEN v.type_code END AS label,
             CASE p_dimension
               WHEN 'domain' THEN d.ordinal * 100 WHEN 'task' THEN d.ordinal * 100 + t.ordinal ELSE 0 END AS sort
    ) k
    WHERE k.key IS NOT NULL
    GROUP BY k.key, k.label) g;
$$;

CREATE FUNCTION user_dashboard(p_user uuid, p_now timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH ev AS (SELECT * FROM user_answer_events(p_user)),
  days AS (SELECT DISTINCT (answered_at AT TIME ZONE 'UTC')::date AS day FROM ev),
  runs AS (SELECT day, day - (row_number() OVER (ORDER BY day))::integer AS grp FROM days),
  dom AS (
    SELECT d.code, d.name, count(*) AS total, count(*) FILTER (WHERE ev.is_correct) AS correct
    FROM ev JOIN question_versions v ON v.id = ev.question_version_id
    JOIN tasks t ON t.id = v.task_id JOIN domains d ON d.id = t.domain_id
    GROUP BY d.code, d.name HAVING count(*) >= 10)
  SELECT jsonb_build_object(
    'daysToExam', (SELECT CASE WHEN u.exam_target_date IS NULL THEN NULL
                               ELSE u.exam_target_date - (p_now AT TIME ZONE 'UTC')::date END
                   FROM users u WHERE u.id = p_user),
    'questionsCompleted', (SELECT count(*) FROM ev),
    'accuracyPercent', (SELECT CASE WHEN count(*) = 0 THEN NULL
                                    ELSE round(count(*) FILTER (WHERE is_correct) * 100.0 / count(*), 1) END FROM ev),
    'mocksCompleted', (SELECT count(*) FROM exam_attempts WHERE user_id = p_user AND result IS NOT NULL),
    'streakDays', coalesce((
      SELECT count(*) FROM runs WHERE grp = (
        SELECT grp FROM runs
        WHERE day >= (p_now AT TIME ZONE 'UTC')::date - 1 ORDER BY day DESC LIMIT 1)), 0),
    'strongestDomain', (SELECT tally_json(code, name, total, correct) FROM dom
                        ORDER BY correct::numeric / total DESC, code LIMIT 1),
    'weakestDomain', (SELECT tally_json(code, name, total, correct) FROM dom
                      ORDER BY correct::numeric / total ASC, code LIMIT 1),
    'recentScores', coalesce((
      SELECT jsonb_agg(jsonb_build_object('date', (x.submitted_at AT TIME ZONE 'UTC')::date, 'percent', x.score_percent)
                       ORDER BY x.submitted_at)
      FROM (SELECT submitted_at, score_percent FROM exam_attempts
            WHERE user_id = p_user AND result IS NOT NULL ORDER BY submitted_at DESC LIMIT 10) x), '[]'::jsonb));
$$;

-- ---------------------------------------------------------- mock results

CREATE FUNCTION list_attempts(p_user uuid, p_limit integer, p_before timestamptz) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'status', x.state, 'startedAt', x.started_at,
           'finishedAt', x.submitted_at, 'scorePercent', x.score_percent) ORDER BY x.started_at DESC), '[]'::jsonb)
  FROM (SELECT * FROM exam_attempts
        WHERE user_id = p_user AND (p_before IS NULL OR started_at < p_before)
        ORDER BY started_at DESC LIMIT p_limit) x;
$$;

-- Questions of a finished attempt with keys and the candidate's answers.
-- NULL when the attempt is not the user's or is not scored yet.
CREATE FUNCTION attempt_review(p_attempt uuid, p_user uuid, p_filter text, p_after integer, p_limit integer)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('items', coalesce((
    SELECT jsonb_agg(x.item ORDER BY x.ordinal) FROM (
      SELECT aq.ordinal, jsonb_build_object(
               'ordinal', aq.ordinal,
               'question', engine_question(aq.question_version_id, 'published'),
               'selected', coalesce(an.response, '[]'::jsonb),
               'flagged', aq.flagged,
               'correct', coalesce(an.is_correct, false)) AS item
      FROM attempt_questions aq
      LEFT JOIN answers an ON an.attempt_question_id = aq.id
      WHERE aq.attempt_id = a.id AND aq.ordinal > p_after
        AND CASE p_filter
              WHEN 'incorrect' THEN an.is_correct IS FALSE AND jsonb_array_length(an.response) > 0
              WHEN 'flagged' THEN aq.flagged
              WHEN 'unanswered' THEN an.response IS NULL OR jsonb_array_length(an.response) = 0
              ELSE true END
      ORDER BY aq.ordinal LIMIT p_limit) x), '[]'::jsonb))
  FROM exam_attempts a
  WHERE a.id = p_attempt AND a.user_id = p_user AND a.result IS NOT NULL;
$$;
