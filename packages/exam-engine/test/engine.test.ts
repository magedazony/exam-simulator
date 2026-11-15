import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  domainQuotas,
  generateExam,
  isScorable,
  matchesRule,
  scoreAttempt,
  scoreQuestion,
  toCandidateQuestion,
  validateBlueprint,
  validateExam,
} from '../src/index.ts';
import type { ExamForm, Question } from '../src/index.ts';
import { buildPool, loadBlueprint } from './helpers.ts';

const bp = loadBlueprint();
const pool = buildPool(bp, { perTask: 50, caseSets: 16 });

function mustGenerate(seed: number, p = pool): ExamForm {
  const r = generateExam(bp, p, { seed });
  assert.ok(r.ok, r.ok ? '' : r.violations.join('; '));
  return r.form;
}

describe('blueprint (July 2026 outline)', () => {
  it('is internally consistent', () => {
    assert.deepEqual(validateBlueprint(bp), []);
  });

  it('has 3 domains and 26 tasks split 8 / 10 / 8', () => {
    assert.deepEqual(bp.domains.map((d) => d.tasks.length), [8, 10, 8]);
  });

  it('turns 33 / 41 / 26 percent into 59 / 74 / 47 questions', () => {
    const q = domainQuotas(bp);
    assert.deepEqual([q.get('PEOPLE'), q.get('PROCESS'), q.get('BUSINESS')], [59, 74, 47]);
  });

  it('rejects weights that do not sum to 100', () => {
    const broken = structuredClone(bp);
    broken.domains[0]!.weightPct = 30;
    assert.ok(validateBlueprint(broken).some((e) => e.includes('sum to')));
  });

  it('rejects sections that do not add up to the exam length', () => {
    const broken = structuredClone(bp);
    broken.sections[1]!.questionCount = 70;
    assert.ok(validateBlueprint(broken).some((e) => e.includes('sections hold')));
  });
});

describe('exam generation', () => {
  it('produces 1,000 exams that all pass independent validation (acceptance A1 to A3)', () => {
    const quotas = domainQuotas(bp);
    for (let seed = 1; seed <= 1000; seed++) {
      const form = mustGenerate(seed);
      assert.deepEqual(validateExam(bp, form, pool), []);
      assert.equal(form.items.length, 180);
      assert.equal(new Set(form.items.map((i) => i.questionId)).size, 180);

      const qs = form.items.map((i) => pool.get(i.questionId)!);
      for (const d of bp.domains) {
        const have = qs.filter((q) => q.domainId === d.id).length;
        assert.ok(Math.abs(have - quotas.get(d.id)!) <= 1, `domain ${d.id}: ${have}`);
      }
      const predictive = (qs.filter((q) => q.approach === 'predictive').length / 180) * 100;
      assert.ok(Math.abs(predictive - 40) <= 3, `predictive share ${predictive}`);
    }
  });

  it('opens with a case-study section made of whole sets', () => {
    const form = mustGenerate(7);
    const first = form.items.slice(0, 20).map((i) => pool.get(i.questionId)!);
    assert.ok(first.every((q) => q.caseSetId));
    assert.ok(form.items.slice(20).every((i) => !pool.get(i.questionId)!.caseSetId));
    const sets = new Map<string, number>();
    for (const q of first) sets.set(q.caseSetId!, (sets.get(q.caseSetId!) ?? 0) + 1);
    assert.ok([...sets.values()].every((n) => n === 5));
  });

  it('covers every one of the 26 tasks', () => {
    const form = mustGenerate(11);
    const tasks = new Set(form.items.map((i) => pool.get(i.questionId)!.taskId));
    assert.equal(tasks.size, 26);
  });

  it('is reproducible from its seed and differs between seeds', () => {
    assert.deepEqual(mustGenerate(42), mustGenerate(42));
    assert.notDeepEqual(mustGenerate(42).items, mustGenerate(43).items);
  });

  it('never selects excluded, unpublished or unscorable questions', () => {
    const p = new Map<string, Question>([...pool].map(([k, q]) => [k, structuredClone(q)]));
    const ids = [...p.keys()].filter((id) => !p.get(id)!.caseSetId);
    // Spread the removals evenly over all tasks so the bank stays large enough.
    const excluded = new Set(ids.filter((_, i) => i % 7 === 0));
    for (const id of ids.filter((_, i) => i % 7 === 1)) p.get(id)!.status = 'draft';
    for (const id of ids.filter((_, i) => i % 7 === 2)) p.get(id)!.options.forEach((o) => (o.isCorrect = false));
    for (let seed = 1; seed <= 25; seed++) {
      const r = generateExam(bp, p, { seed, excludeQuestionIds: excluded });
      assert.ok(r.ok);
      for (const item of r.form.items) {
        const q = p.get(item.questionId)!;
        assert.ok(!excluded.has(q.id));
        assert.equal(q.status, 'published');
        assert.ok(isScorable(q));
      }
    }
  });

  it('skips a case set when one of its questions is not published', () => {
    const p = new Map<string, Question>([...pool].map(([k, q]) => [k, structuredClone(q)]));
    const victim = [...p.values()].find((q) => q.caseSetId === 'CS001')!;
    victim.status = 'withdrawn';
    for (let seed = 1; seed <= 50; seed++) {
      const r = generateExam(bp, p, { seed });
      assert.ok(r.ok);
      assert.ok(r.form.items.every((i) => p.get(i.questionId)!.caseSetId !== 'CS001'));
    }
  });

  it('fails closed with reasons when the bank is too small', () => {
    const small = buildPool(bp, { perTask: 3, caseSets: 4 });
    const r = generateExam(bp, small, { seed: 1 });
    assert.equal(r.ok, false);
    assert.ok(!('form' in r));
    assert.ok(!r.ok && r.violations.length > 0);
  });

  it('fails closed when there are no complete case sets', () => {
    const noCases = buildPool(bp, { perTask: 50, caseSets: 0 });
    const r = generateExam(bp, noCases, { seed: 1 });
    assert.ok(!r.ok && r.violations.some((x) => x.includes('case sets')));
  });

  it('refuses to generate from an invalid blueprint', () => {
    const broken = structuredClone(bp);
    broken.domains[0]!.weightPct = 10;
    const r = generateExam(broken, pool, { seed: 1 });
    assert.ok(!r.ok && r.attempts === 0);
  });
});

