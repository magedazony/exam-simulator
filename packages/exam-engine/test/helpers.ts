import { readFileSync } from 'node:fs';
import { createRng } from '../src/rng.ts';
import type { Approach, Blueprint, Difficulty, Question } from '../src/types.ts';

export function loadBlueprint(): Blueprint {
  const url = new URL('../data/blueprint-2026-07.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Blueprint;
}

function pick<T>(r: number, table: Array<[T, number]>): T {
  let acc = 0;
  for (const [value, share] of table) {
    acc += share;
    if (r < acc) return value;
  }
  return table[table.length - 1]![0];
}

/**
 * Builds a synthetic question pool for engine tests. The items carry metadata
 * and placeholder text only; they are not exam content.
 */
export function buildPool(
  bp: Blueprint,
  opts: { perTask: number; caseSets: number; caseSetSize?: number; seed?: number },
): Map<string, Question> {
  const rng = createRng(opts.seed ?? 1);
  const pool = new Map<string, Question>();
  let n = 0;

  const make = (domainId: string, taskId: string, caseSetId?: string): Question => {
    n++;
    const id = `Q${String(n).padStart(5, '0')}`;
    const type = rng() < 0.15 ? 'multiple' : 'single';
    const approach = pick<Approach>(rng(), [['predictive', 0.4], ['agile', 0.3], ['hybrid', 0.3]]);
    const difficulty = pick<Difficulty>(rng(), [['easy', 0.25], ['medium', 0.5], ['hard', 0.25]]);
    const correct = type === 'single' ? ['a'] : ['a', 'c'];
    const q: Question = {
      id,
      versionId: `${id}-v1`,
      status: 'published',
      domainId,
      taskId,
      approach,
      difficulty,
      type,
      graphic: rng() < 0.1,
      stem: `Synthetic item ${n}`,
      options: ['a', 'b', 'c', 'd'].map((o) => ({
        id: o,
        text: `Option ${o.toUpperCase()}`,
        isCorrect: correct.includes(o),
        rationale: `Rationale ${o}`,
      })),
    };
    if (caseSetId) q.caseSetId = caseSetId;
    return q;
  };

  for (const d of bp.domains) {
    for (const t of d.tasks) {
      for (let i = 0; i < opts.perTask; i++) {
        const q = make(d.id, t.id);
        pool.set(q.id, q);
      }
    }
  }
  const tasks = bp.domains.flatMap((d) => d.tasks.map((t) => ({ domainId: d.id, taskId: t.id })));
  for (let s = 0; s < opts.caseSets; s++) {
    const setId = `CS${String(s + 1).padStart(3, '0')}`;
    for (let i = 0; i < (opts.caseSetSize ?? 5); i++) {
      const t = tasks[Math.floor(rng() * tasks.length)]!;
      const q = make(t.domainId, t.taskId, setId);
      pool.set(q.id, q);
    }
  }
  return pool;
}
