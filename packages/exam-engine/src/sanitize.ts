import type { ExhibitRef, Question } from './types.ts';
import { selectCount } from './answers.ts';

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
  /**
   * single/multiple/hotspot: the choices. ordering: the items, scrambled. matching: the left
   * items, with ids L1..Ln. numeric: empty. hotspot options carry the table cell they mark.
   */
  options: Array<{ id: string; text: string; textAr?: string; cell?: [number, number] }>;
  /** matching only: the right-hand items, scrambled; their ids are what the answer pairs with. */
  targets?: Array<{ id: string; text: string; textAr?: string }>;
}

/** A random order that is never the original one (when there is more than one item). */
function scramble<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  if (out.length > 1 && out.every((x, i) => x === items[i])) out.push(out.shift()!);
  return out;
}

export function toCandidateQuestion(q: Question): CandidateQuestion {
  const out: CandidateQuestion = {
    type: q.type,
    stem: q.stem,
    graphic: q.graphic === true,
    caseSetId: q.caseSetId ?? null,
    exhibits: toCandidateExhibits(q.exhibits ?? []),
    selectCount: selectCount(q),
    options: [],
  };
  const plain = (o: Question['options'][number], id = o.id) => {
    const opt: { id: string; text: string; textAr?: string; cell?: [number, number] } = { id, text: o.text };
    if (o.textAr) opt.textAr = o.textAr;
    return opt;
  };
  if (q.type === 'numeric') {
    out.options = [];
  } else if (q.type === 'ordering') {
    out.options = scramble(q.options).map((o) => plain(o));
  } else if (q.type === 'matching') {
    out.options = q.options.map((o, i) => plain(o, `L${i + 1}`));
    out.targets = scramble(q.options).map((o) => {
      const t: { id: string; text: string; textAr?: string } = { id: o.id, text: o.meta?.match ?? '' };
      if (o.meta?.matchAr) t.textAr = o.meta.matchAr;
      return t;
    });
  } else {
    out.options = q.options.map((o) => {
      const opt = plain(o);
      const cell = o.meta?.cell;
      if (q.type === 'hotspot' && Array.isArray(cell) && cell.length === 2) opt.cell = [Number(cell[0]), Number(cell[1])];
      return opt;
    });
  }
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