describe('exam validation catches tampering', () => {
  it('detects a duplicated question', () => {
    const form = structuredClone(mustGenerate(5));
    form.items[100]!.questionId = form.items[101]!.questionId;
    form.items[100]!.versionId = form.items[101]!.versionId;
    assert.ok(validateExam(bp, form, pool).some((x) => x.includes('duplicate')));
  });

  it('detects a domain that drifts from its quota', () => {
    const form = structuredClone(mustGenerate(5));
    const used = new Set(form.items.map((i) => i.questionId));
    const spare = [...pool.values()].filter((q) => q.domainId === 'PEOPLE' && !q.caseSetId && !used.has(q.id));
    let swapped = 0;
    for (const item of form.items) {
      if (swapped === 5) break;
      if (pool.get(item.questionId)!.domainId === 'BUSINESS' && !pool.get(item.questionId)!.caseSetId) {
        const s = spare[swapped++]!;
        item.questionId = s.id;
        item.versionId = s.versionId;
      }
    }
    assert.ok(validateExam(bp, form, pool).some((x) => x.includes('quota')));
  });

  it('detects a wrong exam length and a stale version', () => {
    const short = structuredClone(mustGenerate(5));
    short.items.pop();
    assert.ok(validateExam(bp, short, pool).some((x) => x.includes('expected 180')));
    const stale = structuredClone(mustGenerate(5));
    stale.items[50]!.versionId = 'old';
    assert.ok(validateExam(bp, stale, pool).some((x) => x.includes('stale')));
  });

  it('detects an approach mix outside tolerance', () => {
    const p = new Map<string, Question>([...pool].map(([k, q]) => [k, structuredClone(q)]));
    const form = mustGenerate(5, p);
    let changed = 0;
    for (const item of form.items) {
      const q = p.get(item.questionId)!;
      if (q.approach !== 'predictive' && changed < 20) {
        q.approach = 'predictive';
        changed++;
      }
    }
    const rule = bp.mixRules[0]!;
    const share = (form.items.filter((i) => matchesRule(p.get(i.questionId)!, rule)).length / 180) * 100;
    assert.ok(share > rule.targetPct + rule.tolerancePct);
    assert.ok(validateExam(bp, form, p).some((x) => x.includes('approach')));
  });
});

