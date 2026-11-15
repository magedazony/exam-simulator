-- TEST DATA ONLY. Builds a synthetic question bank for integration tests:
-- metadata and placeholder text, not exam content. Every item goes through
-- the same review gates and publish function as real content.
-- Requires an active blueprint (see scripts/pg-temp.sh).

SELECT setseed(0.42);

INSERT INTO users (id, email, password_hash) VALUES
  ('00000000-0000-4000-8000-000000000001', 'author@example.test', 'x'),
  ('00000000-0000-4000-8000-000000000002', 'reviewer@example.test', 'x'),
  ('00000000-0000-4000-8000-000000000003', 'admin@example.test', 'x'),
  ('00000000-0000-4000-8000-000000000004', 'candidate@example.test', 'x'),
  ('00000000-0000-4000-8000-000000000005', 'other-candidate@example.test', 'x');
INSERT INTO user_roles (user_id, role_id) VALUES
  ('00000000-0000-4000-8000-000000000001', 2),
  ('00000000-0000-4000-8000-000000000002', 3),
  ('00000000-0000-4000-8000-000000000003', 4),
  ('00000000-0000-4000-8000-000000000004', 1),
  ('00000000-0000-4000-8000-000000000005', 1);

CREATE TEMP TABLE active_tasks AS
SELECT t.id AS task_id, row_number() OVER (ORDER BY d.ordinal, t.ordinal) AS rn
FROM tasks t JOIN domains d ON d.id = t.domain_id
JOIN exam_blueprints b ON b.id = d.blueprint_id AND b.status = 'active';

INSERT INTO case_studies (id, public_code, title, scenario, status, created_by)
SELECT gen_random_uuid(), 'SYN-CS-' || lpad(n::text, 3, '0'), 'Synthetic case ' || n,
       'Synthetic scenario ' || n, 'published', '00000000-0000-4000-8000-000000000001'
FROM generate_series(1, 16) n;

-- 50 independent questions per task, plus 5 questions for each case study.
CREATE TEMP TABLE syn AS
SELECT gen_random_uuid() AS qid, gen_random_uuid() AS vid, x.task_id, x.case_study_id, x.case_ordinal,
       random() AS r1, random() AS r2, random() AS r3, random() AS r4,
       row_number() OVER () AS n
FROM (
  SELECT at.task_id, NULL::uuid AS case_study_id, NULL::smallint AS case_ordinal
  FROM active_tasks at CROSS JOIN generate_series(1, 50)
  UNION ALL
  SELECT at.task_id, cs.id, k::smallint
  FROM (SELECT id, row_number() OVER (ORDER BY public_code) AS cn FROM case_studies) cs
  CROSS JOIN generate_series(1, 5) k
  JOIN active_tasks at ON at.rn = ((cs.cn * 5 + k) % (SELECT count(*) FROM active_tasks)) + 1
) x;

INSERT INTO questions (id, public_code)
SELECT qid, 'SYN-' || lpad(n::text, 5, '0') FROM syn;

INSERT INTO question_versions (id, question_id, version_no, task_id, approach_code, difficulty_code, type_code,
                               is_graphic, case_study_id, case_ordinal, stem, author_id,
                               workflow_state, originality_declared_at)
SELECT vid, qid, 1, task_id,
       CASE WHEN r1 < 0.4 THEN 'predictive' WHEN r1 < 0.7 THEN 'agile' ELSE 'hybrid' END,
       CASE WHEN r2 < 0.25 THEN 'easy' WHEN r2 < 0.75 THEN 'medium' ELSE 'hard' END,
       CASE WHEN r3 < 0.15 THEN 'multiple' ELSE 'single' END,
       r4 < 0.1, case_study_id, case_ordinal, 'Synthetic item ' || n,
       '00000000-0000-4000-8000-000000000001', 'submitted', now()
FROM syn;

-- Option 1 is correct for single choice; options 1 and 3 for multiple response.
INSERT INTO options (question_version_id, ordinal, text, is_correct, rationale)
SELECT s.vid, o, 'Option ' || chr(64 + o),
       CASE WHEN s.r3 < 0.15 THEN o IN (1, 3) ELSE o = 1 END, 'Rationale ' || chr(64 + o)
FROM syn s CROSS JOIN generate_series(1, 4) o;

INSERT INTO reviews (question_version_id, reviewer_id, gate, decision, checklist)
SELECT s.vid, '00000000-0000-4000-8000-000000000002', g.gate, 'approved', '{"all": true}'::jsonb
FROM syn s CROSS JOIN (VALUES ('expert_review'), ('language_qa')) g(gate);

UPDATE question_versions SET workflow_state = 'approved' WHERE id IN (SELECT vid FROM syn);

SELECT count(*) AS published
FROM (SELECT publish_question_version(vid, '00000000-0000-4000-8000-000000000003') FROM syn) p;

INSERT INTO explanations (question_version_id, language, why_correct, mindset, key_concept, learning_objective)
SELECT vid, 'en', 'Synthetic explanation ' || n, 'Synthetic mindset note', 'Synthetic concept', 'Synthetic objective'
FROM syn;
