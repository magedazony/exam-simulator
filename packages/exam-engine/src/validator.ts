import { domainQuotas, isScorable, matchesRule } from './blueprint.ts';
import type { Blueprint, ExamForm, Question } from './types.ts';

/**
 * Independent check that a generated exam complies with its blueprint.
 * The generator never returns a form that fails this check, and the same
 * function can be run later to audit a stored form.
 *
 * Returns a list of violations. Empty list = compliant.
 */
export function validateExam(
  bp: Blueprint,
  form: ExamForm,
  pool: ReadonlyMap<string, Question>,
): string[] {
  const v: string[] = [];

  if (form.blueprintCode !== bp.code || form.blueprintVersion !== bp.version) {
    v.push('form was built for a different blueprint version');
  }
  if (!(form.durationMinutes > 0) || form.durationMinutes !== bp.durationMinutes) {
    v.push('timing does not match the blueprint');
  }
  if (form.items.length !== bp.totalQuestions) {
    v.push(`exam has ${form.items.length} questions, expected ${bp.totalQuestions}`);
  }

  // Ordinals are 1..N without gaps; no question appears twice.
  const seen = new Set<string>();
  const questions: Question[] = [];
  form.items.forEach((item, i) => {
    if (item.ordinal !== i + 1) v.push(`ordinal ${item.ordinal} at position ${i + 1}`);
    if (seen.has(item.questionId)) v.push(`duplicate question ${item.questionId}`);
    seen.add(item.questionId);
    const q = pool.get(item.questionId);
    if (!q) {
      v.push(`unknown question ${item.questionId}`);
      return;
    }
    if (q.versionId !== item.versionId) v.push(`stale version for question ${q.id}`);
    if (q.status !== 'published') v.push(`question ${q.id} is not published`);
    if (!isScorable(q)) v.push(`question ${q.id} has no valid answer key`);
    questions.push(q);
  });
  if (questions.length !== form.items.length) return v;

  // Sections: sizes, kind, and case sets kept whole and contiguous.
  let offset = 0;
  bp.sections.forEach((section, sIndex) => {
    const slice = form.items.slice(offset, offset + section.questionCount);
    if (slice.length !== section.questionCount) v.push(`section ${sIndex + 1} has the wrong size`);
    for (const item of slice) {
      if (item.sectionIndex !== sIndex) v.push(`question ${item.ordinal} is in the wrong section`);
      const q = pool.get(item.questionId) as Question;
      if (section.kind === 'case' && !q.caseSetId) {
        v.push(`question ${item.ordinal} in a case section has no case set`);
      }
      if (section.kind === 'independent' && q.caseSetId) {
        v.push(`case-set question ${item.ordinal} outside the case section`);
      }
    }
    offset += section.questionCount;
  });

  const usedPerSet = new Map<string, number>();
  for (const q of questions) {
    if (q.caseSetId) usedPerSet.set(q.caseSetId, (usedPerSet.get(q.caseSetId) ?? 0) + 1);
  }
  const sizePerSet = new Map<string, number>();
  for (const q of pool.values()) {
    if (q.caseSetId && q.status === 'published') {
      sizePerSet.set(q.caseSetId, (sizePerSet.get(q.caseSetId) ?? 0) + 1);
    }
  }
  for (const [setId, used] of usedPerSet) {
    if (used !== sizePerSet.get(setId)) v.push(`case set ${setId} is incomplete`);
  }
  let lastSet: string | undefined;
  const closedSets = new Set<string>();
  for (const q of questions) {
    if (q.caseSetId !== lastSet) {
      if (lastSet) closedSets.add(lastSet);
      if (q.caseSetId && closedSets.has(q.caseSetId)) v.push(`case set ${q.caseSetId} is split`);
      lastSet = q.caseSetId;
    }
  }

  // Domain distribution.
  const quotas = domainQuotas(bp);
  const perDomain = new Map<string, number>();
  const perTask = new Map<string, number>();
  for (const q of questions) {
    perDomain.set(q.domainId, (perDomain.get(q.domainId) ?? 0) + 1);
    perTask.set(q.taskId, (perTask.get(q.taskId) ?? 0) + 1);
  }
  for (const d of bp.domains) {
    const have = perDomain.get(d.id) ?? 0;
    const want = quotas.get(d.id) ?? 0;
    if (Math.abs(have - want) > bp.domainToleranceQuestions) {
      v.push(`domain ${d.id} has ${have} questions, quota ${want}`);
    }
    for (const t of d.tasks) {
      if ((perTask.get(t.id) ?? 0) < bp.minPerTask) v.push(`task ${t.id} is under-covered`);
    }
  }
  const knownTasks = new Map<string, string>();
  for (const d of bp.domains) for (const t of d.tasks) knownTasks.set(t.id, d.id);
  for (const q of questions) {
    if (knownTasks.get(q.taskId) !== q.domainId) v.push(`question ${q.id} has a task outside its domain`);
  }

  // Approach, difficulty, type and graphic mixes.
  for (const rule of bp.mixRules) {
    const count = questions.filter((q) => matchesRule(q, rule)).length;
    const pct = (count / bp.totalQuestions) * 100;
    if (pct < rule.targetPct - rule.tolerancePct - 1e-9 || pct > rule.targetPct + rule.tolerancePct + 1e-9) {
      v.push(
        `${rule.dimension} [${rule.keys.join(', ')}] is ${pct.toFixed(1)}%, ` +
          `allowed ${rule.targetPct - rule.tolerancePct} to ${rule.targetPct + rule.tolerancePct}%`,
      );
    }
  }
  return v;
}
