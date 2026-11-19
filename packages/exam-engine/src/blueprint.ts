import { parseNumber } from './answers.ts';
import type { Blueprint, MixRule, Question } from './types.ts';

/** Checks that a blueprint is internally consistent before it can be activated. */
export function validateBlueprint(bp: Blueprint): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(bp.totalQuestions) || bp.totalQuestions <= 0) {
    errors.push('totalQuestions must be a positive integer');
  }
  if (!(bp.durationMinutes > 0)) errors.push('durationMinutes must be positive');

  const weightSum = bp.domains.reduce((s, d) => s + d.weightPct, 0);
  if (Math.abs(weightSum - 100) > 1e-9) {
    errors.push(`domain weights sum to ${weightSum}, expected 100`);
  }

  const domainIds = new Set<string>();
  const taskIds = new Set<string>();
  for (const d of bp.domains) {
    if (domainIds.has(d.id)) errors.push(`duplicate domain id ${d.id}`);
    domainIds.add(d.id);
    if (d.tasks.length === 0) errors.push(`domain ${d.id} has no tasks`);
    for (const t of d.tasks) {
      if (taskIds.has(t.id)) errors.push(`duplicate task id ${t.id}`);
      taskIds.add(t.id);
    }
  }

  const sectionSum = bp.sections.reduce((s, x) => s + x.questionCount, 0);
  if (sectionSum !== bp.totalQuestions) {
    errors.push(`sections hold ${sectionSum} questions, expected ${bp.totalQuestions}`);
  }
  for (const s of bp.sections) {
    if (s.questionCount <= 0) errors.push('every section needs at least one question');
    if (s.breakAfterMinutes < 0) errors.push('breakAfterMinutes cannot be negative');
  }

  if (bp.minPerTask * taskIds.size > bp.totalQuestions) {
    errors.push('minPerTask cannot be met with this many tasks');
  }
  for (const r of bp.mixRules) {
    if (r.keys.length === 0) errors.push(`mix rule on ${r.dimension} has no keys`);
    if (r.targetPct < 0 || r.targetPct > 100) errors.push(`mix rule target ${r.targetPct} out of range`);
    if (r.tolerancePct < 0) errors.push('mix rule tolerance cannot be negative');
  }
  return errors;
}

/**
 * Converts domain weights into whole-question quotas that sum exactly to the
 * exam total, using the largest-remainder method.
 */
export function domainQuotas(bp: Blueprint): Map<string, number> {
  const raw = bp.domains.map((d) => ({ id: d.id, exact: (d.weightPct / 100) * bp.totalQuestions }));
  const quotas = new Map<string, number>();
  let assigned = 0;
  for (const r of raw) {
    const floor = Math.floor(r.exact);
    quotas.set(r.id, floor);
    assigned += floor;
  }
  const byRemainder = raw
    .map((r) => ({ id: r.id, rem: r.exact - Math.floor(r.exact) }))
    .sort((a, b) => b.rem - a.rem || a.id.localeCompare(b.id));
  let left = bp.totalQuestions - assigned;
  for (const r of byRemainder) {
    if (left <= 0) break;
    quotas.set(r.id, (quotas.get(r.id) ?? 0) + 1);
    left--;
  }
  return quotas;
}

/** The value a question has on a mix dimension. */
export function mixKey(q: Question, dimension: MixRule['dimension']): string {
  switch (dimension) {
    case 'approach':
      return q.approach;
    case 'difficulty':
      return q.difficulty;
    case 'type':
      return q.type;
    case 'graphic':
      return q.graphic ? 'yes' : 'no';
  }
}

export function matchesRule(q: Question, rule: MixRule): boolean {
  return rule.keys.includes(mixKey(q, rule.dimension));
}

/**
 * A question can be scored only if its key is well formed. Unscorable
 * questions are never selected for an exam.
 */
export function isScorable(q: Question): boolean {
  const ids = new Set(q.options.map((o) => o.id));
  if (ids.size !== q.options.length) return false;
  const correct = q.options.filter((o) => o.isCorrect).length;
  if (q.type === 'numeric') return q.options.length === 1 && correct === 1 && parseNumber(q.options[0]!.text) !== null;
  if (q.options.length < 2) return false;
  if (q.type === 'single') return correct === 1;
  if (q.type === 'multiple') return correct >= 2 && correct < q.options.length;
  if (q.type === 'hotspot') return correct === 1 && q.options.every((o) => Array.isArray(o.meta?.cell));
  if (q.type === 'matching') return q.options.length <= 6 && q.options.every((o) => (o.meta?.match ?? '').trim() !== '');
  if (q.type === 'ordering') return q.options.length <= 6;
  return false;
}
