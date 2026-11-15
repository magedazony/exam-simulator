import { domainQuotas, isScorable, matchesRule, validateBlueprint } from './blueprint.ts';
import { createRng, shuffle } from './rng.ts';
import type { Rng } from './rng.ts';
import type {
  Blueprint,
  ExamForm,
  ExamItem,
  GenerateOptions,
  GenerateResult,
  Question,
} from './types.ts';
import { validateExam } from './validator.ts';

const DEFAULT_MAX_ATTEMPTS = 10;

/**
 * Builds a mock exam that complies with the blueprint, or fails closed.
 *
 * Steps: pick whole case-study sets for the case sections, then fill each
 * domain's remaining quota with independent questions, steering towards the
 * approach, difficulty and type mixes. Every candidate form is passed through
 * validateExam; a form that fails is discarded and generation is retried with
 * a new random stream. After maxAttempts the caller gets the violations and
 * no form.
 */
export function generateExam(
  bp: Blueprint,
  pool: ReadonlyMap<string, Question>,
  options: GenerateOptions,
): GenerateResult {
  const blueprintErrors = validateBlueprint(bp);
  if (blueprintErrors.length > 0) {
    return { ok: false, violations: blueprintErrors.map((e) => `blueprint: ${e}`), attempts: 0 };
  }
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const exclude = options.excludeQuestionIds ?? new Set<string>();
  let lastViolations: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const rng = createRng(options.seed + (attempt - 1) * 7919);
    const built = buildOnce(bp, pool, exclude, rng, options.seed);
    if (!built.ok) {
      lastViolations = built.violations;
      continue;
    }
    const violations = validateExam(bp, built.form, pool);
    if (violations.length === 0) return { ok: true, form: built.form, attempts: attempt };
    lastViolations = violations;
  }
  return { ok: false, violations: lastViolations, attempts: maxAttempts };
}

type BuildResult = { ok: true; form: ExamForm } | { ok: false; violations: string[] };

