// SQL that builds the DEMO question bank from the starter drafts in content/.
// It has the same shape as db/seed/synthetic_bank.sql (50 questions per task,
// 16 case studies of 5 questions, every item through the review gates and the
// publish function) so mock exams can be generated, but the wording comes from
// the starter drafts instead of placeholder text. The drafts are AI-assisted
// and not reviewed by a person: for demonstrations only, never for candidates.
// With 122 distinct drafts the bank repeats each one several times.

import { readFileSync } from 'node:fs';
import { lit } from '../../packages/exam-store/src/psql-store.ts';
import { readXlsxSheets } from '../../packages/api/src/xlsx.ts';

type Row = Record<string, string>;

function sheetRows(file: URL): Record<string, Row[]> {
  const out: Record<string, Row[]> = {};
  for (const sheet of readXlsxSheets(readFileSync(file))) {
    const [head, ...rows] = sheet.rows;
    if (!head) continue;
    out[sheet.name] = rows.filter((r) => r.some((c) => c !== '')).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
  }
  return out;
}

const LETTERS = ['A', 'B', 'C', 'D'];

function questionValues(q: Row): string {
  const correct = new Set(q.correct!.split(/[;,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean));
  const type = q.type === 'multiple' ? 'multiple' : 'single';
  const cells = [lit.text(type), lit.text(q.stem!), lit.text(q.stemAr ?? '')];
  for (const l of LETTERS) {
    cells.push(lit.text(q[`option${l}`]!), String(correct.has(l)), lit.text(q[`rationale${l}`] ?? ''));
    cells.push(lit.text(q[`option${l}Ar`] ?? ''), lit.text(q[`rationale${l}Ar`] ?? ''));
  }
  cells.push(lit.text(q.whyCorrect ?? ''), lit.text(q.mindset ?? ''), lit.text(q.keyConcept ?? ''));
  cells.push(lit.text(q.whyCorrectAr ?? ''), lit.text(q.mindsetAr ?? ''), lit.text(q.keyConceptAr ?? ''));
  return cells.join(', ');
}

export function demoBankSql(root: URL): string {
  const a = sheetRows(new URL('content/starter-drafts.xlsx', root));
  const b = sheetRows(new URL('content/starter-drafts-2.xlsx', root));
  // DOCX-extracted Arabic questions (stemAr present, English stem is a stub)
  const c = sheetRows(new URL('content/starter-drafts-docx.xlsx', root));
  const all = [...(a.Questions ?? []), ...(b.Questions ?? []), ...(c.Questions ?? [])].filter((q) => q.stem && q.optionA && q.correct);
  const cases = b['Case studies'] ?? [];
  const standalone = all.filter((q) => !q.caseKey);
  if (standalone.length === 0 || cases.length === 0) throw new Error('starter drafts are missing or empty');

  const perTask = new Map<string, number>();
  const qRows = standalone.map((q) => {
    const k = perTask.get(q.taskCode!) ?? 0;
    perTask.set(q.taskCode!, k + 1);
    return `(${lit.text(q.taskCode!)}, ${k}, ${questionValues(q)})`;
  });
  const caseRows = cases.map((c, i) => `(${i}, ${lit.text(c.title!)}, ${lit.text(c.scenario!)})`);
  const cqRows: string[] = [];
  cases.forEach((c, i) => {
    all.filter((q) => q.caseKey === c.caseKey).forEach((q, k) => cqRows.push(`(${i}, ${k}, ${questionValues(q)})`));
  });

  const seed = readFileSync(new URL('db/seed/synthetic_bank.sql', root), 'utf8');
  const header = seed.slice(0, seed.indexOf('INSERT INTO case_studies'));   // seed, staff users, active_tasks
  const qCols = 'type text, stem text, stem_ar text, o1 text, c1 boolean, r1 text, o1ar text, r1ar text, o2 text, c2 boolean, r2 text, o2ar text, r2ar text, o3 text, c3 boolean, r3 text, o3ar text, r3ar text, o4 text, c4 boolean, r4 text, o4ar text, r4ar text, why text, mindset text, concept text, why_ar text, mindset_ar text, concept_ar text';

  return `${header}
CREATE TEMP TABLE demo_q (task_code text, k int, ${qCols});
INSERT INTO demo_q VALUES
${qRows.join(',\n')};
CREATE TEMP TABLE demo_case (ci int, title text, scenario text);
INSERT INTO demo_case VALUES
${caseRows.join(',\n')};
CREATE TEMP TABLE demo_cq (ci int, k int, ${qCols});
-- qCols includes Arabic columns from migration 009
INSERT INTO demo_cq VALUES
${cqRows.join(',\n')};

CREATE TEMP TABLE syn_case AS
SELECT gen_random_uuid() AS id, n AS cn, (n - 1) % (SELECT count(*) FROM demo_case)::int AS ci FROM generate_series(1, 16) n;

INSERT INTO case_studies (id, public_code, title, scenario, status, created_by)
SELECT s.id, 'DEMO-CS-' || lpad(s.cn::text, 3, '0'), d.title, d.scenario, 'published', '00000000-0000-4000-8000-000000000001'
FROM syn_case s JOIN demo_case d ON d.ci = s.ci;

-- 50 questions per task (that task's drafts, repeated), plus 5 per case study.
CREATE TEMP TABLE syn AS
SELECT gen_random_uuid() AS qid, gen_random_uuid() AS vid, x.*, random() AS rr1, random() AS rr2, random() AS rr4,
       row_number() OVER () AS n
FROM (
  SELECT at.task_id, NULL::uuid AS case_study_id, NULL::smallint AS case_ordinal, q.*
  FROM active_tasks at JOIN tasks t ON t.id = at.task_id
  CROSS JOIN generate_series(1, 50) g
  JOIN demo_q q ON q.task_code = t.code
               AND q.k = (g - 1) % (SELECT count(*) FROM demo_q c WHERE c.task_code = t.code)::int
  UNION ALL
  SELECT at.task_id, sc.id, kk::smallint, NULL::text, q.k, q.type, q.stem, q.stem_ar, q.o1, q.c1, q.r1, q.o1ar, q.r1ar, q.o2, q.c2, q.r2, q.o2ar, q.r2ar, q.o3, q.c3, q.r3, q.o3ar, q.r3ar, q.o4, q.c4, q.r4, q.o4ar, q.r4ar, q.why, q.mindset, q.concept, q.why_ar, q.mindset_ar, q.concept_ar
  FROM syn_case sc CROSS JOIN generate_series(1, 5) kk
  JOIN active_tasks at ON at.rn = ((sc.cn * 5 + kk) % (SELECT count(*) FROM active_tasks)) + 1
  JOIN demo_cq q ON q.ci = sc.ci AND q.k = (kk - 1) % (SELECT count(*) FROM demo_cq c WHERE c.ci = sc.ci)::int
) x;

INSERT INTO questions (id, public_code)
SELECT qid, 'DEMO-' || lpad(n::text, 5, '0') FROM syn;

INSERT INTO question_versions (id, question_id, version_no, task_id, approach_code, difficulty_code, type_code,
                               is_graphic, case_study_id, case_ordinal, stem, stem_ar, author_id,
                               workflow_state, originality_declared_at)
SELECT vid, qid, 1, task_id,
       CASE WHEN rr1 < 0.4 THEN 'predictive' WHEN rr1 < 0.7 THEN 'agile' ELSE 'hybrid' END,
       CASE WHEN rr2 < 0.25 THEN 'easy' WHEN rr2 < 0.75 THEN 'medium' ELSE 'hard' END,
       type, rr4 < 0.1, case_study_id, case_ordinal, stem, nullif(stem_ar, ''),
       '00000000-0000-4000-8000-000000000001', 'submitted', now()
FROM syn;

INSERT INTO options (question_version_id, ordinal, text, is_correct, rationale, text_ar, rationale_ar)
-- The drafts list the correct option first; rotate the order per question so it varies.
SELECT s.vid, ((o.ordinal - 1 + s.n) % 4)::int + 1, o.text, o.is_correct, o.rationale, nullif(o.text_ar, ''), nullif(o.rationale_ar, '')
FROM syn s CROSS JOIN LATERAL (VALUES (1, s.o1, s.c1, s.r1, s.o1ar, s.r1ar),
                                      (2, s.o2, s.c2, s.r2, s.o2ar, s.r2ar),
                                      (3, s.o3, s.c3, s.r3, s.o3ar, s.r3ar),
                                      (4, s.o4, s.c4, s.r4, s.o4ar, s.r4ar))
     AS o(ordinal, text, is_correct, rationale, text_ar, rationale_ar);

INSERT INTO reviews (question_version_id, reviewer_id, gate, decision, checklist)
SELECT s.vid, '00000000-0000-4000-8000-000000000002', g.gate, 'approved', '{"all": true}'::jsonb
FROM syn s CROSS JOIN (VALUES ('expert_review'), ('language_qa')) g(gate);

UPDATE question_versions SET workflow_state = 'approved' WHERE id IN (SELECT vid FROM syn);

SELECT count(*) AS published
FROM (SELECT publish_question_version(vid, '00000000-0000-4000-8000-000000000003') FROM syn) p;

INSERT INTO explanations (question_version_id, language, why_correct, mindset, key_concept, learning_objective)
SELECT vid, 'en', why, mindset, concept, 'Demo draft: not reviewed' FROM syn;

INSERT INTO explanations (question_version_id, language, why_correct, mindset, key_concept, learning_objective)
SELECT vid, 'ar', why_ar, mindset_ar, concept_ar, 'Demo draft (AR): not reviewed'
FROM syn WHERE why_ar <> '';
`;
}
