-- Migration 020: every question's latest version, for the Excel export.
-- No BEGIN/COMMIT here: scripts/migrate.ts wraps every file in one transaction.
CREATE OR REPLACE FUNCTION admin_export_questions() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(admin_question_json(l.id) ORDER BY l.public_code), '[]'::jsonb)
  FROM (
    SELECT DISTINCT ON (q.id) v.id, q.public_code
    FROM questions q JOIN question_versions v ON v.question_id = q.id
    WHERE q.status <> 'archived'
    ORDER BY q.id, v.version_no DESC) l;
$$;
