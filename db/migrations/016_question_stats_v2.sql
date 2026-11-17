-- Migration 016: Extend question_stats with question-level aggregation
-- Adds columns expected by GET /admin/question-difficulty:
--   question_id, latest_version_id, total_attempts, correct_attempts, difficulty_score

BEGIN;

-- Add new columns if they do not already exist
ALTER TABLE question_stats
  ADD COLUMN IF NOT EXISTS question_id      uuid REFERENCES questions(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS latest_version_id uuid REFERENCES question_versions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS total_attempts    int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS correct_attempts  int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS difficulty_score  numeric(5,3) NOT NULL DEFAULT 0;

-- Backfill question_id & latest_version_id from existing rows
UPDATE question_stats qs
   SET question_id       = qv.question_id,
       latest_version_id = qv.id,
       total_attempts    = qs.times_seen,
       correct_attempts  = qs.times_correct,
       difficulty_score  = CASE WHEN qs.times_seen = 0 THEN 0
                                ELSE ROUND(1 - qs.times_correct::numeric / qs.times_seen, 3)
                           END
  FROM question_versions qv
 WHERE qv.id = qs.question_version_id;

-- Create unique index on question_id for the admin query (if not present)
CREATE UNIQUE INDEX IF NOT EXISTS question_stats_question_id_idx ON question_stats(question_id)
  WHERE question_id IS NOT NULL;

-- Replace the on_answer_saved trigger to also update new columns
CREATE OR REPLACE FUNCTION on_answer_saved() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_question_id uuid;
  v_pct int;
  v_label text;
BEGIN
  -- Resolve question_id from version
  SELECT question_id INTO v_question_id FROM question_versions WHERE id = NEW.question_version_id;

  -- Upsert by question_version_id (old PK) and sync new columns
  INSERT INTO question_stats(
    question_version_id, question_id, latest_version_id,
    times_seen, times_correct, avg_time_ms,
    total_attempts, correct_attempts, difficulty_score, updated_at
  ) VALUES (
    NEW.question_version_id, v_question_id, NEW.question_version_id,
    1, CASE WHEN NEW.is_correct THEN 1 ELSE 0 END, COALESCE(NEW.time_spent_ms, 0),
    1, CASE WHEN NEW.is_correct THEN 1 ELSE 0 END,
    CASE WHEN NEW.is_correct THEN 0 ELSE 1 END, -- difficulty = 1 wrong / 1 attempt
    now()
  )
  ON CONFLICT (question_version_id) DO UPDATE
     SET times_seen       = question_stats.times_seen + 1,
         times_correct    = question_stats.times_correct + (CASE WHEN NEW.is_correct THEN 1 ELSE 0 END),
         avg_time_ms      = (question_stats.avg_time_ms * question_stats.times_seen + COALESCE(NEW.time_spent_ms, 0))
                            / (question_stats.times_seen + 1),
         total_attempts   = question_stats.total_attempts + 1,
         correct_attempts = question_stats.correct_attempts + (CASE WHEN NEW.is_correct THEN 1 ELSE 0 END),
         difficulty_score = CASE WHEN (question_stats.total_attempts + 1) = 0 THEN 0
                                 ELSE ROUND(1.0 - (question_stats.correct_attempts + (CASE WHEN NEW.is_correct THEN 1 ELSE 0 END))::numeric
                                                 / (question_stats.total_attempts + 1), 3)
                            END,
         latest_version_id = NEW.question_version_id,
         updated_at        = now();

  -- Recalculate difficulty label on question_versions
  SELECT
    CASE WHEN times_seen = 0 THEN NULL
         ELSE ROUND(100.0 * times_correct / times_seen)::int
    END INTO v_pct
  FROM question_stats WHERE question_version_id = NEW.question_version_id;

  IF v_pct IS NULL OR v_pct >= 70 THEN v_label := 'easy';
  ELSIF v_pct >= 40 THEN v_label := 'medium';
  ELSE v_label := 'hard';
  END IF;

  UPDATE question_versions
     SET difficulty = v_label
   WHERE id = NEW.question_version_id AND difficulty IS DISTINCT FROM v_label;

  RETURN NEW;
END;
$$;

COMMIT;
