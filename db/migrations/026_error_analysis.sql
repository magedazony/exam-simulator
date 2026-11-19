-- Automatic error analysis.
--
-- Every wrong answer (practice or mock) is given one likely error type by
-- simple, explainable rules: the question type, the approach, words in the
-- stem, the text of the option chosen and the time taken. No external
-- service is used. The result is a hint for the learner, not a diagnosis, so
-- the rules prefer the specific signal and fall back to knowledge_gap.
--
-- Also fixes the per-domain analytics, which only counted questions linked to
-- the active blueprint's own task rows.

ALTER TABLE error_classifications
  ADD COLUMN IF NOT EXISTS question_version_id uuid REFERENCES question_versions(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS rule text;

-- The rules, on plain values so they can be checked against any content.
CREATE OR REPLACE FUNCTION classify_error_rules(p_type text, p_approach text, p_graphic boolean, p_task text,
    p_stem text, p_chosen text, p_right text, p_hits integer, p_time_ms integer)
RETURNS TABLE (error_type error_type, rule text) LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE stem text := lower(coalesce(p_stem, '')); chosen text := lower(coalesce(p_chosen, '')); right_text text := lower(coalesce(p_right, ''));
BEGIN
  -- 1. Calculations
  IF p_type = 'numeric'
     OR stem ~ '\m(cpi|spi|eac|tcpi|vac|bac|emv|pert|earned value|planned value|actual cost|payback|benefit-cost|communication channels|standard deviation|float)\M' THEN
    RETURN QUERY SELECT 'formula_error'::error_type, 'calculation question'; RETURN;
  END IF;
  -- 2. Question formats with a typical failure
  IF p_type = 'ordering' THEN
    RETURN QUERY SELECT 'process_misorder'::error_type, 'ordering question'; RETURN;
  END IF;
  IF p_type = 'matching' THEN
    RETURN QUERY SELECT 'terminology_confusion'::error_type, 'matching question'; RETURN;
  END IF;
  IF p_type = 'hotspot' OR p_graphic THEN
    RETURN QUERY SELECT 'reading_comprehension'::error_type, 'exhibit misread'; RETURN;
  END IF;
  -- 3. Chose a tool of the other delivery approach
  IF (p_approach = 'agile'
        AND chosen ~ '(change control board|change request|baseline|gantt|sign-off|formal approval|work breakdown)'
        AND right_text !~ '(change control board|change request|baseline|gantt|sign-off|formal approval|work breakdown)'
        AND stem !~ '(change control board|change request|baseline|gantt|sign-off|formal approval|work breakdown)')
     OR (p_approach = 'predictive'
        AND chosen ~ '\m(backlog|sprint|product owner|scrum|retrospective|velocity|kanban|iteration)\M'
        AND right_text !~ '\m(backlog|sprint|product owner|scrum|retrospective|velocity|kanban|iteration)\M'
        AND stem !~ '\m(backlog|sprint|product owner|scrum|retrospective|velocity|kanban|iteration)\M') THEN
    RETURN QUERY SELECT 'agile_predictive_confusion'::error_type, 'tool of the other approach'; RETURN;
  END IF;
  -- 4. Risk handled as an issue, or the reverse
  IF (chosen ~ 'issue log' AND right_text ~ 'risk')
     OR (chosen ~ 'risk (register|response|analysis)' AND (right_text ~ 'issue' OR stem ~ '(has occurred|has happened|already happened|is now happening)')) THEN
    RETURN QUERY SELECT 'risk_vs_issue_confusion'::error_type, 'risk and issue mixed up'; RETURN;
  END IF;
  -- 5. Accepted a change without assessing it
  IF chosen ~ '(implement the (change|request)|add (it|the (feature|request|change))|agree to (add|the change|the request)|accept the (change|request))'
     AND stem ~ '(change|request|scope|feature)' THEN
    RETURN QUERY SELECT 'scope_creep_confusion'::error_type, 'change accepted without analysis'; RETURN;
  END IF;
  -- 6. An extreme or avoiding answer
  IF chosen ~ '\m(ignore|always|never|fire|remove (him|her|the member)|replace the (team member|vendor)|refuse)\M' THEN
    RETURN QUERY SELECT 'distractor_chosen'::error_type, 'extreme option chosen'; RETURN;
  END IF;
  -- 7. Time
  IF p_time_ms > 0 AND p_time_ms < 10000 THEN
    RETURN QUERY SELECT 'time_pressure'::error_type, 'answered in under 10 seconds'; RETURN;
  END IF;
  IF p_time_ms > 180000 THEN
    RETURN QUERY SELECT 'overthinking'::error_type, 'more than 3 minutes on the question'; RETURN;
  END IF;
  -- 8. Key words in the stem
  IF stem ~ '\m(first|next|before|initially|immediately)\M' THEN
    RETURN QUERY SELECT 'missed_keyword'::error_type, 'sequence word in the question'; RETURN;
  END IF;
  IF stem ~ '\m(best|most|primary|main|greatest)\M' OR (p_type = 'multiple' AND p_hits > 0) THEN
    RETURN QUERY SELECT 'second_best_chosen'::error_type, 'a good but not the best answer'; RETURN;
  END IF;
  IF stem ~ 'stakeholder' AND p_task IN ('PEOPLE-4', 'PEOPLE-5', 'PEOPLE-6') THEN
    RETURN QUERY SELECT 'stakeholder_identification_error'::error_type, 'stakeholder question'; RETURN;
  END IF;
  RETURN QUERY SELECT 'knowledge_gap'::error_type, 'no specific signal';
END $$;

CREATE OR REPLACE FUNCTION classify_wrong_answer(p_version uuid, p_response jsonb, p_time_ms integer)
RETURNS TABLE (error_type error_type, rule text) LANGUAGE plpgsql STABLE AS $$
DECLARE v record; chosen text; right_text text; n_hit integer;
BEGIN
  SELECT qv.type_code, qv.approach_code, qv.is_graphic, qv.stem AS s, t.code AS task
  INTO v FROM question_versions qv JOIN tasks t ON t.id = qv.task_id WHERE qv.id = p_version;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT coalesce(string_agg(o.text, ' | '), ''), count(*) FILTER (WHERE o.is_correct) INTO chosen, n_hit
  FROM options o WHERE o.question_version_id = p_version
    AND o.id::text IN (SELECT jsonb_array_elements_text(coalesce(p_response, '[]'::jsonb)));
  SELECT coalesce(string_agg(o.text, ' | '), '') INTO right_text
  FROM options o WHERE o.question_version_id = p_version AND o.is_correct;
  RETURN QUERY SELECT * FROM classify_error_rules(v.type_code, v.approach_code, v.is_graphic, v.task, v.s, chosen, right_text, n_hit, p_time_ms);
END $$;

-- Records the error type of a wrong answer and returns it (NULL when right).
CREATE OR REPLACE FUNCTION record_answer_error(p_user uuid, p_version uuid, p_response jsonb, p_correct boolean,
                                               p_time_ms integer, p_source text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE c record; q uuid;
BEGIN
  IF p_correct THEN RETURN NULL; END IF;
  SELECT question_id INTO q FROM question_versions WHERE id = p_version;
  SELECT * INTO c FROM classify_wrong_answer(p_version, p_response, coalesce(p_time_ms, 0));
  IF c.error_type IS NULL THEN RETURN NULL; END IF;
  INSERT INTO error_classifications (user_id, question_id, question_version_id, attempt_type, error_type, rule)
  VALUES (p_user, q, p_version, CASE WHEN p_source IN ('practice', 'mock', 'adaptive') THEN p_source ELSE 'practice' END, c.error_type, c.rule);
  RETURN c.error_type::text;
END $$;

-- Mock exams: learn mastery and errors once per attempt.
CREATE OR REPLACE FUNCTION learn_from_attempt(p_attempt uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_user uuid; r record; n integer := 0;
BEGIN
  SELECT user_id INTO v_user FROM exam_attempts WHERE id = p_attempt AND result IS NOT NULL;
  IF v_user IS NULL THEN RETURN 0; END IF;
  INSERT INTO attempt_learning (attempt_id) VALUES (p_attempt) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN 0; END IF;
  FOR r IN
    SELECT aq.question_id, aq.question_version_id, a.response, a.is_correct, a.time_spent_ms
    FROM attempt_questions aq JOIN answers a ON a.attempt_question_id = aq.id
    WHERE aq.attempt_id = p_attempt AND a.is_correct IS NOT NULL AND jsonb_array_length(a.response) > 0
    ORDER BY aq.ordinal
  LOOP
    PERFORM record_learning(v_user, r.question_id, r.is_correct, 'mock');
    PERFORM record_answer_error(v_user, r.question_version_id, r.response, r.is_correct, r.time_spent_ms, 'mock');
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- Error summary for the learner: count, share and the last time seen.
CREATE OR REPLACE FUNCTION error_summary(p_user uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('errorType', x.error_type, 'count', x.n,
           'percent', round(100.0 * x.n / x.total), 'lastAt', x.last_at) ORDER BY x.n DESC), '[]'::jsonb)
  FROM (SELECT ec.error_type, count(*) AS n, max(ec.classified_at) AS last_at, sum(count(*)) OVER () AS total
        FROM error_classifications ec
        WHERE ec.user_id = p_user AND ec.error_type IS NOT NULL AND ec.classified_at > now() - interval '60 days'
        GROUP BY ec.error_type) x;
$$;

-- ------------------------------------------------------------------ analytics fix

CREATE OR REPLACE FUNCTION analytics_domain_breakdown(p_user uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'domainCode', d.code, 'domainName', d.name,
      'answered', coalesce(agg.answered, 0), 'correct', coalesce(agg.correct, 0),
      'accuracy', CASE WHEN coalesce(agg.answered, 0) = 0 THEN NULL ELSE round(100.0 * agg.correct / agg.answered, 1) END,
      'masteryScore', coalesce((SELECT round(avg(tm.weighted_score) * 100, 1)
        FROM task_mastery tm JOIN tasks t2 ON t2.id = tm.task_id
        WHERE tm.user_id = p_user AND t2.domain_id = d.id AND tm.attempts > 0), 0)
    ) ORDER BY d.ordinal), '[]'::jsonb)
  FROM domains d
  JOIN exam_blueprints bp ON bp.id = d.blueprint_id AND bp.status = 'active'
  LEFT JOIN (
    SELECT d3.code, count(*) AS answered, count(*) FILTER (WHERE ev.is_correct) AS correct
    FROM user_answer_events(p_user) ev
    JOIN question_versions qv ON qv.id = ev.question_version_id
    JOIN tasks t ON t.id = qv.task_id JOIN domains d3 ON d3.id = t.domain_id
    GROUP BY d3.code) agg ON agg.code = d.code;
$$;

-- ------------------------------------------------------------------ backfill

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM error_classifications) THEN RETURN; END IF;
  PERFORM record_answer_error(ps.user_id, pi.question_version_id, pi.response, false, pi.time_spent_ms, 'practice')
  FROM practice_items pi JOIN practice_sessions ps ON ps.id = pi.session_id
  WHERE pi.answered_at IS NOT NULL AND pi.is_correct = false;
  PERFORM record_answer_error(ea.user_id, aq.question_version_id, a.response, false, a.time_spent_ms, 'mock')
  FROM answers a JOIN attempt_questions aq ON aq.id = a.attempt_question_id JOIN exam_attempts ea ON ea.id = aq.attempt_id
  WHERE ea.result IS NOT NULL AND a.is_correct = false AND jsonb_array_length(a.response) > 0;
END $$;
