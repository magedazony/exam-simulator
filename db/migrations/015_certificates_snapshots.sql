-- Migration 015: Completion certificates, performance snapshots, question difficulty calibration
-- Sprint 6 — analytics and social proof

-- ---------------------------------------------------------------- Completion certificates
-- Issued when a candidate passes a mock exam (score >= pass_threshold in the blueprint).
-- Public verification URL: /verify/<token>
CREATE TABLE IF NOT EXISTS certificates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempt_id       uuid NOT NULL UNIQUE REFERENCES exam_attempts(id) ON DELETE CASCADE,
  token            text NOT NULL UNIQUE,              -- URL-safe random token (32 hex chars)
  score_percent    int  NOT NULL,
  passed           boolean NOT NULL DEFAULT false,
  issued_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  revoke_reason    text
);
CREATE INDEX IF NOT EXISTS idx_certificates_user ON certificates(user_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_certificates_token ON certificates(token) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- Weekly performance snapshots
-- One row per user per ISO week.  Used for: progress charts, streak display, and email digests.
CREATE TABLE IF NOT EXISTS weekly_snapshots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start       date NOT NULL,                     -- Monday of the ISO week
  questions_answered int NOT NULL DEFAULT 0,
  questions_correct  int NOT NULL DEFAULT 0,
  time_studied_min   int NOT NULL DEFAULT 0,
  domains            jsonb,                            -- {"PEOPLE": {"q":10,"c":7}, ...}
  streak_days        int NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, week_start)
);
CREATE INDEX IF NOT EXISTS idx_weekly_snapshots_user ON weekly_snapshots(user_id, week_start DESC);

-- ---------------------------------------------------------------- Question difficulty calibration
-- Running totals used to compute an item's empirical difficulty after each attempt.
-- Actual difficulty label is derived from correct_pct: >=70% = easy, 40-69% = medium, <40% = hard.
CREATE TABLE IF NOT EXISTS question_stats (
  question_version_id  uuid PRIMARY KEY REFERENCES question_versions(id) ON DELETE CASCADE,
  times_seen           int NOT NULL DEFAULT 0,
  times_correct        int NOT NULL DEFAULT 0,
  avg_time_ms          int NOT NULL DEFAULT 0,        -- running average response time
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- Update difficulty label function
CREATE OR REPLACE FUNCTION recalc_question_difficulty(p_version_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_pct int;
  v_label text;
BEGIN
  SELECT
    CASE WHEN times_seen = 0 THEN NULL
         ELSE ROUND(100.0 * times_correct / times_seen)::int
    END INTO v_pct
  FROM question_stats WHERE question_version_id = p_version_id;

  IF v_pct IS NULL OR v_pct >= 70 THEN
    v_label := 'easy';
  ELSIF v_pct >= 40 THEN
    v_label := 'medium';
  ELSE
    v_label := 'hard';
  END IF;

  -- The author's difficulty label on question_versions is left alone; the
  -- measured difficulty is reported in the question_difficulty view (016).
  PERFORM v_label;
END;
$$;

-- ---------------------------------------------------------------- Trigger: update question_stats on answer save
-- Called by the existing save_answer stored procedure stub if present; otherwise harmless.
CREATE OR REPLACE FUNCTION on_answer_saved() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO question_stats(question_version_id, times_seen, times_correct, avg_time_ms, updated_at)
       VALUES (NEW.question_version_id, 1,
               CASE WHEN NEW.is_correct THEN 1 ELSE 0 END,
               COALESCE(NEW.time_spent_ms, 0),
               now())
  ON CONFLICT (question_version_id) DO UPDATE
     SET times_seen    = question_stats.times_seen + 1,
         times_correct = question_stats.times_correct + (CASE WHEN NEW.is_correct THEN 1 ELSE 0 END),
         avg_time_ms   = (question_stats.avg_time_ms * question_stats.times_seen + COALESCE(NEW.time_spent_ms, 0))
                         / (question_stats.times_seen + 1),
         updated_at    = now();

  PERFORM recalc_question_difficulty(NEW.question_version_id);
  RETURN NEW;
END;
$$;

-- Measured difficulty is computed from stored answers by the question_difficulty view (016).

-- ---------------------------------------------------------------- Helper: issue certificate after exam submission
-- A certificate records that a candidate completed a full mock exam and their
-- score. It makes no pass/fail claim: PMI does not publish a passing score.
ALTER TABLE certificates ALTER COLUMN passed DROP NOT NULL, ALTER COLUMN passed DROP DEFAULT;

CREATE OR REPLACE FUNCTION issue_certificate_if_passed(p_attempt_id uuid) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_user_id uuid;
  v_score   int;
  v_cert_id uuid;
BEGIN
  SELECT ea.user_id, round(ea.score_percent)::int INTO v_user_id, v_score
  FROM exam_attempts ea
  WHERE ea.id = p_attempt_id AND ea.result IS NOT NULL AND ea.score_percent IS NOT NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT id INTO v_cert_id FROM certificates WHERE attempt_id = p_attempt_id;
  IF FOUND THEN RETURN v_cert_id; END IF;

  INSERT INTO certificates(user_id, attempt_id, token, score_percent, passed)
  VALUES (v_user_id, p_attempt_id, encode(gen_random_bytes(16), 'hex'), v_score, NULL)
  RETURNING id INTO v_cert_id;

  INSERT INTO notifications(user_id, type, title, title_ar, body, body_ar, action_url)
  VALUES (v_user_id, 'exam_result',
          'Mock exam completed', 'تم إكمال الاختبار التجريبي',
          'Score: ' || v_score || '%. Your completion certificate is ready.',
          'نتيجتك: ' || v_score || '%. شهادة الإتمام جاهزة.',
          '#result/' || p_attempt_id::text);
  RETURN v_cert_id;
END;
$$;

-- ---------------------------------------------------------------- Public certificate lookup (no auth needed)
-- Used by GET /verify/:token
CREATE OR REPLACE FUNCTION public_certificate(p_token text)
RETURNS TABLE(
  id              uuid,
  user_display    text,
  score_percent   int,
  passed          boolean,
  issued_at       timestamptz,
  revoked         boolean
) LANGUAGE sql STABLE AS $$
  SELECT
    c.id,
    left(u.email, strpos(u.email, '@') - 1) AS user_display,  -- show only the part before @
    c.score_percent,
    c.passed,
    c.issued_at,
    c.revoked_at IS NOT NULL AS revoked
  FROM certificates c
  JOIN users u ON u.id = c.user_id
  WHERE c.token = p_token;
$$;
