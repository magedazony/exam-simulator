// How answers to each question type are written and checked.
//
// Every answer travels as a list of strings (selectedOptionIds), so the exam flow,
// storage and autosave stay the same for all types:
//   single, multiple, hotspot  option ids
//   ordering                   every option id, in the candidate's order
//   matching                   "L<n>:<optionId>" — left item n (1-based, display order) is
//                              paired with the right-hand item that belongs to optionId
//   numeric                    one number, as text
import type { Question } from './types.ts';

export const NEW_TYPES = ['matching', 'ordering', 'numeric', 'hotspot'] as const;
export const ALL_TYPES = ['single', 'multiple', ...NEW_TYPES] as const;

const NUMBER = /^-?\d{1,15}(\.\d{1,6})?$/;

export function parseNumber(text: string): number | null {
  const t = text.trim().replace(/,/g, '').replace('٫', '.').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  return NUMBER.test(t) ? Number(t) : null;
}

/** How many answer strings a complete answer has; also the "choose n" shown to candidates. */
export function selectCount(q: Question): number {
  if (q.type === 'single' || q.type === 'hotspot' || q.type === 'numeric') return 1;
  if (q.type === 'multiple') return q.options.filter((o) => o.isCorrect).length;
  return q.options.length;
}

/** null when the answer is well formed for the question, else an error code. */
export function answerProblem(q: Question, selected: readonly string[]): 'invalid_option' | 'too_many_selections' | null {
  const ids = new Set(q.options.map((o) => o.id));
  if (new Set(selected).size !== selected.length) return 'invalid_option';
  if (q.type === 'numeric') {
    if (selected.length > 1) return 'too_many_selections';
    return selected.every((s) => s.length <= 30 && parseNumber(s) !== null) ? null : 'invalid_option';
  }
  if (q.type === 'matching') {
    if (selected.length > q.options.length) return 'too_many_selections';
    const lefts = new Set<string>();
    for (const s of selected) {
      const m = /^L(\d{1,2}):(.+)$/.exec(s);
      if (!m || Number(m[1]) < 1 || Number(m[1]) > q.options.length || !ids.has(m[2]!) || lefts.has(m[1]!)) return 'invalid_option';
      lefts.add(m[1]!);
    }
    return null;
  }
  if (selected.some((id) => !ids.has(id))) return 'invalid_option';
  if (selected.length > selectCount(q)) return 'too_many_selections';
  return null;
}

/** The correct answer in the same string form, for scoring and for showing after answering. */
export function correctAnswer(q: Question): string[] {
  if (q.type === 'ordering') return q.options.map((o) => o.id);
  if (q.type === 'matching') return q.options.map((o, i) => `L${i + 1}:${o.id}`);
  if (q.type === 'numeric') return q.options.slice(0, 1).map((o) => o.text);
  return q.options.filter((o) => o.isCorrect).map((o) => o.id);
}

/** Is a complete, well-formed answer fully correct? */
export function isCorrectAnswer(q: Question, selected: readonly string[]): boolean {
  if (q.type === 'numeric') {
    const got = selected.length === 1 ? parseNumber(selected[0]!) : null;
    const key = q.options[0] ? parseNumber(q.options[0].text) : null;
    if (got === null || key === null) return false;
    const tol = Math.abs(Number(q.options[0]!.meta?.tolerance ?? 0)) || 0;
    return Math.abs(got - key) <= tol + 1e-9;
  }
  if (q.type === 'ordering') {
    const key = correctAnswer(q);
    return selected.length === key.length && key.every((id, i) => selected[i] === id);
  }
  if (q.type === 'matching') {
    const key = new Set(correctAnswer(q));
    return selected.length === key.size && selected.every((s) => key.has(s));
  }
  const key = new Set(correctAnswer(q));
  const got = new Set(selected);
  return got.size === key.size && [...key].every((id) => got.has(id));
}
