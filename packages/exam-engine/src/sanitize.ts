import type { ExhibitRef, Question } from './types.ts';

/**
 * What a candidate may receive for a question before it is answered
 * (practice) or before the attempt is submitted (mock exam).
 *
 * This type deliberately has no field for correctness or rationale, and the
 * object is built field by field rather than by copying the question, so a
 * new server-side field can never leak by accident.
 */
export type CandidateExhibit = CandidateQuestion['exhibits'][number];

export interface CandidateQuestion {
  type: string;
  stem: string;
  /** Arabic translation of stem; present when available and lang=ar. */
  stemAr?: string;
  graphic: boolean;
  caseSetId: string | null;
  /**
   * Tables are sent inline. Images carry only their exhibit id, which the API
   * replaces with a short-lived signed address before the response leaves.
   */
  exhibits: Array<
    | { kind: 'table'; altText: string; table: { header: string[]; rows: string[][] } }
    | { kind: 'image'; altText: string; exhibitId: string }
  >;
  /** How many options to select; shown in the instruction, as on the real exam. */
  selectCount: number;
  options: Array<{ id: string; text: string; textAr?: string }>;
}

export function toCandidateQuestion(q: Question): CandidateQuestion {
  const out: CandidateQuestion = {
    type: q.type,
    stem: q.stem,
    graphic: q.graphic === true,
    caseSetId: q.caseSetId ?? null,
    exhibits: toCandidateExhibits(q.exhibits ?? []),
    selectCount: q.options.filter((o) => o.isCorrect).length,
    options: q.options.map((o) => {
      const opt: { id: string; text: string; textAr?: string } = { id: o.id, text: o.text };
      if (o.textAr) opt.textAr = o.textAr;
      return opt;
    }),
  };
  if (q.stemAr) out.stemAr = q.stemAr;
  return out;
}

/** Candidate form of exhibit references; also used for case-study scenarios. */
export function toCandidateExhibits(refs: readonly ExhibitRef[]): CandidateExhibit[] {
  return refs.map((e) =>
    e.kind === 'table' && e.table
      ? { kind: 'table' as const, altText: e.altText, table: { header: e.table.header, rows: e.table.rows } }
      : { kind: 'image' as const, altText: e.altText, exhibitId: e.id },
  );
}
