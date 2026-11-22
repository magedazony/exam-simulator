-- Recorded course: modules, lessons (video + slides), progress, completion
-- certificate, and products (simulator, course, both) on the existing plans.
--
-- Access: a plan now says what it includes. The existing passes include the
-- simulator only. New passes: the course alone and the course with the
-- simulator. Passes of one product no longer queue behind passes of another.

ALTER TABLE plans ADD COLUMN IF NOT EXISTS includes text[] NOT NULL DEFAULT '{simulator}';
ALTER TABLE plans ADD CONSTRAINT plans_includes_check CHECK (includes <@ ARRAY['simulator', 'course']::text[] AND cardinality(includes) >= 1);

INSERT INTO plans (code, name, kind, duration_days, sort, includes) VALUES
  ('course90', 'Recorded course, 90 days', 'pass', 90, 3, '{course}'),
  ('bundle90', 'Course and simulator, 90 days', 'pass', 90, 4, '{simulator,course}')
ON CONFLICT (code) DO NOTHING;

-- Access to one product at a time.
CREATE OR REPLACE FUNCTION product_ends_at(p_user uuid, p_product text, p_now timestamptz) RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT max(e.ends_at) FROM entitlements e JOIN plans p ON p.code = e.plan_code
  WHERE e.user_id = p_user AND e.ends_at > p_now AND p_product = ANY (p.includes);
$$;

CREATE OR REPLACE FUNCTION has_product(p_user uuid, p_product text, p_now timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM entitlements e JOIN plans p ON p.code = e.plan_code
                 WHERE e.user_id = p_user AND e.starts_at <= p_now AND e.ends_at > p_now AND p_product = ANY (p.includes));
$$;

