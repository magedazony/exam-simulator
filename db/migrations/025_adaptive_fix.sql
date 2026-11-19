-- Adaptive learning, made to work end to end.
--
-- Before this migration the API passed a task code ('PEOPLE-1') where a task
-- uuid was expected, so task mastery and spaced repetition were never written,
-- the readiness score stayed at its starting value and the "adaptive" and
-- "review" practice buttons had no session mode behind them.
--
-- This migration:
--   * adds record_learning(user, question, correct, source), which finds the
--     task itself and updates mastery and the spaced-repetition state;
--   * learns from finished mock exams once each (learn_from_attempt);
--   * adds the practice modes 'adaptive' and 'spaced_review';
--   * makes readiness count tasks never practised as 0, not 50%;
--   * rebuilds mastery and review state from the answers users already gave.

-- ------------------------------------------------------------------ learning

-- Questions can belong to tasks of an earlier blueprint. Mastery is kept on
-- the active blueprint's task with the same domain and task code.
CREATE OR REPLACE FUNCTION active_task_id(p_task uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce((
    SELECT t2.id FROM tasks t JOIN domains d ON d.id = t.domain_id,
           tasks t2 JOIN domains d2 ON d2.id = t2.domain_id JOIN exam_blueprints b ON b.id = d2.blueprint_id AND b.status = 'active'
    WHERE t.id = p_task AND t2.code = t.code AND d2.code = d.code LIMIT 1), p_task);
$$;

CREATE OR REPLACE FUNCTION record_learning(p_user uuid, p_question uuid, p_correct boolean, p_source text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_task uuid;
BEGIN
  SELECT active_task_id(v.task_id) INTO v_task
  FROM questions q JOIN question_versions v ON v.id = q.current_version_id
  WHERE q.id = p_question;
  IF v_task IS NULL THEN RETURN; END IF;
  PERFORM update_task_mastery(p_user, v_task, CASE WHEN p_correct THEN 1 ELSE 0 END);
  -- SM-2 quality: 4 for a correct answer, 1 for a wrong one. The trigger
  -- on spaced_reviews keeps spaced_state current.
  INSERT INTO spaced_reviews (user_id, question_id, quality, interval_days, next_review_at, source)
  VALUES (p_user, p_question, CASE WHEN p_correct THEN 4 ELSE 1 END, 1, now() + interval '1 day',
          CASE WHEN p_source IN ('practice', 'mock', 'adaptive') THEN p_source ELSE 'practice' END);
END $$;

CREATE TABLE IF NOT EXISTS attempt_learning (
  attempt_id uuid PRIMARY KEY REFERENCES exam_attempts(id) ON DELETE CASCADE,
  learned_at timestamptz NOT NULL DEFAULT now()
);

-- Learn from a scored mock exam. Safe to call more than once.
CREATE OR REPLACE FUNCTION learn_from_attempt(p_attempt uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_user uuid; r record; n integer := 0;
BEGIN
  SELECT user_id INTO v_user FROM exam_attempts WHERE id = p_attempt AND result IS NOT NULL;
  IF v_user IS NULL THEN RETURN 0; END IF;
  INSERT INTO attempt_learning (attempt_id) VALUES (p_attempt) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN 0; END IF;
  FOR r IN
    SELECT aq.question_id, a.is_correct
    FROM attempt_questions aq JOIN answers a ON a.attempt_question_id = aq.id
    WHERE aq.attempt_id = p_attempt AND a.is_correct IS NOT NULL AND jsonb_array_length(a.response) > 0
    ORDER BY aq.ordinal
  LOOP
    PERFORM record_learning(v_user, r.question_id, r.is_correct, 'mock');
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- ------------------------------------------------------------------ readiness

-- Tasks never practised count as 0. The score only rises with real evidence.
CREATE OR REPLACE FUNCTION readiness_score(p_user uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT round(
    100.0 * SUM(CASE WHEN coalesce(tm.attempts, 0) = 0 THEN 0 ELSE tm.weighted_score END * d.weight_pct / dc.n)
    / NULLIF(SUM(d.weight_pct / dc.n), 0)
  )::numeric
  FROM tasks t
  JOIN domains d ON d.id = t.domain_id
  JOIN exam_blueprints bp ON bp.id = d.blueprint_id AND bp.status = 'active'
  JOIN (SELECT domain_id, count(*)::numeric AS n FROM tasks GROUP BY domain_id) dc ON dc.domain_id = d.id
  LEFT JOIN task_mastery tm ON tm.task_id = t.id AND tm.user_id = p_user;
$$;

-- The general recommendation pointed at a practice mode that does not exist.
CREATE OR REPLACE FUNCTION next_best_action(p_user uuid, p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE spaced_count integer; weak_task record; seen integer;
BEGIN
  SELECT count(*) INTO spaced_count FROM spaced_state WHERE user_id = p_user AND next_review_at <= p_now;
  IF spaced_count > 0 THEN
    RETURN jsonb_build_object('type', 'spaced_review', 'count', spaced_count,
      'message', 'You have ' || spaced_count || ' questions due for review.',
      'action', 'practice', 'params', jsonb_build_object('mode', 'spaced_review'));
  END IF;
  SELECT t.code, t.name, tm.weighted_score INTO weak_task
  FROM task_mastery tm JOIN tasks t ON t.id = tm.task_id
  WHERE tm.user_id = p_user AND tm.attempts >= 3 AND tm.weighted_score < 0.6
  ORDER BY tm.weighted_score ASC LIMIT 1;
  IF weak_task IS NOT NULL THEN
    RETURN jsonb_build_object('type', 'weakness', 'task', weak_task.code, 'score', weak_task.weighted_score,
      'message', 'Focus on ' || weak_task.name || ' — your current score is ' || round(weak_task.weighted_score * 100) || '%.',
      'action', 'practice', 'params', jsonb_build_object('mode', 'adaptive', 'taskCodes', jsonb_build_array(weak_task.code)));
  END IF;
  SELECT count(*) INTO seen FROM task_mastery WHERE user_id = p_user AND attempts > 0;
  RETURN jsonb_build_object('type', 'general',
    'message', CASE WHEN seen = 0 THEN 'Start with an adaptive session so the simulator can find your strengths and gaps.'
                    ELSE 'Keep practising to build your readiness score.' END,
    'action', 'practice', 'params', jsonb_build_object('mode', 'adaptive'));
END $$;

-- ------------------------------------------------------------------ practice modes

ALTER TABLE practice_sessions DROP CONSTRAINT IF EXISTS practice_sessions_mode_check;
ALTER TABLE practice_sessions ADD CONSTRAINT practice_sessions_mode_check
  CHECK (mode IN ('quick', 'focused', 'weak_areas', 'timed', 'incorrect_only', 'adaptive', 'spaced_review'));

-- adaptive:      weighted random sampling (Efraimidis–Spirakis). Each task's
--                weight grows as its mastery falls and with its domain weight;
--                tasks not yet practised get a high weight so they are probed.
--                Difficulty follows mastery: weak tasks get easy/medium
--                questions, strong tasks get medium/hard. Questions answered
--                correctly in the last 7 days are skipped while others remain.
-- spaced_review: questions whose spaced-repetition review is due, most
--                overdue first.
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
  SELECT s_id, row_number() OVER (ORDER BY c.sort_key), c.qid, c.vid
  FROM (
    SELECT q.id AS qid, v.id AS vid,
      CASE
        WHEN p_mode = 'spaced_review' THEN extract(epoch FROM ss.next_review_at)
        WHEN p_mode = 'adaptive' THEN
          -- smaller key = picked first; key = -ln(u) / weight
          -ln(greatest(random(), 1e-9)) / (
            (CASE WHEN coalesce(tm.attempts, 0) = 0 THEN 0.8 ELSE 1.05 - tm.weighted_score END)
            * (d.weight_pct / 100.0 + 0.2)
            * (CASE
                 WHEN coalesce(tm.attempts, 0) = 0 THEN CASE WHEN v.difficulty_code = 'medium' THEN 1.5 ELSE 1 END
                 WHEN tm.weighted_score < 0.5 THEN CASE v.difficulty_code WHEN 'easy' THEN 1.6 WHEN 'medium' THEN 1.3 ELSE 0.6 END
                 WHEN tm.weighted_score < 0.8 THEN CASE v.difficulty_code WHEN 'medium' THEN 1.5 ELSE 1 END
                 ELSE CASE v.difficulty_code WHEN 'hard' THEN 1.6 WHEN 'medium' THEN 1.2 ELSE 0.5 END
               END)
            * (CASE WHEN rc.question_id IS NULL THEN 1 ELSE 0.02 END))
        ELSE random()
      END AS sort_key
    FROM questions q
    JOIN question_versions v ON v.id = q.current_version_id
    JOIN tasks t ON t.id = v.task_id
    JOIN domains d ON d.id = t.domain_id
    LEFT JOIN task_mastery tm ON tm.user_id = p_user AND tm.task_id = active_task_id(t.id)
    LEFT JOIN spaced_state ss ON ss.user_id = p_user AND ss.question_id = q.id
    LEFT JOIN (
      SELECT e.question_id FROM user_answer_events(p_user) e
      WHERE e.is_correct AND e.answered_at > now() - interval '7 days'
      GROUP BY e.question_id) rc ON rc.question_id = q.id
    WHERE (d.code, t.code) IN (SELECT d2.code, t2.code FROM domains d2 JOIN tasks t2 ON t2.domain_id = d2.id
                               WHERE d2.blueprint_id = bp_id)
      AND q.status = 'published' AND v.workflow_state = 'published' AND v.case_study_id IS NULL
      AND filter_allows(p_filters->'domainCodes', d.code)
      AND filter_allows(p_filters->'taskCodes', t.code)
      AND filter_allows(p_filters->'approaches', v.approach_code)
      AND filter_allows(p_filters->'difficulties', v.difficulty_code)
      AND filter_allows(p_filters->'types', v.type_code)
      AND (weak_tasks IS NULL OR v.task_id = ANY (weak_tasks))
      AND (p_mode <> 'spaced_review' OR ss.next_review_at <= now())
      AND (p_mode <> 'incorrect_only' OR q.id IN (
            SELECT e.question_id FROM user_answer_events(p_user) e
            GROUP BY e.question_id
            HAVING NOT (array_agg(e.is_correct ORDER BY e.answered_at DESC))[1]))
      AND q.id NOT IN (
            SELECT aq.question_id FROM attempt_questions aq
            JOIN exam_attempts ea ON ea.id = aq.attempt_id
            WHERE ea.user_id = p_user AND ea.result IS NULL)
    ORDER BY 3
    LIMIT p_count
  ) c;
  GET DIAGNOSTICS picked = ROW_COUNT;

  IF picked = 0 THEN RAISE EXCEPTION 'no questions match the filters'; END IF;
  UPDATE practice_sessions SET question_count = picked WHERE id = s_id;
  RETURN s_id;
END $$;

-- ------------------------------------------------------------------ backfill

-- Rebuild mastery from every answer already given, oldest first, so the
-- moving average matches what record_learning would have produced.
DO $$
DECLARE r record;
BEGIN
  IF EXISTS (SELECT 1 FROM task_mastery) THEN RETURN; END IF;
  FOR r IN
    SELECT u.id AS user_id, e.question_id, e.is_correct
    FROM users u, LATERAL user_answer_events(u.id) e
    ORDER BY u.id, e.answered_at
  LOOP
    PERFORM record_learning(r.user_id, r.question_id, r.is_correct, 'practice');
  END LOOP;
  INSERT INTO attempt_learning (attempt_id) SELECT id FROM exam_attempts WHERE result IS NOT NULL ON CONFLICT DO NOTHING;
END $$;

-- ------------------------------------------------------------------ study plan

-- Same weekly plan as before, with two fixes: the three weakest tasks are
-- really limited to three, and the week adapts to the exam date (more mock
-- practice in the last two weeks).
CREATE OR REPLACE FUNCTION generate_study_plan(p_user uuid, p_week_start date)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_target date; v_hours integer; v_days_left integer; v_weak jsonb; v_due integer; v_plan jsonb; v_final boolean;
BEGIN
  SELECT exam_target_date, coalesce(weekly_study_hours, 10) INTO v_target, v_hours FROM users WHERE id = p_user;
  v_days_left := CASE WHEN v_target IS NULL THEN NULL ELSE greatest(0, (v_target - p_week_start)::integer) END;
  v_final := v_days_left IS NOT NULL AND v_days_left <= 14;

  SELECT coalesce(jsonb_agg(w ORDER BY (w->>'score')::numeric), '[]'::jsonb) INTO v_weak FROM (
    SELECT jsonb_build_object('taskCode', t.code, 'taskName', t.name, 'score', tm.weighted_score) AS w
    FROM task_mastery tm JOIN tasks t ON t.id = tm.task_id
    WHERE tm.user_id = p_user AND tm.attempts >= 2
    ORDER BY tm.weighted_score ASC LIMIT 3) x;

  SELECT count(*) INTO v_due FROM spaced_state WHERE user_id = p_user AND next_review_at <= (p_week_start + 7);

  v_plan := jsonb_build_object(
    'weekStart', p_week_start, 'totalHours', v_hours, 'daysUntilExam', v_days_left,
    'spacedReviewsDue', v_due, 'focusAreas', v_weak,
    'days', (SELECT jsonb_agg(jsonb_build_object('day', p_week_start + (gs.d - 1), 'activities',
      CASE
        WHEN gs.d IN (1, 4) THEN jsonb_build_array(
          jsonb_build_object('type', 'adaptive_practice', 'minutes', 45, 'count', 20),
          CASE WHEN v_due > 0 THEN jsonb_build_object('type', 'spaced_review', 'minutes', 15, 'count', least(v_due, 15))
               ELSE jsonb_build_object('type', 'light_practice', 'minutes', 15, 'count', 10) END)
        WHEN gs.d IN (2, 5) THEN CASE WHEN v_final
          THEN jsonb_build_array(jsonb_build_object('type', 'mock_simulation', 'minutes', 90))
          ELSE jsonb_build_array(jsonb_build_object('type', 'full_domain_practice', 'minutes', 60, 'count', 30)) END
        WHEN gs.d = 3 THEN jsonb_build_array(jsonb_build_object('type', 'mock_simulation', 'minutes', 90))
        WHEN gs.d = 6 THEN jsonb_build_array(
          jsonb_build_object('type', 'review_mistakes', 'minutes', 45, 'count', 20),
          jsonb_build_object('type', 'spaced_review', 'minutes', 15, 'count', 15))
        ELSE jsonb_build_array(jsonb_build_object('type', 'rest_or_light', 'minutes', 30, 'count', 5))
      END) ORDER BY gs.d) FROM generate_series(1, 7) gs(d)));

  INSERT INTO study_plans (user_id, week_start, plan_json) VALUES (p_user, p_week_start, v_plan)
  ON CONFLICT (user_id, week_start) DO UPDATE SET plan_json = EXCLUDED.plan_json, created_at = now();
  RETURN v_plan;
END $$;
