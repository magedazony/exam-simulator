// Exam session rules: the timer, sections, breaks, locking, answer saving and
// submission. Pure functions over a plain JSON state, with the current time
// passed in, so the server stays the only authority on time and the same
// rules can be unit-tested without a clock, a database or a network.

import { answerProblem } from './answers.ts';
import type { Blueprint, ExamForm, Question } from './types.ts';

export type AttemptStatus = 'in_progress' | 'on_break' | 'submitted' | 'expired';

export interface SectionState {
  state: 'locked' | 'open' | 'closed';
  openedAtMs: number | null;
  closedAtMs: number | null;
}

export interface SavedAnswer {
  /** Empty array = the candidate cleared the answer. */
  selected: string[];
  savedAtMs: number;
  /** Increases with every change on the client; lets late or repeated saves be ignored. */
  clientSeq: number;
}

/** Plain JSON, safe to store in Redis or PostgreSQL as is. */
export interface AttemptState {
  status: AttemptStatus;
  startedAtMs: number;
  /** Moves later when a break pauses the clock. */
  deadlineMs: number;
  currentSection: number;
  sections: SectionState[];
  answers: Record<number, SavedAnswer>;
  flags: number[];
  breakStartedAtMs: number | null;
  breakEndsAtMs: number | null;
  finishedAtMs: number | null;
}

export interface SessionOptions {
  /**
   * When true, time spent on a break (up to its allowed length) does not
   * count against the exam. House setting: confirm against the current PMI
   * handbook before launch.
   */
  breakPausesClock: boolean;
}

export const DEFAULT_SESSION_OPTIONS: SessionOptions = { breakPausesClock: true };

export type SessionErrorCode =
  | 'not_active'
  | 'on_break'
  | 'not_on_break'
  | 'section_locked'
  | 'unknown_ordinal'
  | 'invalid_option'
  | 'too_many_selections'
  | 'last_section'
  | 'not_last_section'
  | 'already_finished';

export type SessionResult =
  | { ok: true; state: AttemptState; note?: 'stale_ignored' }
  | { ok: false; code: SessionErrorCode; state: AttemptState };

const MINUTE = 60_000;

export function startAttempt(bp: Blueprint, form: ExamForm, nowMs: number): AttemptState {
  return {
    status: 'in_progress',
    startedAtMs: nowMs,
    deadlineMs: nowMs + form.durationMinutes * MINUTE,
    currentSection: 0,
    sections: bp.sections.map((_, i) => ({
      state: i === 0 ? 'open' : 'locked',
      openedAtMs: i === 0 ? nowMs : null,
      closedAtMs: null,
    })),
    answers: {},
    flags: [],
    breakStartedAtMs: null,
    breakEndsAtMs: null,
    finishedAtMs: null,
  };
}

function endBreak(s: AttemptState, atMs: number, opts: SessionOptions): void {
  const started = s.breakStartedAtMs ?? atMs;
  if (opts.breakPausesClock) s.deadlineMs += Math.max(0, atMs - started);
  s.breakStartedAtMs = null;
  s.breakEndsAtMs = null;
  s.currentSection += 1;
  const next = s.sections[s.currentSection]!;
  next.state = 'open';
  next.openedAtMs = atMs;
  s.status = 'in_progress';
}

/**
 * Brings a state up to the given time: ends a break that has run out and
 * expires an attempt whose deadline has passed. Every other function calls
 * this first, so time-based transitions never depend on the client.
 */
export function advance(
  state: AttemptState,
  nowMs: number,
  opts: SessionOptions = DEFAULT_SESSION_OPTIONS,
): AttemptState {
  const s = structuredClone(state);
  if (s.status === 'on_break') {
    if (!opts.breakPausesClock && nowMs >= s.deadlineMs) {
      s.status = 'expired';
      s.finishedAtMs = s.deadlineMs;
      s.breakStartedAtMs = null;
      s.breakEndsAtMs = null;
      return s;
    }
    if (s.breakEndsAtMs !== null && nowMs >= s.breakEndsAtMs) endBreak(s, s.breakEndsAtMs, opts);
  }
  if (s.status === 'in_progress' && nowMs >= s.deadlineMs) {
    const open = s.sections[s.currentSection]!;
    open.state = 'closed';
    open.closedAtMs = s.deadlineMs;
    s.status = 'expired';
    s.finishedAtMs = s.deadlineMs;
  }
  return s;
}

function activeOrError(s: AttemptState): SessionErrorCode | null {
  if (s.status === 'on_break') return 'on_break';
  if (s.status !== 'in_progress') return 'not_active';
  return null;
}

export interface SaveAnswerInput {
  ordinal: number;
  selected: readonly string[];
  clientSeq: number;
}

/**
 * Saves, changes or clears one answer. Accepted only for a question in the
 * section that is currently open. Safe to call repeatedly: a save whose
 * clientSeq is not newer than the stored one is acknowledged and ignored.
 */
export function saveAnswer(
  state: AttemptState,
  form: ExamForm,
  pool: ReadonlyMap<string, Question>,
  input: SaveAnswerInput,
  nowMs: number,
  opts: SessionOptions = DEFAULT_SESSION_OPTIONS,
): SessionResult {
  const s = advance(state, nowMs, opts);
  const blocked = activeOrError(s);
  if (blocked) return { ok: false, code: blocked, state: s };

  const item = Number.isInteger(input.ordinal) ? form.items[input.ordinal - 1] : undefined;
  if (!item) return { ok: false, code: 'unknown_ordinal', state: s };
  if (item.sectionIndex !== s.currentSection) return { ok: false, code: 'section_locked', state: s };

  const q = pool.get(item.questionId);
  if (!q) return { ok: false, code: 'unknown_ordinal', state: s };
  const selected = [...new Set(input.selected)];
  const problem = answerProblem(q, selected);
  if (problem) return { ok: false, code: problem, state: s };

  const existing = s.answers[input.ordinal];
  if (existing && input.clientSeq <= existing.clientSeq) return { ok: true, state: s, note: 'stale_ignored' };
  s.answers[input.ordinal] = { selected, savedAtMs: nowMs, clientSeq: input.clientSeq };
  return { ok: true, state: s };
}

