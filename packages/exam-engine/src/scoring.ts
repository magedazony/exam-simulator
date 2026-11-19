import type { Blueprint, ExamForm, Question } from './types.ts';
import { isCorrectAnswer } from './answers.ts';

export interface QuestionScore {
  answered: boolean;
  correct: boolean;
  /** 0..1. Equals 1 only when fully correct unless partial credit is enabled. */
  points: number;
}

export type Scorer = (q: Question, selectedOptionIds: readonly string[], partialCredit: boolean) => QuestionScore;

const scorers = new Map<string, Scorer>();

/** New question types plug in here without changes to the exam flow. */
export function registerScorer(type: string, scorer: Scorer): void {
  scorers.set(type, scorer);
}

function exactSetScorer(q: Question, selected: readonly string[], partialCredit: boolean): QuestionScore {
  const valid = new Set(q.options.map((o) => o.id));
  const chosen = new Set(selected.filter((id) => valid.has(id)));
  if (chosen.size === 0) return { answered: false, correct: false, points: 0 };

  const key = new Set(q.options.filter((o) => o.isCorrect).map((o) => o.id));
  let hits = 0;
  let wrong = 0;
  for (const id of chosen) {
    if (key.has(id)) hits++;
    else wrong++;
  }
  const correct = wrong === 0 && hits === key.size;
  if (correct) return { answered: true, correct: true, points: 1 };
  if (!partialCredit || q.type === 'single') return { answered: true, correct: false, points: 0 };
  // Partial credit: right picks minus wrong picks, never below zero.
  return { answered: true, correct: false, points: Math.max(0, hits - wrong) / key.size };
}

registerScorer('single', (q, selected, partial) => {
  // More than one selection on a single-choice question is always wrong.
  if (new Set(selected).size > 1) return { answered: true, correct: false, points: 0 };
  return exactSetScorer(q, selected, partial);
});
registerScorer('multiple', exactSetScorer);
registerScorer('hotspot', (q, selected, partial) => {
  if (new Set(selected).size > 1) return { answered: true, correct: false, points: 0 };
  return exactSetScorer({ ...q, type: 'single' }, selected, partial);
});
// Ordering, matching and numeric answers are right only when complete and exact.
for (const type of ['ordering', 'matching', 'numeric']) {
  registerScorer(type, (q, selected) => {
    if (selected.length === 0) return { answered: false, correct: false, points: 0 };
    const correct = isCorrectAnswer(q, selected);
    return { answered: true, correct, points: correct ? 1 : 0 };
  });
}

export function scoreQuestion(q: Question, selected: readonly string[], partialCredit = false): QuestionScore {
  const scorer = scorers.get(q.type);
  if (!scorer) throw new Error(`no scorer registered for question type "${q.type}"`);
  return scorer(q, selected, partialCredit);
}

export interface Tally {
  total: number;
  answered: number;
  correct: number;
  points: number;
  percent: number;
}

export interface AttemptResult {
  overall: Tally;
  byDomain: Record<string, Tally>;
  byTask: Record<string, Tally>;
  byApproach: Record<string, Tally>;
  byDifficulty: Record<string, Tally>;
  byType: Record<string, Tally>;
  perQuestion: Array<{ ordinal: number; questionId: string } & QuestionScore>;
}

const emptyTally = (): Tally => ({ total: 0, answered: 0, correct: 0, points: 0, percent: 0 });

function add(tally: Tally, s: QuestionScore): void {
  tally.total++;
  if (s.answered) tally.answered++;
  if (s.correct) tally.correct++;
  tally.points += s.points;
}

function finish(tally: Tally): void {
  tally.percent = tally.total === 0 ? 0 : Math.round((tally.points / tally.total) * 1000) / 10;
}

/**
 * Scores a submitted attempt. Unanswered questions count as incorrect.
 * Pure function of its inputs, so re-scoring always gives the same result.
 *
 * `responses` maps a question's ordinal to the option ids the candidate chose.
 */
export function scoreAttempt(
  bp: Blueprint,
  form: ExamForm,
  pool: ReadonlyMap<string, Question>,
  responses: ReadonlyMap<number, readonly string[]>,
): AttemptResult {
  const result: AttemptResult = {
    overall: emptyTally(),
    byDomain: {},
    byTask: {},
    byApproach: {},
    byDifficulty: {},
    byType: {},
    perQuestion: [],
  };
  const bucket = (group: Record<string, Tally>, key: string): Tally => (group[key] ??= emptyTally());

  for (const item of form.items) {
    const q = pool.get(item.questionId);
    if (!q || q.versionId !== item.versionId) {
      throw new Error(`question version ${item.versionId} is not available for scoring`);
    }
    const score = scoreQuestion(q, responses.get(item.ordinal) ?? [], bp.scoring.partialCredit);
    result.perQuestion.push({ ordinal: item.ordinal, questionId: q.id, ...score });
    add(result.overall, score);
    add(bucket(result.byDomain, q.domainId), score);
    add(bucket(result.byTask, q.taskId), score);
    add(bucket(result.byApproach, q.approach), score);
    add(bucket(result.byDifficulty, q.difficulty), score);
    add(bucket(result.byType, q.type), score);
  }

  finish(result.overall);
  for (const group of [result.byDomain, result.byTask, result.byApproach, result.byDifficulty, result.byType]) {
    for (const tally of Object.values(group)) finish(tally);
  }
  return result;
}