function buildOnce(
  bp: Blueprint,
  pool: ReadonlyMap<string, Question>,
  exclude: ReadonlySet<string>,
  rng: Rng,
  seed: number,
): BuildResult {
  const usable = (q: Question) => q.status === 'published' && isScorable(q) && !exclude.has(q.id);

  // Case sets are eligible only when every member is usable.
  const setMembers = new Map<string, Question[]>();
  const brokenSets = new Set<string>();
  const independents: Question[] = [];
  for (const q of pool.values()) {
    if (q.caseSetId) {
      if (!usable(q)) brokenSets.add(q.caseSetId);
      const list = setMembers.get(q.caseSetId) ?? [];
      list.push(q);
      setMembers.set(q.caseSetId, list);
    } else if (usable(q)) {
      independents.push(q);
    }
  }
  const eligibleSets = [...setMembers.entries()]
    .filter(([id]) => !brokenSets.has(id))
    .map(([id, members]) => ({
      id,
      members: members
        .slice()
        .sort((a, b) => (a.caseOrdinal ?? 0) - (b.caseOrdinal ?? 0) || a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const quotas = domainQuotas(bp);
  const remaining = new Map(quotas);
  const selected: Question[] = [];
  const selectedIds = new Set<string>();
  const taskCount = new Map<string, number>();
  const ruleCount = bp.mixRules.map(() => 0);
  const ruleTarget = bp.mixRules.map((r) => (r.targetPct / 100) * bp.totalQuestions);

  const take = (q: Question) => {
    selected.push(q);
    selectedIds.add(q.id);
    remaining.set(q.domainId, (remaining.get(q.domainId) ?? 0) - 1);
    taskCount.set(q.taskId, (taskCount.get(q.taskId) ?? 0) + 1);
    bp.mixRules.forEach((r, i) => {
      if (matchesRule(q, r)) ruleCount[i] = (ruleCount[i] as number) + 1;
    });
  };

  // 1. Case sections: whole sets whose sizes add up exactly to the section size.
  const usedSets = new Set<string>();
  const sectionQuestions: Question[][] = bp.sections.map(() => []);
  for (let s = 0; s < bp.sections.length; s++) {
    const section = bp.sections[s]!;
    if (section.kind !== 'case') continue;
    const candidates = shuffle(eligibleSets.filter((x) => !usedSets.has(x.id)), rng);
    const chosen = pickSets(candidates, section.questionCount);
    if (!chosen) {
      return { ok: false, violations: [`not enough complete case sets to fill ${section.questionCount} questions`] };
    }
    for (const set of chosen) {
      usedSets.add(set.id);
      for (const q of set.members) {
        take(q);
        sectionQuestions[s]!.push(q);
      }
    }
  }
  for (const [domainId, left] of remaining) {
    if (left < -bp.domainToleranceQuestions) {
      return { ok: false, violations: [`case sets overfill domain ${domainId}`] };
    }
  }

  // 2. Independent questions, domain by domain.
  const byDomain = new Map<string, Question[]>();
  for (const q of shuffle(independents, rng)) {
    const list = byDomain.get(q.domainId) ?? [];
    list.push(q);
    byDomain.set(q.domainId, list);
  }

  const gain = (q: Question): number => {
    let g = rng() * 0.05 - 0.02 * (taskCount.get(q.taskId) ?? 0);
    bp.mixRules.forEach((r, i) => {
      if (matchesRule(q, r)) {
        const target = ruleTarget[i] as number;
        g += (target - (ruleCount[i] as number)) / Math.max(target, 1);
      }
    });
    return g;
  };
  const pickBest = (candidates: Question[]): Question | undefined => {
    let best: Question | undefined;
    let bestGain = -Infinity;
    for (const q of candidates) {
      if (selectedIds.has(q.id)) continue;
      const g = gain(q);
      if (g > bestGain) {
        bestGain = g;
        best = q;
      }
    }
    return best;
  };

  const independentPicked: Question[] = [];
  for (const domain of bp.domains) {
    const candidates = byDomain.get(domain.id) ?? [];
    // Task coverage first.
    for (const task of domain.tasks) {
      while ((taskCount.get(task.id) ?? 0) < bp.minPerTask && (remaining.get(domain.id) ?? 0) > 0) {
        const q = pickBest(candidates.filter((c) => c.taskId === task.id));
        if (!q) return { ok: false, violations: [`no usable question left for task ${task.id}`] };
        take(q);
        independentPicked.push(q);
      }
    }
    // Then fill the domain quota.
    while ((remaining.get(domain.id) ?? 0) > 0) {
      const q = pickBest(candidates);
      if (!q) return { ok: false, violations: [`not enough usable questions in domain ${domain.id}`] };
      take(q);
      independentPicked.push(q);
    }
  }

  // 3. Distribute independent questions over the independent sections.
  const mixed = shuffle(independentPicked, rng);
  let cursor = 0;
  for (let s = 0; s < bp.sections.length; s++) {
    const section = bp.sections[s]!;
    if (section.kind !== 'independent') continue;
    sectionQuestions[s] = mixed.slice(cursor, cursor + section.questionCount);
    cursor += section.questionCount;
  }

  const items: ExamItem[] = [];
  sectionQuestions.forEach((questions, sectionIndex) => {
    for (const q of questions) {
      items.push({ ordinal: items.length + 1, sectionIndex, questionId: q.id, versionId: q.versionId });
    }
  });

  return {
    ok: true,
    form: {
      blueprintCode: bp.code,
      blueprintVersion: bp.version,
      seed,
      durationMinutes: bp.durationMinutes,
      items,
    },
  };
}

/** Finds sets, in the given order of preference, whose sizes sum exactly to `count`. */
function pickSets<T extends { members: unknown[] }>(sets: T[], count: number): T[] | undefined {
  const chosen: T[] = [];
  let steps = 0;
  const search = (start: number, left: number): boolean => {
    if (left === 0) return true;
    if (++steps > 50_000) return false;
    for (let i = start; i < sets.length; i++) {
      const set = sets[i]!;
      const size = set.members.length;
      if (size === 0 || size > left) continue;
      chosen.push(set);
      if (search(i + 1, left - size)) return true;
      chosen.pop();
    }
    return false;
  };
  return search(0, count) ? chosen : undefined;
}