export function setFlag(
  state: AttemptState,
  form: ExamForm,
  ordinal: number,
  flagged: boolean,
  nowMs: number,
  opts: SessionOptions = DEFAULT_SESSION_OPTIONS,
): SessionResult {
  const s = advance(state, nowMs, opts);
  const blocked = activeOrError(s);
  if (blocked) return { ok: false, code: blocked, state: s };
  const item = Number.isInteger(ordinal) ? form.items[ordinal - 1] : undefined;
  if (!item) return { ok: false, code: 'unknown_ordinal', state: s };
  if (item.sectionIndex !== s.currentSection) return { ok: false, code: 'section_locked', state: s };
  const flags = new Set(s.flags);
  if (flagged) flags.add(ordinal);
  else flags.delete(ordinal);
  s.flags = [...flags].sort((a, b) => a - b);
  return { ok: true, state: s };
}

/**
 * Closes the open section for good and starts its break, or opens the next
 * section when there is no break. The last section is closed by submit().
 */
export function closeSection(
  state: AttemptState,
  bp: Blueprint,
  nowMs: number,
  opts: SessionOptions = DEFAULT_SESSION_OPTIONS,
): SessionResult {
  const s = advance(state, nowMs, opts);
  const blocked = activeOrError(s);
  if (blocked) return { ok: false, code: blocked, state: s };
  if (s.currentSection >= s.sections.length - 1) return { ok: false, code: 'last_section', state: s };

  const open = s.sections[s.currentSection]!;
  open.state = 'closed';
  open.closedAtMs = nowMs;
  const breakMinutes = bp.sections[s.currentSection]!.breakAfterMinutes;
  if (breakMinutes > 0) {
    s.status = 'on_break';
    s.breakStartedAtMs = nowMs;
    s.breakEndsAtMs = nowMs + breakMinutes * MINUTE;
  } else {
    s.breakStartedAtMs = nowMs;
    endBreak(s, nowMs, opts);
  }
  return { ok: true, state: s };
}

/** Ends a break early. Unused break time is not added to the exam. */
export function resumeFromBreak(
  state: AttemptState,
  nowMs: number,
  opts: SessionOptions = DEFAULT_SESSION_OPTIONS,
): SessionResult {
  const s = advance(state, nowMs, opts);
  if (s.status === 'in_progress' && state.status === 'on_break') return { ok: true, state: s };
  if (s.status !== 'on_break') return { ok: false, code: 'not_on_break', state: s };
  endBreak(s, nowMs, opts);
  return { ok: true, state: s };
}

/** Final submission. Allowed only from the last section. */
export function submit(
  state: AttemptState,
  nowMs: number,
  opts: SessionOptions = DEFAULT_SESSION_OPTIONS,
): SessionResult {
  const s = advance(state, nowMs, opts);
  if (s.status === 'submitted' || s.status === 'expired') return { ok: false, code: 'already_finished', state: s };
  if (s.status === 'on_break') return { ok: false, code: 'on_break', state: s };
  if (s.currentSection !== s.sections.length - 1) return { ok: false, code: 'not_last_section', state: s };
  const open = s.sections[s.currentSection]!;
  open.state = 'closed';
  open.closedAtMs = nowMs;
  s.status = 'submitted';
  s.finishedAtMs = nowMs;
  return { ok: true, state: s };
}

/** Exam time left. Frozen while a break pauses the clock. */
export function remainingMs(
  state: AttemptState,
  nowMs: number,
  opts: SessionOptions = DEFAULT_SESSION_OPTIONS,
): number {
  const s = advance(state, nowMs, opts);
  if (s.status === 'submitted' || s.status === 'expired') return 0;
  if (s.status === 'on_break' && opts.breakPausesClock) return s.deadlineMs - (s.breakStartedAtMs ?? nowMs);
  return Math.max(0, s.deadlineMs - nowMs);
}

/** Ordinals the candidate may see and answer right now. */
export function visibleOrdinals(state: AttemptState, form: ExamForm): number[] {
  if (state.status !== 'in_progress') return [];
  return form.items.filter((i) => i.sectionIndex === state.currentSection).map((i) => i.ordinal);
}

export interface SectionReview {
  total: number;
  answered: number;
  unanswered: number[];
  flagged: number[];
}

/** Counts for the review screen shown before a section is closed. */
export function sectionReview(state: AttemptState, form: ExamForm, sectionIndex: number): SectionReview {
  const ordinals = form.items.filter((i) => i.sectionIndex === sectionIndex).map((i) => i.ordinal);
  const unanswered = ordinals.filter((o) => (state.answers[o]?.selected.length ?? 0) === 0);
  const flags = new Set(state.flags);
  return {
    total: ordinals.length,
    answered: ordinals.length - unanswered.length,
    unanswered,
    flagged: ordinals.filter((o) => flags.has(o)),
  };
}

/** Answers in the shape scoreAttempt expects. Only finished attempts are scored. */
export function toResponses(state: AttemptState): Map<number, string[]> {
  if (state.status !== 'submitted' && state.status !== 'expired') {
    throw new Error('attempt is not finished');
  }
  const out = new Map<number, string[]>();
  for (const [ordinal, answer] of Object.entries(state.answers)) {
    if (answer.selected.length > 0) out.set(Number(ordinal), answer.selected);
  }
  return out;
}
