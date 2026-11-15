-- Migration 008: shared rate limiting, and support for data export and the audit screen.

-- One row per client and endpoint per minute window. The key is a SHA-256
-- hash, so client addresses are not stored. Shared by every app copy.
CREATE TABLE rate_limits (
  key_hash     text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  hits         integer NOT NULL
);
CREATE INDEX rate_limits_window_idx ON rate_limits (window_start);

-- Counts one request; true when the client is over the limit for this minute.
CREATE FUNCTION rate_limit_hit(p_key_hash text, p_now timestamptz, p_limit integer) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  n integer;
BEGIN
  INSERT INTO rate_limits AS r (key_hash, window_start, hits) VALUES (p_key_hash, p_now, 1)
  ON CONFLICT (key_hash) DO UPDATE
  -- A new window starts after 60 seconds, or if the clock went back (server time corrected).
  SET hits = CASE WHEN r.window_start <= p_now - interval '60 seconds' OR r.window_start > p_now THEN 1 ELSE r.hits + 1 END,
      window_start = CASE WHEN r.window_start <= p_now - interval '60 seconds' OR r.window_start > p_now THEN p_now ELSE r.window_start END
  RETURNING hits INTO n;
  -- Now and then, forget windows that ended long ago.
  IF random() < 0.01 THEN DELETE FROM rate_limits WHERE window_start < p_now - interval '10 minutes'; END IF;
  RETURN n > p_limit;
END $$;

-- Everything stored about one candidate, for a "download my data" request.
-- Secrets (password hash, token hashes, two-factor secrets) are left out.
CREATE FUNCTION user_export(p_user uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'profile', (SELECT jsonb_build_object('id', u.id, 'email', u.email, 'displayName', u.display_name, 'countryCode', u.country_code,
                  'language', u.language, 'explanationLanguage', u.explanation_language, 'examTargetDate', u.exam_target_date,
                  'weeklyStudyHours', u.weekly_study_hours, 'emailVerifiedAt', u.email_verified_at, 'createdAt', u.created_at,
                  'twoFactorEnabled', u.totp_enabled_at IS NOT NULL,
                  'roles', coalesce((SELECT jsonb_agg(r.code ORDER BY r.code) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id), '[]'))
                FROM users u WHERE u.id = p_user),
    'sessions', coalesce((SELECT jsonb_agg(jsonb_build_object('device', s.device_label, 'createdAt', s.created_at, 'expiresAt', s.expires_at,
                  'revokedAt', s.revoked_at) ORDER BY s.created_at) FROM sessions s WHERE s.user_id = p_user), '[]'),
    'practiceAnswers', coalesce((SELECT jsonb_agg(jsonb_build_object('question', q.public_code, 'version', qv.version_no, 'response', pa.response,
                  'correct', pa.is_correct, 'timeSpentMs', pa.time_spent_ms, 'answeredAt', pa.answered_at) ORDER BY pa.answered_at)
                FROM practice_answers pa JOIN question_versions qv ON qv.id = pa.question_version_id JOIN questions q ON q.id = qv.question_id
                WHERE pa.user_id = p_user), '[]'),
    'mockExams', coalesce((SELECT jsonb_agg(jsonb_build_object('id', ea.id, 'state', ea.state, 'startedAt', ea.started_at,
                  'submittedAt', ea.submitted_at, 'result', ea.result) ORDER BY ea.started_at) FROM exam_attempts ea WHERE ea.user_id = p_user), '[]'),
    'questionReports', coalesce((SELECT jsonb_agg(jsonb_build_object('question', q.public_code, 'reason', r.reason, 'comment', r.comment,
                  'status', r.status, 'createdAt', r.created_at) ORDER BY r.created_at)
                FROM question_reports r JOIN question_versions qv ON qv.id = r.question_version_id JOIN questions q ON q.id = qv.question_id
                WHERE r.user_id = p_user), '[]'),
    'access', coalesce((SELECT jsonb_agg(jsonb_build_object('plan', e.plan_code, 'source', e.source, 'startsAt', e.starts_at, 'endsAt', e.ends_at)
                ORDER BY e.starts_at) FROM entitlements e WHERE e.user_id = p_user), '[]'));
$$;

-- The audit trail, newest first, for administrators.
CREATE FUNCTION audit_page(p_action_prefix text, p_actor_email text, p_before bigint, p_limit integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(x ORDER BY (x->>'id')::bigint DESC), '[]'::jsonb) FROM (
    SELECT jsonb_build_object('id', a.id, 'at', a.at, 'actor', u.email, 'action', a.action, 'entityType', a.entity_type,
             'entityId', a.entity_id, 'before', a.before, 'after', a.after) AS x
    FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
    WHERE (p_action_prefix IS NULL OR a.action LIKE p_action_prefix || '%')
      AND (p_actor_email IS NULL OR u.email = p_actor_email::citext)
      AND (p_before IS NULL OR a.id < p_before)
    ORDER BY a.id DESC
    LIMIT p_limit) t;
$$;
