-- Migration 016: measured question difficulty for GET /admin/question-difficulty.
-- Computed from stored answers (finished mock exams and answered practice items),
-- so nothing has to be kept in step by triggers. The author's difficulty label on
-- question_versions is never changed here.
-- No BEGIN/COMMIT here: scripts/migrate.ts wraps every file in one transaction.

CREATE OR REPLACE VIEW question_difficulty AS
WITH ev AS (
  SELECT aq.question_id, aq.question_version_id, a.is_correct
  FROM answers a
  JOIN attempt_questions aq ON aq.id = a.attempt_question_id
  JOIN exam_attempts ea ON ea.id = aq.attempt_id
  WHERE ea.result IS NOT NULL AND a.is_correct IS NOT NULL AND jsonb_array_length(a.response) > 0
  UNION ALL
  SELECT pi.question_id, pi.question_version_id, pi.is_correct
  FROM practice_items pi
  WHERE pi.answered_at IS NOT NULL AND pi.is_correct IS NOT NULL
)
SELECT ev.question_id,
       q.public_code,
       (SELECT v.id FROM question_versions v WHERE v.question_id = ev.question_id
         ORDER BY v.version_no DESC LIMIT 1)                       AS latest_version_id,
       count(*)::int                                               AS total_attempts,
       count(*) FILTER (WHERE ev.is_correct)::int                  AS correct_attempts,
       round(1 - count(*) FILTER (WHERE ev.is_correct)::numeric / count(*), 3) AS difficulty_score
FROM ev
JOIN questions q ON q.id = ev.question_id
GROUP BY ev.question_id, q.public_code;