-- 'entitled' keeps its meaning: full simulator access. The course has its own fields.
CREATE OR REPLACE FUNCTION user_access(p_user uuid, p_now timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'entitled', e.id IS NOT NULL,
    'planCode', coalesce(e.plan_code, 'free'),
    'endsAt', product_ends_at(p_user, 'simulator', p_now),
    'course', has_product(p_user, 'course', p_now),
    'courseEndsAt', product_ends_at(p_user, 'course', p_now),
    'practiceUsedToday', (SELECT count(*) FROM practice_answers
                          WHERE user_id = p_user AND answered_at >= date_trunc('day', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (SELECT en.* FROM entitlements en JOIN plans p ON p.code = en.plan_code
                     WHERE en.user_id = p_user AND en.starts_at <= p_now AND en.ends_at > p_now AND 'simulator' = ANY (p.includes)
                     ORDER BY en.ends_at DESC LIMIT 1) e ON true;
$$;

-- A pass starts when the current pass for the same product ends.
CREATE OR REPLACE FUNCTION grant_entitlement(p_user uuid, p_plan text, p_source text, p_ref text, p_days integer,
                                  p_now timestamptz, p_actor uuid, p_note text)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  start_at timestamptz;
  e_id uuid;
  inc text[];
BEGIN
  SELECT includes INTO inc FROM plans WHERE code = p_plan AND kind = 'pass';
  IF inc IS NULL THEN RAISE EXCEPTION 'E_UNKNOWN_PLAN'; END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user AND status = 'active') THEN RAISE EXCEPTION 'E_NOT_FOUND'; END IF;
  PERFORM 1 FROM users WHERE id = p_user FOR UPDATE;
  SELECT greatest(p_now, coalesce(max(e.ends_at), p_now)) INTO start_at
  FROM entitlements e JOIN plans p ON p.code = e.plan_code
  WHERE e.user_id = p_user AND p.includes && inc;
  INSERT INTO entitlements (user_id, plan_code, source, external_ref, starts_at, ends_at, granted_by, note)
  VALUES (p_user, p_plan, p_source, p_ref, start_at, start_at + make_interval(days => p_days), p_actor, p_note)
  ON CONFLICT (source, external_ref) DO NOTHING
  RETURNING id INTO e_id;
  IF e_id IS NULL THEN RETURN false; END IF;
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, after)
  VALUES (coalesce(p_actor, p_user), 'access.grant', 'entitlement', e_id::text,
          jsonb_build_object('user', p_user, 'plan', p_plan, 'source', p_source, 'days', p_days));
  RETURN true;
END $$;

-- ------------------------------------------------------------------ content

CREATE TABLE course_modules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ordinal    integer NOT NULL DEFAULT 0,
  title      text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  title_ar   text,
  summary    text,
  summary_ar text,
  status     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE course_files (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename   text NOT NULL,
  mime       text NOT NULL,
  size_bytes integer NOT NULL,
  bytes      bytea NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE course_lessons (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id        uuid NOT NULL REFERENCES course_modules(id) ON DELETE RESTRICT,
  ordinal          integer NOT NULL DEFAULT 0,
  title            text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  title_ar         text,
  summary          text,
  summary_ar       text,
  -- youtube: video id; bunny: video id in the configured library; url: a direct video file URL; none: slides only
  video_provider   text NOT NULL DEFAULT 'none' CHECK (video_provider IN ('youtube', 'bunny', 'url', 'none')),
  video_ref        text,
  duration_seconds integer NOT NULL DEFAULT 0 CHECK (duration_seconds BETWEEN 0 AND 36000),
  is_free          boolean NOT NULL DEFAULT false,
  task_codes       text[] NOT NULL DEFAULT '{}',
  slides_file_id   uuid REFERENCES course_files(id) ON DELETE SET NULL,
  slides_url       text,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX course_lessons_module_idx ON course_lessons (module_id, ordinal);

CREATE TABLE lesson_progress (
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id        uuid NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
  position_seconds integer NOT NULL DEFAULT 0,
  -- Seconds actually played, never more than the lesson's length. Used for the certificate's hours.
  watched_seconds  integer NOT NULL DEFAULT 0,
  completed_at     timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, lesson_id)
);

CREATE TABLE course_certificates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  token      text NOT NULL UNIQUE,
  full_name  text NOT NULL,
  hours      numeric(6, 1) NOT NULL,
  lessons    integer NOT NULL,
  issued_at  timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ views

-- The course as a learner sees it: published modules and lessons, progress, and what is locked.
CREATE OR REPLACE FUNCTION course_outline(p_user uuid, p_now timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH acc AS (SELECT has_product(p_user, 'course', p_now) AS ok),
  ls AS (
    SELECT l.*, lp.position_seconds, lp.watched_seconds, lp.completed_at
    FROM course_lessons l JOIN course_modules m ON m.id = l.module_id
    LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = p_user
    WHERE l.status = 'published' AND m.status = 'published')
  SELECT jsonb_build_object(
    'access', (SELECT ok FROM acc),
    'accessEndsAt', product_ends_at(p_user, 'course', p_now),
    'lessons', (SELECT count(*) FROM ls),
    'completed', (SELECT count(*) FROM ls WHERE completed_at IS NOT NULL),
    'totalSeconds', (SELECT coalesce(sum(duration_seconds), 0) FROM ls),
    'watchedSeconds', (SELECT coalesce(sum(least(watched_seconds, duration_seconds)), 0) FROM ls),
    'certificate', (SELECT jsonb_build_object('token', c.token, 'issuedAt', c.issued_at, 'hours', c.hours) FROM course_certificates c WHERE c.user_id = p_user),
    'resume', (SELECT jsonb_build_object('lessonId', id, 'title', title) FROM ls WHERE completed_at IS NULL AND position_seconds > 0 ORDER BY (SELECT updated_at FROM lesson_progress WHERE user_id = p_user AND lesson_id = ls.id) DESC LIMIT 1),
    'modules', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', m.id, 'title', m.title, 'titleAr', coalesce(m.title_ar, ''), 'summary', coalesce(m.summary, ''), 'summaryAr', coalesce(m.summary_ar, ''),
        'lessons', coalesce((SELECT jsonb_agg(jsonb_build_object(
            'id', ls.id, 'title', ls.title, 'titleAr', coalesce(ls.title_ar, ''), 'durationSeconds', ls.duration_seconds,
            'isFree', ls.is_free, 'locked', NOT (ls.is_free OR (SELECT ok FROM acc)), 'taskCodes', to_jsonb(ls.task_codes),
            'hasVideo', ls.video_provider <> 'none', 'hasSlides', ls.slides_file_id IS NOT NULL OR coalesce(ls.slides_url, '') <> '',
            'positionSeconds', coalesce(ls.position_seconds, 0), 'watchedSeconds', coalesce(ls.watched_seconds, 0),
            'completed', ls.completed_at IS NOT NULL) ORDER BY ls.ordinal, ls.created_at)
          FROM ls WHERE ls.module_id = m.id), '[]'::jsonb)) ORDER BY m.ordinal, m.created_at)
      FROM course_modules m WHERE m.status = 'published'
        AND EXISTS (SELECT 1 FROM ls WHERE ls.module_id = m.id)), '[]'::jsonb));
$$;

-- Saves progress. Watched time grows by at most the time since the last save
-- (plus a margin), and never beyond the lesson's length. A lesson is complete
-- once 80% of it was watched, or at once for a lesson without video.
CREATE OR REPLACE FUNCTION save_lesson_progress(p_user uuid, p_lesson uuid, p_position integer, p_add integer, p_complete boolean)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE l course_lessons%ROWTYPE; lp lesson_progress%ROWTYPE; add_s integer;
BEGIN
  SELECT * INTO l FROM course_lessons WHERE id = p_lesson AND status = 'published';
  IF NOT FOUND THEN RAISE EXCEPTION 'E_NOT_FOUND'; END IF;
  INSERT INTO lesson_progress (user_id, lesson_id) VALUES (p_user, p_lesson) ON CONFLICT DO NOTHING;
  SELECT * INTO lp FROM lesson_progress WHERE user_id = p_user AND lesson_id = p_lesson FOR UPDATE;
  add_s := least(greatest(coalesce(p_add, 0), 0), greatest(5, extract(epoch FROM now() - lp.updated_at)::integer + 5));
  UPDATE lesson_progress SET
    position_seconds = least(greatest(coalesce(p_position, 0), 0), greatest(l.duration_seconds, 0)),
    watched_seconds = least(watched_seconds + add_s, l.duration_seconds),
    completed_at = coalesce(completed_at, CASE
      WHEN l.video_provider = 'none' AND p_complete THEN now()
      WHEN l.duration_seconds > 0 AND least(watched_seconds + add_s, l.duration_seconds) >= 0.8 * l.duration_seconds THEN now()
      ELSE NULL END),
    updated_at = now()
  WHERE user_id = p_user AND lesson_id = p_lesson
  RETURNING * INTO lp;
  RETURN jsonb_build_object('positionSeconds', lp.position_seconds, 'watchedSeconds', lp.watched_seconds, 'completed', lp.completed_at IS NOT NULL);
