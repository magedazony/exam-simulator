// SQL that replaces the synthetic test bank's placeholder text with the
// original sample questions in store/screenshot-data, so demos and store
// screenshots show realistic wording. For demo databases only: it rewrites
// published content, which the application itself never allows.

import { readFileSync } from 'node:fs';
import { lit } from '../../packages/exam-store/src/psql-store.ts';

type Sample = { stem: string; options: Array<[string, boolean, string]>; why: string; mindset: string };

/** `prefix` is `SET session_replication_role = replica;` for psql, or the LOCAL form inside one multi-statement call. */
export function sampleContentSql(root: URL, prefix: string): string {
  const samples = JSON.parse(readFileSync(new URL('store/screenshot-data/sample-questions.json', root), 'utf8')) as {
    questions: Sample[]; multiple: Sample; caseQuestions: Sample[]; cases: Array<{ title: string; scenario: string }>;
  };
  const n = samples.questions.length;
  // Single-choice versions cycle through the single samples; multiple-response versions get the multiple sample.
  const ranked = (type: string) => `WITH v AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS i FROM question_versions WHERE type_code = '${type}')`;
  const fill = (filter: string, q: Sample, type: string) => {
    let out = `
  ${ranked(type)} UPDATE question_versions qv SET stem = ${lit.text(q.stem)} FROM v WHERE v.id = qv.id AND ${filter};
  ${ranked(type)} UPDATE explanations e SET why_correct = ${lit.text(q.why)}, mindset = ${lit.text(q.mindset)} FROM v WHERE v.id = e.question_version_id AND ${filter};`;
    q.options.forEach(([text, correct, why], o) => {
      out += `
  ${ranked(type)} UPDATE options op SET text = ${lit.text(text)}, is_correct = ${correct}, rationale = ${lit.text(why)}
    FROM v WHERE v.id = op.question_version_id AND ${filter} AND op.ordinal = ${o + 1};`;
    });
    return out;
  };
  let sql = prefix;
  samples.questions.forEach((q, k) => { sql += fill(`v.i % ${n} = ${k}`, q, 'single'); });
  sql += fill('true', samples.multiple, 'multiple');
  // Questions inside case studies get a question about their own scenario.
  samples.caseQuestions.forEach((q, k) => {
    const inCase = `qv.case_study_id IN (SELECT id FROM (SELECT id, row_number() OVER (ORDER BY id) - 1 AS i FROM case_studies) c WHERE c.i % ${samples.cases.length} = ${k})`;
    sql += `
  UPDATE question_versions qv SET stem = ${lit.text(q.stem)} WHERE ${inCase};
  UPDATE explanations e SET why_correct = ${lit.text(q.why)}, mindset = ${lit.text(q.mindset)} FROM question_versions qv WHERE qv.id = e.question_version_id AND ${inCase};`;
    q.options.forEach(([text, correct, why], o) => {
      sql += `
  UPDATE options op SET text = ${lit.text(text)}, is_correct = ${correct}, rationale = ${lit.text(why)}
    FROM question_versions qv WHERE qv.id = op.question_version_id AND ${inCase} AND op.ordinal = ${o + 1} AND qv.type_code = 'single';`;
    });
  });
  samples.cases.forEach((c, k) => {
    sql += `
  WITH v AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS i FROM case_studies)
  UPDATE case_studies cs SET title = ${lit.text(c.title)}, scenario = ${lit.text(c.scenario)} FROM v WHERE v.id = cs.id AND v.i % ${samples.cases.length} = ${k};`;
  });
  return sql;
}
