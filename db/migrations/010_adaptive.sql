-- Increment 20: Adaptive Learning Engine
-- Adds: task mastery tracking, spaced repetition (SM-2), error classification,
-- learner profiles, next-best-action engine, readiness score, diagnostic mode.
-- All V2 features from master-prompt sections 9–18, 28–29, 31.

-- ---------------------------------------------------------------- task mastery

-- Per-user, per-task aggregate performance for adaptive selection
CREATE TABLE task_mastery (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id    uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- rolling stats (last 20 responses per task)
  attempts   integer NOT NULL DEFAULT 0,
  correct    integer NOT NULL DEFAULT 0,
  -- SM-2 ease factor (starts at 2.5, floor 1.3)
  ease       numeric(4,2) NOT NULL DEFAULT 2.50,
  -- current SM-2 interval in days
  interval_days integer NOT NULL DEFAULT 1,
  -- when this task is next due for spaced review
  next_review_at timestamptz,
  -- running weighted score 0–1 (exponential decay, α=0.3)
  weighted_score numeric(4,3) NOT NULL DEFAULT 0.500,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, task_id)
);
CREATE INDEX task_mastery_due_idx ON task_mastery (user_id, next_review_at)
  WHERE next_review_at IS NOT NULL;

-- ---------------------------------------------------------------- spaced reviews

-- Individual spaced-repetition review records
CREATE TABLE spaced_reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id     uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  -- SM-2 quality: 0-5 (0-2 = fail, 3-5 = pass with varying ease)
  quality         smallint NOT NULL CHECK (quality BETWEEN 0 AND 5),
  -- resulting interval after this review (days)
  interval_days   integer NOT NULL,
  next_review_at  timestamptz NOT NULL,
  reviewed_at     timestamptz NOT NULL DEFAULT now(),
  source          text NOT NULL DEFAULT 'practice'  -- 'practice' | 'mock' | 'adaptive'
);
CREATE INDEX spaced_reviews_user_q_idx ON spaced_reviews (user_id, question_id, reviewed_at DESC);
CREATE INDEX spaced_reviews_due_idx    ON spaced_reviews (user_id, next_review_at);

-- Latest SM-2 state per (user, question) — maintained by trigger
CREATE TABLE spaced_state (
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id     uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  repetition      integer NOT NULL DEFAULT 0,  -- consecutive correct (SM-2 n)
  ease            numeric(4,2) NOT NULL DEFAULT 2.50,
  interval_days   integer NOT NULL DEFAULT 1,
  next_review_at  timestamptz NOT NULL DEFAULT now(),
  last_reviewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, question_id)
);
CREATE INDEX spaced_state_due_idx ON spaced_state (user_id, next_review_at);

-- ---------------------------------------------------------------- error classification

-- 16 error types (sec 15) classified per incorrect response
CREATE TYPE error_type AS ENUM (
  'knowledge_gap', 'terminology_confusion', 'process_misorder',
  'formula_error', 'reading_comprehension', 'distractor_chosen',
  'second_best_chosen', 'missed_keyword', 'misapplied_framework',
  'over_reliance_on_pmi_phrasing', 'time_pressure', 'overthinking',
  'agile_predictive_confusion', 'scope_creep_confusion',
  'stakeholder_identification_error', 'risk_vs_issue_confusion'
);

CREATE TABLE error_classifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id   uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  attempt_type  text NOT NULL CHECK (attempt_type IN ('practice', 'mock', 'adaptive')),
  error_type    error_type,
  ai_assisted   boolean NOT NULL DEFAULT false,
  classified_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX error_class_user_idx ON error_classifications (user_id, classified_at DESC);
CREATE INDEX error_class_type_idx ON error_classifications (user_id, error_type);

-- ---------------------------------------------------------------- adaptive events

-- Log every adaptive selection decision for audit / ML training
CREATE TABLE adaptive_selection_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id   uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  session_id    uuid,  -- nullable: may be a standalone pick
  signal        text NOT NULL,  -- 'weakness' | 'spaced_review' | 'diagnostic' | 'random'
  score_before  numeric(4,3),   -- weighted_score at selection time
  selected_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX adaptive_sel_user_idx ON adaptive_selection_events (user_id, selected_at DESC);

-- ---------------------------------------------------------------- learner profile