END $$;

-- Issues the completion certificate once every published lesson is complete.
CREATE OR REPLACE FUNCTION issue_course_certificate(p_user uuid, p_name text, p_token text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE total integer; done integer; secs bigint; c course_certificates%ROWTYPE;
BEGIN
  SELECT * INTO c FROM course_certificates WHERE user_id = p_user;
  IF FOUND THEN RETURN jsonb_build_object('token', c.token, 'hours', c.hours, 'issuedAt', c.issued_at, 'fullName', c.full_name, 'lessons', c.lessons); END IF;
  SELECT count(*), count(lp.completed_at), coalesce(sum(least(lp.watched_seconds, l.duration_seconds)), 0)
  INTO total, done, secs
  FROM course_lessons l JOIN course_modules m ON m.id = l.module_id
  LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = p_user
  WHERE l.status = 'published' AND m.status = 'published';
  IF total = 0 OR done < total THEN RAISE EXCEPTION 'E_NOT_COMPLETE'; END IF;
  INSERT INTO course_certificates (user_id, token, full_name, hours, lessons)
  VALUES (p_user, p_token, p_name, round(secs / 3600.0, 1), total) RETURNING * INTO c;
  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (p_user, 'course.certificate', 'course_certificate', c.id::text);
  RETURN jsonb_build_object('token', c.token, 'hours', c.hours, 'issuedAt', c.issued_at, 'fullName', c.full_name, 'lessons', c.lessons);
END $$;

CREATE OR REPLACE FUNCTION plans_json(p_region text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'code', p.code, 'name', p.name, 'kind', p.kind, 'durationDays', p.duration_days, 'includes', to_jsonb(p.includes),
           'price', CASE WHEN pp.plan_code IS NULL THEN NULL
                         ELSE jsonb_build_object('currency', pp.currency, 'amountMinor', pp.amount_minor,
                                                 'storeProductId', pp.store_product_id) END) ORDER BY p.sort), '[]'::jsonb)
  FROM plans p LEFT JOIN plan_prices pp ON pp.plan_code = p.code AND pp.region = p_region
  WHERE p.active;
$$;

CREATE OR REPLACE FUNCTION admin_plans_json() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'code', p.code, 'name', p.name, 'kind', p.kind, 'durationDays', p.duration_days, 'active', p.active, 'includes', to_jsonb(p.includes),
           'prices', coalesce((SELECT jsonb_agg(jsonb_build_object('region', x.region, 'currency', x.currency,
                                 'amountMinor', x.amount_minor, 'storeProductId', x.store_product_id) ORDER BY x.region)
                               FROM plan_prices x WHERE x.plan_code = p.code), '[]'::jsonb)) ORDER BY p.sort), '[]'::jsonb)
  FROM plans p;
$$;

-- Everything for the admin course editor, drafts included.
CREATE OR REPLACE FUNCTION admin_course() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id, 'ordinal', m.ordinal, 'title', m.title, 'titleAr', coalesce(m.title_ar, ''), 'summary', coalesce(m.summary, ''),
    'summaryAr', coalesce(m.summary_ar, ''), 'status', m.status,
    'lessons', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', l.id, 'moduleId', l.module_id, 'ordinal', l.ordinal, 'title', l.title, 'titleAr', coalesce(l.title_ar, ''),
        'summary', coalesce(l.summary, ''), 'summaryAr', coalesce(l.summary_ar, ''), 'videoProvider', l.video_provider,
        'videoRef', coalesce(l.video_ref, ''), 'durationSeconds', l.duration_seconds, 'isFree', l.is_free,
        'taskCodes', to_jsonb(l.task_codes), 'slidesUrl', coalesce(l.slides_url, ''), 'status', l.status,
        'slides', (SELECT jsonb_build_object('id', f.id, 'filename', f.filename, 'sizeBytes', f.size_bytes) FROM course_files f WHERE f.id = l.slides_file_id),
        'learners', (SELECT count(*) FROM lesson_progress lp WHERE lp.lesson_id = l.id),
        'completions', (SELECT count(*) FROM lesson_progress lp WHERE lp.lesson_id = l.id AND lp.completed_at IS NOT NULL)
      ) ORDER BY l.ordinal, l.created_at) FROM course_lessons l WHERE l.module_id = m.id), '[]'::jsonb)
  ) ORDER BY m.ordinal, m.created_at), '[]'::jsonb)
  FROM course_modules m;
$$;
