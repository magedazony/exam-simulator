// Mock-exam application service: the use cases behind the /exams endpoints.
// Combines the pure exam rules (exam-engine) with storage (ExamStore).
// Framework-free; a NestJS controller only has to map HTTP to these methods.

import {
  DEFAULT_SESSION_OPTIONS,
  advance,
  closeSection,
  generateExam,
  remainingMs,
  resumeFromBreak,
  saveAnswer,
  scoreAttempt,
  sectionReview,
  setFlag,
  startAttempt,
  submit,
  toCandidateExhibits,
  toCandidateQuestion,
  toResponses,
  visibleOrdinals,
} from '../../exam-engine/src/index.ts';
import type {
  AttemptState,
  CandidateQuestion,
  Question,
  SaveAnswerInput,
  SectionReview,
  SessionOptions,
  SessionResult,
} from '../../exam-engine/src/index.ts';
import type { ExamStore, LoadedAttempt, StoredResult } from './ports.ts';

export class MockExamError extends Error {
  readonly code: string;
  readonly details: string[];
  constructor(code: string, details: string[] = []) {
    super(details.length ? `${code}: ${details.join('; ')}` : code);
    this.name = 'MockExamError';
    this.code = code;
    this.details = details;
  }
}

export interface ServiceConfig {
  blueprintCode: string;
  /** Questions from this many of the user's latest mocks are avoided when the bank allows. */
  excludeRecentAttempts: number;
  session: SessionOptions;
  /** How often a change is re-applied when another request got in first. */
  maxWriteRetries: number;
}

export const DEFAULT_SERVICE_CONFIG: ServiceConfig = {
  blueprintCode: 'PMP-ECO',
  excludeRecentAttempts: 2,
  session: DEFAULT_SESSION_OPTIONS,
  maxWriteRetries: 3,
};

export interface AttemptView {
  attemptId: string;
  status: AttemptState['status'];
  currentSection: number;
  sections: Array<{ state: string; kind: string; questionCount: number; firstOrdinal: number }>;
  remainingMs: number;
  breakRemainingMs: number | null;
}

export interface SectionQuestionsView {
  sectionIndex: number;
  /** Matches CandidateQuestion in the API contract: `caseKey` is a per-attempt label, never a database id. */
  questions: Array<Omit<CandidateQuestion, 'caseSetId'> & { ordinal: number; caseKey: string | null }>;
  savedAnswers: Array<{ ordinal: number; selectedOptionIds: string[]; flagged: boolean; clientSeq: number }>;
  /** Scenarios of the case studies in this section, keyed by the same per-attempt labels as `caseKey`. */
  caseStudies: Record<
    string,
    { title: string; scenario: string; firstOrdinal: number; lastOrdinal: number; exhibits: CandidateQuestion['exhibits'] }
  >;
}

export class MockExamService {
  private readonly store: ExamStore;
  private readonly config: ServiceConfig;

  constructor(store: ExamStore, config: Partial<ServiceConfig> = {}) {
    this.store = store;
    this.config = { ...DEFAULT_SERVICE_CONFIG, ...config };
  }

  /** Generates a compliant exam, stores it and starts the clock. */
  async start(userId: string, nowMs: number, seed: number): Promise<AttemptView> {
    const active = await this.store.activeBlueprint(this.config.blueprintCode);
    if (!active) throw new MockExamError('no_active_blueprint');
    const questions = await this.store.pool(active.id);
    const pool = new Map(questions.map((q) => [q.id, q]));
    const recent = await this.store.recentQuestionIds(userId, this.config.excludeRecentAttempts);

    // Prefer an exam without recently seen questions; fall back to the whole
    // bank rather than refuse the candidate a mock.
    let generated = generateExam(active.blueprint, pool, { seed, excludeQuestionIds: new Set(recent) });
    if (!generated.ok && recent.length > 0) generated = generateExam(active.blueprint, pool, { seed });
    if (!generated.ok) throw new MockExamError('exam_generation_failed', generated.violations);

    const state = startAttempt(active.blueprint, generated.form, nowMs);
    const attemptId = await this.store.createAttempt(userId, active.id, generated.form, state);
    return this.view(attemptId, active.blueprint.sections, generated.form.items, state, nowMs);
  }

