-- Increment 22: Bookmarks, candidate notes, enhanced analytics
-- Covers master-prompt sections 25 (notes), 28 (analytics improvements)

-- ---------------------------------------------------------------- bookmarks

CREATE TABLE question_bookmarks (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, question_id)
);
CREATE INDEX bookmarks_user_idx ON question_bookmarks (user_id, created_at DESC);

-- ---------------------------------------------------------------- candidate notes

CREATE TABLE question_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  content     text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 2000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, question_id)  -- one note per (user, question)
);
CREATE INDEX notes_user_idx ON question_notes (user_id, updated_at DESC);

-- ---------------------------------------------------------------- analytics: per-domain breakdown

CREATE OR REPLACE FUNCTION analytics_domain_breakdown(p_user uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'domainCode', d.code, 'domainName', d.name,
      'answered', coalesce(agg.answered, 0),
      'correct',  coalesce(agg.correct, 0),
      'accuracy', CASE WHEN coalesce(agg.answered, 0) = 0 THEN NULL
                       ELSE round(100.0 * agg.correct / agg.answered, 1) END,
      'masteryScore', coalesce(
        (SELECT round(avg(tm.weighted_score) * 100, 1)
         FROM task_mastery tm JOIN tasks t2 ON t2.id = tm.task_id
         WHERE tm.user_id = p_user AND t2.domain_id = d.id), 0
      )
    ) ORDER BY d.ordinal
  ), '[]'::jsonb)
  FROM domains d
  JOIN exam_blueprints bp ON bp.id = d.blueprint_id AND bp.status = 'active'
  LEFT JOIN (
    SELECT t.domain_id,
           count(*) AS answered,
           count(*) FILTER (WHERE ev.is_correct) AS correct
    FROM user_answer_events(p_user) ev
    JOIN question_versions qv ON qv.id = ev.question_version_id
    JOIN tasks t ON t.id = qv.task_id
    GROUP BY t.domain_id
  ) agg ON agg.domain_id = d.id;
$$;

-- ---------------------------------------------------------------- analytics: difficulty breakdown

CREATE OR REPLACE FUNCTION analytics_difficulty_breakdown(p_user uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'difficulty', dl.code,
      'answered', coalesce(agg.answered, 0),
      'correct',  coalesce(agg.correct, 0),
      'accuracy', CASE WHEN coalesce(agg.answered, 0) = 0 THEN NULL
                       ELSE round(100.0 * agg.correct / agg.answered, 1) END
    ) ORDER BY dl.ordinal
  ), '[]'::jsonb)
  FROM difficulty_levels dl
  LEFT JOIN (
    SELECT qv.difficulty_code,
           count(*) AS answered,
           count(*) FILTER (WHERE ev.is_correct) AS correct
    FROM user_answer_events(p_user) ev
    JOIN question_versions qv ON qv.id = ev.question_version_id
    GROUP BY qv.difficulty_code
  ) agg ON agg.difficulty_code = dl.code;
$$;

-- ---------------------------------------------------------------- bookmarked questions

CREATE OR REPLACE FUNCTION bookmarked_questions(p_user uuid, p_limit integer, p_after timestamptz)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'questionId', q.id,
      'publicCode', q.public_code,
      'taskCode', t.code,
      'stem', qv.stem,
      'stemAr', qv.stem_ar,
      'bookmarkedAt', b.created_at,
      'hasNote', (EXISTS (SELECT 1 FROM question_notes n WHERE n.user_id = p_user AND n.question_id = q.id))
    ) ORDER BY b.created_at DESC
  ), '[]'::jsonb)
  FROM question_bookmarks b
  JOIN questions q ON q.id = b.question_id
  JOIN question_versions qv ON qv.question_id = q.id AND qv.workflow_state = 'published'
  JOIN tasks t ON t.id = qv.task_id
  WHERE b.user_id = p_user
    AND (p_after IS NULL OR b.created_at < p_after)
  LIMIT p_limit;
$$;
