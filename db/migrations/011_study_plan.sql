-- Increment 21: Study Plan generation + Learner Profile refresh + Error Intel
-- Covers master-prompt sections 15 (error types), 17 (study plan), and 10 (learner intelligence).

-- ---------------------------------------------------------------- study plan generation

-- Generates or refreshes the weekly study plan for a user.
-- Returns the plan_json that is also written to study_plans.
CREATE OR REPLACE FUNCTION generate_study_plan(p_user uuid, p_week_start date)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_target     date;
  v_hours      integer;
  v_days_left  integer;
  v_weak_tasks jsonb;
  v_spaced_due integer;
  v_plan       jsonb;
BEGIN
  SELECT exam_target_date, coalesce(weekly_study_hours, 10)
  INTO v_target, v_hours
  FROM users WHERE id = p_user;

  v_days_left := greatest(0, (v_target - p_week_start)::integer);

  -- Top 3 weak tasks
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'taskCode', t.code, 'taskName', t.name, 'score', tm.weighted_score
  ) ORDER BY tm.weighted_score ASC), '[]'::jsonb)
  INTO v_weak_tasks
  FROM task_mastery tm JOIN tasks t ON t.id = tm.task_id
  WHERE tm.user_id = p_user AND tm.attempts >= 2
  LIMIT 3;

  -- Count spaced reviews due in this week
  SELECT count(*) INTO v_spaced_due
  FROM spaced_state
  WHERE user_id = p_user AND next_review_at <= (p_week_start + 7);

  -- Build a simple 7-day plan
  v_plan := jsonb_build_object(
    'weekStart', p_week_start,
    'totalHours', v_hours,
    'daysUntilExam', v_days_left,
    'spacedReviewsDue', v_spaced_due,
    'focusAreas', v_weak_tasks,
    'days', (
      SELECT jsonb_agg(
        jsonb_build_object(
          'day', p_week_start + (gs.d - 1),
          'activities', CASE
            WHEN gs.d IN (1, 4) THEN jsonb_build_array(
              jsonb_build_object('type', 'adaptive_practice', 'minutes', 45, 'note', 'Focus on weak areas'),
              CASE WHEN v_spaced_due > 0
                   THEN jsonb_build_object('type', 'spaced_review', 'minutes', 15, 'count', least(v_spaced_due, 10))
                   ELSE jsonb_build_object('type', 'light_practice', 'minutes', 15) END
            )
            WHEN gs.d IN (2, 5) THEN jsonb_build_array(
              jsonb_build_object('type', 'full_domain_practice', 'minutes', 60, 'note', 'Deep dive domain')
            )
            WHEN gs.d = 3 THEN jsonb_build_array(
              jsonb_build_object('type', 'mock_simulation', 'minutes', 90, 'note', '50-question timed session')
            )
            WHEN gs.d = 6 THEN jsonb_build_array(
              jsonb_build_object('type', 'review_mistakes', 'minutes', 45, 'note', 'Review this week errors'),
              jsonb_build_object('type', 'spaced_review', 'minutes', 15)
            )
            WHEN gs.d = 7 THEN jsonb_build_array(
              jsonb_build_object('type', 'rest_or_light', 'minutes', 30, 'note', 'Rest or light review')
            )
            ELSE jsonb_build_array(jsonb_build_object('type', 'practice', 'minutes', 30))
          END
        ) ORDER BY gs.d
      )
      FROM generate_series(1, 7) gs(d)
    )
  );

  -- Upsert into study_plans
  INSERT INTO study_plans (user_id, week_start, plan_json)
  VALUES (p_user, p_week_start, v_plan)
  ON CONFLICT (user_id, week_start)
  DO UPDATE SET plan_json = EXCLUDED.plan_json, created_at = now();

  RETURN v_plan;
END $$;

-- ---------------------------------------------------------------- refresh learner profile

CREATE OR REPLACE FUNCTION refresh_learner_profile(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_strongest uuid;
  v_weakest   uuid;
  v_dom_error error_type;
  v_total     integer;
  v_streak    integer;
  v_last      timestamptz;
  v_readiness numeric;
  v_pass_pct  numeric;
BEGIN
  -- Strongest task (most attempts + highest score)
  SELECT task_id INTO v_strongest
  FROM task_mastery WHERE user_id = p_user AND attempts >= 3
  ORDER BY weighted_score DESC LIMIT 1;

  -- Weakest task
  SELECT task_id INTO v_weakest
  FROM task_mastery WHERE user_id = p_user AND attempts >= 3
  ORDER BY weighted_score ASC LIMIT 1;

  -- Dominant error type (last 100 responses)
  SELECT error_type INTO v_dom_error
  FROM error_classifications
  WHERE user_id = p_user AND error_type IS NOT NULL
  GROUP BY error_type
  ORDER BY count(*) DESC LIMIT 1;

  -- Total questions seen across practice and exams
  SELECT count(*) INTO v_total FROM user_answer_events(p_user);

  -- Last studied at
  SELECT max(answered_at) INTO v_last FROM user_answer_events(p_user);

  -- Study streak (consecutive days with at least one answered question)
  WITH daily AS (
    SELECT date_trunc('day', answered_at) AS day
    FROM user_answer_events(p_user)
    GROUP BY 1
    ORDER BY 1 DESC
  ),
  gaps AS (
    SELECT day, lag(day) OVER (ORDER BY day DESC) AS prev_day FROM daily
  )
  SELECT count(*)::integer INTO v_streak
  FROM (
    SELECT day FROM gaps
    WHERE prev_day IS NULL OR (prev_day - day) = '1 day'::interval
  ) x;

  -- Readiness + predicted pass %
  v_readiness := coalesce(readiness_score(p_user), 0);
  -- No pass prediction: PMI does not publish a passing score, so we do not estimate one.
  v_pass_pct  := NULL;

  INSERT INTO learner_profiles (
    user_id, strongest_task_id, weakest_task_id, dominant_error_type,
    readiness_score, predicted_pass_pct, total_questions_seen,
    study_streak_days, last_studied_at, profile_at
  )
  VALUES (
    p_user, v_strongest, v_weakest, v_dom_error,
    v_readiness, v_pass_pct, v_total,
    coalesce(v_streak, 0), v_last, now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    strongest_task_id   = EXCLUDED.strongest_task_id,
    weakest_task_id     = EXCLUDED.weakest_task_id,
    dominant_error_type = EXCLUDED.dominant_error_type,
    readiness_score     = EXCLUDED.readiness_score,
    predicted_pass_pct  = EXCLUDED.predicted_pass_pct,
    total_questions_seen = EXCLUDED.total_questions_seen,
    study_streak_days   = EXCLUDED.study_streak_days,
    last_studied_at     = EXCLUDED.last_studied_at,
    profile_at          = now();
END $$;

-- ---------------------------------------------------------------- error classification bulk insert

-- Called from API after scoring a practice or mock session
CREATE OR REPLACE FUNCTION classify_errors(p_user uuid, p_rows jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO error_classifications (user_id, question_id, attempt_type, error_type, ai_assisted)
  SELECT
    p_user,
    (r->>'questionId')::uuid,
    coalesce(r->>'attemptType', 'practice'),
    -- Map string to enum, NULL if not a known type
    CASE WHEN r->>'errorType' IS NOT NULL THEN (r->>'errorType')::error_type ELSE NULL END,
    coalesce((r->>'aiAssisted')::boolean, false)
  FROM jsonb_array_elements(p_rows) r
  WHERE (r->>'questionId') IS NOT NULL;
END $$;