  async status(userId: string, attemptId: string, nowMs: number): Promise<AttemptView> {
    const a = await this.touch(userId, attemptId, nowMs);
    return this.view(a.attemptId, a.blueprint.sections, a.form.items, a.state, nowMs);
  }

  /** Questions of the open section, without keys, plus the candidate's saved state. */
  async questions(userId: string, attemptId: string, nowMs: number): Promise<SectionQuestionsView> {
    const a = await this.touch(userId, attemptId, nowMs);
    if (a.state.status === 'on_break') throw new MockExamError('on_break');
    if (a.state.status !== 'in_progress') throw new MockExamError('not_active');
    const pool = poolMap(a.pool);
    const flags = new Set(a.state.flags);
    const ordinals = visibleOrdinals(a.state, a.form);
    // Case studies are named per attempt ("case-1", ...) so no database id leaves the server.
    const caseKeys = new Map<string, string>();
    const caseKey = (id: string | null): string | null => {
      if (id === null) return null;
      if (!caseKeys.has(id)) caseKeys.set(id, `case-${caseKeys.size + 1}`);
      return caseKeys.get(id)!;
    };
    const questions = ordinals.map((ordinal) => {
      const view = toCandidateQuestion(pool.get(a.form.items[ordinal - 1]!.questionId)!);
      const { caseSetId, ...rest } = view;
      return { ordinal, ...rest, caseKey: caseKey(caseSetId) };
    });
    const caseStudies: SectionQuestionsView['caseStudies'] = {};
    if (caseKeys.size > 0) {
      const found = new Map((await this.store.caseStudies([...caseKeys.keys()])).map((c) => [c.id, c]));
      // In the order candidates meet them: case-1, case-2, ...
      for (const [id, key] of caseKeys) {
        const c = found.get(id);
        if (!c) continue;
        const ords = questions.filter((q) => q.caseKey === key).map((q) => q.ordinal);
        caseStudies[key] = { title: c.title, scenario: c.scenario, firstOrdinal: Math.min(...ords), lastOrdinal: Math.max(...ords), exhibits: toCandidateExhibits(c.exhibits ?? []) };
      }
    }
    return {
      sectionIndex: a.state.currentSection,
      questions,
      caseStudies,
      savedAnswers: ordinals
        .filter((o) => a.state.answers[o] || flags.has(o))
        .map((o) => ({
          ordinal: o,
          selectedOptionIds: a.state.answers[o]?.selected ?? [],
          flagged: flags.has(o),
          clientSeq: a.state.answers[o]?.clientSeq ?? 0,
        })),
    };
  }

  async saveAnswer(
    userId: string,
    attemptId: string,
    input: SaveAnswerInput,
    nowMs: number,
  ): Promise<{ staleIgnored: boolean; remainingMs: number }> {
    const state = await this.change(
      userId,
      attemptId,
      nowMs,
      (a) => saveAnswer(a.state, a.form, poolMap(a.pool), input, nowMs, this.config.session),
      input.ordinal,
    );
    return { staleIgnored: state.note === 'stale_ignored', remainingMs: remainingMs(state.state, nowMs, this.config.session) };
  }

  async setFlag(userId: string, attemptId: string, ordinal: number, flagged: boolean, nowMs: number): Promise<void> {
    await this.change(userId, attemptId, nowMs, (a) => setFlag(a.state, a.form, ordinal, flagged, nowMs, this.config.session));
  }

  async review(userId: string, attemptId: string, sectionIndex: number, nowMs: number): Promise<SectionReview> {
    const a = await this.touch(userId, attemptId, nowMs);
    return sectionReview(a.state, a.form, sectionIndex);
  }

  async closeSection(userId: string, attemptId: string, nowMs: number): Promise<AttemptView> {
    await this.change(userId, attemptId, nowMs, (a) => closeSection(a.state, a.blueprint, nowMs, this.config.session));
    return this.status(userId, attemptId, nowMs);
  }

  async resume(userId: string, attemptId: string, nowMs: number): Promise<AttemptView> {
    await this.change(userId, attemptId, nowMs, (a) => resumeFromBreak(a.state, nowMs, this.config.session));
    return this.status(userId, attemptId, nowMs);
  }