-- Aggregated profile recomputed nightly (or on demand)
CREATE TABLE learner_profiles (
  user_id              uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  strongest_task_id    uuid REFERENCES tasks(id),
  weakest_task_id      uuid REFERENCES tasks(id),
  dominant_error_type  error_type,
  readiness_score      numeric(5,2) CHECK (readiness_score BETWEEN 0 AND 100),
  predicted_pass_pct   numeric(5,2) CHECK (predicted_pass_pct BETWEEN 0 AND 100),
  total_questions_seen integer NOT NULL DEFAULT 0,
  study_streak_days    integer NOT NULL DEFAULT 0,
  last_studied_at      timestamptz,
  profile_at           timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- study plan

CREATE TABLE study_plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start  date NOT NULL,
  plan_json   jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, week_start)
);

-- ---------------------------------------------------------------- diagnostic sessions

ALTER TABLE practice_sessions
  ADD COLUMN IF NOT EXISTS diagnostic boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------- SM-2 trigger: update spaced_state on review insert

CREATE OR REPLACE FUNCTION sm2_after_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cur spaced_state%ROWTYPE;
  new_ease numeric(4,2);
  new_rep  integer;
  new_int  integer;
  new_next timestamptz;
BEGIN
  SELECT * INTO cur FROM spaced_state WHERE user_id = NEW.user_id AND question_id = NEW.question_id;
  IF NOT FOUND THEN
    INSERT INTO spaced_state (user_id, question_id) VALUES (NEW.user_id, NEW.question_id)
    RETURNING * INTO cur;
  END IF;

  -- SM-2 algorithm
  IF NEW.quality >= 3 THEN
    IF cur.repetition = 0 THEN new_int := 1;
    ELSIF cur.repetition = 1 THEN new_int := 6;
    ELSE new_int := round(cur.interval_days * cur.ease);
    END IF;
    new_rep  := cur.repetition + 1;
    new_ease := greatest(1.3, cur.ease + 0.1 - (5 - NEW.quality) * (0.08 + (5 - NEW.quality) * 0.02));
  ELSE
    -- failed: reset repetition, keep ease (don't penalise ease on fail)
    new_rep  := 0;
    new_int  := 1;
    new_ease := cur.ease;
  END IF;
  new_next := now() + (new_int || ' days')::interval;

  UPDATE spaced_state SET
    repetition       = new_rep,
    ease             = new_ease,
    interval_days    = new_int,
    next_review_at   = new_next,
    last_reviewed_at = now()
  WHERE user_id = NEW.user_id AND question_id = NEW.question_id;

  -- Also update interval on the row just inserted (denormalise for queries)
  UPDATE spaced_reviews SET interval_days = new_int, next_review_at = new_next WHERE id = NEW.id;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_sm2_after_review
  AFTER INSERT ON spaced_reviews
  FOR EACH ROW EXECUTE FUNCTION sm2_after_review();

-- ---------------------------------------------------------------- update_task_mastery

-- Called after each answered question to keep task_mastery current.
-- p_correct: 1 = correct, 0 = wrong
CREATE OR REPLACE FUNCTION update_task_mastery(p_user uuid, p_task uuid, p_correct integer)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  cur task_mastery%ROWTYPE;
  alpha constant numeric := 0.3;
  new_ws numeric(4,3);
BEGIN
  INSERT INTO task_mastery (user_id, task_id)
  VALUES (p_user, p_task)
  ON CONFLICT DO NOTHING;

  SELECT * INTO cur FROM task_mastery WHERE user_id = p_user AND task_id = p_task;

  -- Exponential moving average
  new_ws := round((alpha * p_correct + (1 - alpha) * cur.weighted_score)::numeric, 3);

  UPDATE task_mastery SET
    attempts       = attempts + 1,
    correct        = correct + p_correct,
    weighted_score = new_ws,
    updated_at     = now()
  WHERE user_id = p_user AND task_id = p_task;
END $$;

-- ---------------------------------------------------------------- next_best_action

-- Returns a recommendation object for the dashboard.
-- Priority: spaced reviews due → weak tasks → random encouragement
CREATE OR REPLACE FUNCTION next_best_action(p_user uuid, p_now timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
  spaced_count integer;
  weak_task    record;
  result       jsonb;
BEGIN
  -- 1. Spaced reviews overdue
  SELECT count(*) INTO spaced_count
  FROM spaced_state
  WHERE user_id = p_user AND next_review_at <= p_now;

  IF spaced_count > 0 THEN
    RETURN jsonb_build_object(
      'type',    'spaced_review',
      'count',   spaced_count,
      'message', 'You have ' || spaced_count || ' questions due for review.',
      'action',  'practice',
      'params',  jsonb_build_object('mode', 'spaced_review')
    );
  END IF;

  -- 2. Weakest task (weighted_score < 0.5, minimum 3 attempts)
  SELECT t.code, t.name, tm.weighted_score, tm.attempts
  INTO weak_task
  FROM task_mastery tm
  JOIN tasks t ON t.id = tm.task_id
  WHERE tm.user_id = p_user
    AND tm.attempts >= 3
    AND tm.weighted_score < 0.5
  ORDER BY tm.weighted_score ASC
  LIMIT 1;

  IF weak_task IS NOT NULL THEN
    RETURN jsonb_build_object(
      'type',    'weakness',
      'task',    weak_task.code,
      'score',   weak_task.weighted_score,
      'message', 'Focus on ' || weak_task.name || ' — your current score is ' || round(weak_task.weighted_score * 100) || '%.',
      'action',  'practice',
      'params',  jsonb_build_object('mode', 'adaptive', 'taskCode', weak_task.code)
    );
  END IF;

  -- 3. No specific signal — encourage practice
  RETURN jsonb_build_object(
    'type',    'general',
    'message', 'Keep practising to build your readiness score.',
    'action',  'practice',
    'params',  jsonb_build_object('mode', 'standard')
  );
END $$;

-- ---------------------------------------------------------------- readiness_score

-- Readiness = weighted average of task mastery × blueprint domain weights,
-- scaled 0–100, with a 0.5 floor for unstarted tasks.
CREATE OR REPLACE FUNCTION readiness_score(p_user uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT round(
    100.0 * SUM(coalesce(tm.weighted_score, 0.5) * bp.weight_pct / 100.0)
    / NULLIF(SUM(bp.weight_pct / 100.0), 0)
  )::numeric
  FROM tasks t
  JOIN domains d ON d.id = t.domain_id
  JOIN exam_blueprints bp ON bp.id = d.blueprint_id AND bp.status = 'active'
  LEFT JOIN task_mastery tm ON tm.task_id = t.id AND tm.user_id = p_user;
$$;

-- ---------------------------------------------------------------- update user_dashboard to include adaptive signals

CREATE OR REPLACE FUNCTION user_dashboard(p_user uuid, p_now timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'user', (
      SELECT jsonb_build_object(
        'displayName', display_name, 'email', email, 'language', language,
        'examTargetDate', exam_target_date, 'weeklyStudyHours', weekly_study_hours
      ) FROM users WHERE id = p_user
    ),
    'access', (
      SELECT jsonb_build_object(
        'plan', plan, 'examsRemaining', exams_remaining,
        'practiceRemaining', practice_remaining, 'expiresAt', expires_at
      ) FROM user_access WHERE user_id = p_user
    ),
    'stats', jsonb_build_object(
      'questionsAnswered', (
        SELECT count(*) FROM practice_items pi
        JOIN practice_sessions ps ON ps.id = pi.session_id
        WHERE ps.user_id = p_user AND pi.answered
      ),
      'practiceAccuracy', (
        SELECT round(100.0 * sum(CASE WHEN pi.is_correct THEN 1 ELSE 0 END)::numeric
                     / NULLIF(count(*), 0), 1)
        FROM practice_items pi
        JOIN practice_sessions ps ON ps.id = pi.session_id
        WHERE ps.user_id = p_user AND pi.answered
      ),
      'mocksCompleted', (SELECT count(*) FROM exam_attempts WHERE user_id = p_user AND result IS NOT NULL),
      'studyStreakDays', coalesce(
        (SELECT study_streak_days FROM learner_profiles WHERE user_id = p_user), 0
      )
    ),
    'readinessScore', readiness_score(p_user),
    'spacedReviewsDue', (
      SELECT count(*) FROM spaced_state WHERE user_id = p_user AND next_review_at <= p_now
    ),
    'taskMastery', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'taskCode', t.code, 'taskName', t.name,
        'score', tm.weighted_score, 'attempts', tm.attempts,
        'nextReviewAt', tm.next_review_at
      ) ORDER BY tm.weighted_score ASC), '[]'::jsonb)
      FROM task_mastery tm JOIN tasks t ON t.id = tm.task_id
      WHERE tm.user_id = p_user
    ),
    'recentMockScores', (
      SELECT coalesce(jsonb_agg(
        jsonb_build_object('submittedAt', submitted_at, 'scorePercent', score_percent)
        ORDER BY submitted_at DESC
      ), '[]'::jsonb)
      FROM (
        SELECT submitted_at, score_percent FROM exam_attempts
        WHERE user_id = p_user AND result IS NOT NULL
        ORDER BY submitted_at DESC LIMIT 5
      ) s
    ),
    'recommendation', next_best_action(p_user, p_now)
  );
$$;