describe('scoring', () => {
  const single = [...pool.values()].find((q) => q.type === 'single')!;
  const multiple = [...pool.values()].find((q) => q.type === 'multiple')!;

  it('scores single choice', () => {
    assert.deepEqual(scoreQuestion(single, ['a']), { answered: true, correct: true, points: 1 });
    assert.deepEqual(scoreQuestion(single, ['b']), { answered: true, correct: false, points: 0 });
    assert.deepEqual(scoreQuestion(single, []), { answered: false, correct: false, points: 0 });
    assert.equal(scoreQuestion(single, ['a', 'b']).correct, false);
  });

  it('scores multiple response all-or-nothing by default', () => {
    assert.equal(scoreQuestion(multiple, ['c', 'a']).points, 1);
    assert.equal(scoreQuestion(multiple, ['a']).points, 0);
    assert.equal(scoreQuestion(multiple, ['a', 'b']).points, 0);
    assert.equal(scoreQuestion(multiple, ['a', 'b', 'c']).points, 0);
  });

  it('supports partial credit only when the blueprint switches it on', () => {
    assert.equal(scoreQuestion(multiple, ['a'], true).points, 0.5);
    assert.equal(scoreQuestion(multiple, ['a', 'b'], true).points, 0);
    assert.equal(scoreQuestion(single, ['b'], true).points, 0);
  });

  it('ignores option ids that do not belong to the question', () => {
    assert.equal(scoreQuestion(single, ['zzz']).answered, false);
  });

  it('matches a hand-built reference attempt (acceptance A4)', () => {
    const form = mustGenerate(99);
    const responses = new Map<number, string[]>();
    let expectedCorrect = 0;
    const expectedByDomain: Record<string, number> = {};
    for (const item of form.items) {
      const q = pool.get(item.questionId)!;
      const key = q.options.filter((o) => o.isCorrect).map((o) => o.id);
      if (item.ordinal % 10 === 0) continue; // 18 unanswered
      if (item.ordinal % 3 === 0) {
        responses.set(item.ordinal, ['b']); // always wrong in the synthetic pool
      } else {
        responses.set(item.ordinal, key);
        expectedCorrect++;
        expectedByDomain[q.domainId] = (expectedByDomain[q.domainId] ?? 0) + 1;
      }
    }
    const result = scoreAttempt(bp, form, pool, responses);
    assert.equal(result.overall.total, 180);
    assert.equal(result.overall.answered, 162);
    assert.equal(result.overall.correct, expectedCorrect);
    assert.equal(result.overall.percent, Math.round((expectedCorrect / 180) * 1000) / 10);
    for (const d of bp.domains) {
      assert.equal(result.byDomain[d.id]!.correct, expectedByDomain[d.id] ?? 0);
    }
    const sum = Object.values(result.byDomain).reduce((s, t) => s + t.total, 0);
    assert.equal(sum, 180);
    assert.equal(Object.keys(result.byTask).length, 26);
    assert.deepEqual(scoreAttempt(bp, form, pool, responses), result);
  });

  it('scores an empty submission as zero without failing', () => {
    const form = mustGenerate(3);
    const result = scoreAttempt(bp, form, pool, new Map());
    assert.equal(result.overall.correct, 0);
    assert.equal(result.overall.answered, 0);
    assert.equal(result.overall.percent, 0);
  });
});

describe('answer-key protection (acceptance A5)', () => {
  it('candidate view carries no key or rationale for any question in an exam', () => {
    const form = mustGenerate(21);
    for (const item of form.items) {
      const q = pool.get(item.questionId)!;
      const json = JSON.stringify(toCandidateQuestion(q));
      assert.ok(!/isCorrect|rationale|correct/i.test(json), json);
      assert.ok(!json.includes(q.id), 'question id must not be exposed');
      const view = toCandidateQuestion(q);
      assert.deepEqual(Object.keys(view).sort(), ['caseSetId', 'exhibits', 'graphic', 'options', 'selectCount', 'stem', 'type']);
      assert.ok(view.options.every((o) => Object.keys(o).sort().join() === 'id,text'));
    }
  });
});