  /** Final submission: closes the attempt, scores it and stores the result. */
  async submit(userId: string, attemptId: string, nowMs: number): Promise<StoredResult> {
    await this.change(userId, attemptId, nowMs, (a) => submit(a.state, nowMs, this.config.session));
    return this.result(userId, attemptId, nowMs);
  }

  /** Result of a finished attempt. An attempt that ran out of time is scored on first access. */
  async result(userId: string, attemptId: string, nowMs: number): Promise<StoredResult> {
    const a = await this.touch(userId, attemptId, nowMs);
    if (!a.result) throw new MockExamError('not_finished');
    return a.result;
  }

  // ------------------------------------------------------------------ internals

  private async load(userId: string, attemptId: string): Promise<LoadedAttempt> {
    const a = await this.store.loadAttempt(attemptId, userId);
    if (!a) throw new MockExamError('attempt_not_found');
    return a;
  }

  /**
   * Loads an attempt and applies time-based transitions (break over, deadline
   * passed). A finished attempt that has no result yet is scored here, so
   * expiry is handled the same way whichever request notices it first.
   */
  private async touch(userId: string, attemptId: string, nowMs: number): Promise<LoadedAttempt> {
    for (let i = 0; i <= this.config.maxWriteRetries; i++) {
      const a = await this.load(userId, attemptId);
      if (a.result) return a;
      const advanced = advance(a.state, nowMs, this.config.session);
      if (JSON.stringify(advanced) === JSON.stringify(a.state) && !isFinished(advanced)) return a;
      if (isFinished(advanced)) {
        await this.finalize(a, advanced);
        continue; // reload to pick up the stored result
      }
      if (await this.store.saveProgress(attemptId, advanced, a.version)) {
        return { ...a, state: advanced, version: a.version + 1 };
      }
    }
    throw new MockExamError('conflict');
  }

  /** Applies one session rule and stores the outcome, retrying if another request got in first. */
  private async change(
    userId: string,
    attemptId: string,
    nowMs: number,
    apply: (a: LoadedAttempt) => SessionResult,
    ordinal?: number,
  ): Promise<Extract<SessionResult, { ok: true }>> {
    for (let i = 0; i <= this.config.maxWriteRetries; i++) {
      const a = await this.load(userId, attemptId);
      if (a.result) throw new MockExamError('already_finished');
      const outcome = apply(a);

      if (isFinished(outcome.state)) {
        await this.finalize(a, outcome.state);
        if (outcome.ok) return outcome;
        throw new MockExamError(outcome.code);
      }
      // Store even a refused change: time may have moved the state on.
      const stored = await this.store.saveProgress(attemptId, outcome.state, a.version, outcome.ok ? ordinal : undefined);
      if (!stored) continue;
      if (outcome.ok) return outcome;
      throw new MockExamError(outcome.code);
    }
    throw new MockExamError('conflict');
  }

  private async finalize(a: LoadedAttempt, finished: AttemptState): Promise<void> {
    const result = scoreAttempt(a.blueprint, a.form, poolMap(a.pool), toResponses(finished));
    await this.store.finalizeAttempt(a.attemptId, finished, result);
  }

  private view(
    attemptId: string,
    sections: LoadedAttempt['blueprint']['sections'],
    items: LoadedAttempt['form']['items'],
    state: AttemptState,
    nowMs: number,
  ): AttemptView {
    return {
      attemptId,
      status: state.status,
      currentSection: state.currentSection,
      sections: sections.map((s, i) => ({
        state: state.sections[i]!.state,
        kind: s.kind,
        questionCount: s.questionCount,
        firstOrdinal: items.find((item) => item.sectionIndex === i)?.ordinal ?? 0,
      })),
      remainingMs: remainingMs(state, nowMs, this.config.session),
      breakRemainingMs:
        state.status === 'on_break' && state.breakEndsAtMs !== null ? Math.max(0, state.breakEndsAtMs - nowMs) : null,
    };
  }
}

function isFinished(state: AttemptState): boolean {
  return state.status === 'submitted' || state.status === 'expired';
}

function poolMap(questions: Question[]): Map<string, Question> {
  return new Map(questions.map((q) => [q.id, q]));
}
