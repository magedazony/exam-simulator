// What the mock-exam service needs from storage. The service depends on this
// interface only, so the PostgreSQL adapter can be replaced (for example by
// one built on a connection pool inside the NestJS backend) without touching
// the exam rules.

import type { AttemptResult, AttemptState, Blueprint, ExamForm, ExhibitRef, Question } from '../../exam-engine/src/index.ts';

export interface StoredBlueprint {
  id: string;
  blueprint: Blueprint;
}

export interface LoadedAttempt {
  attemptId: string;
  blueprintId: string;
  blueprint: Blueprint;
  form: ExamForm;
  /** Only the question versions of this attempt, with keys. Server-side only. */
  pool: Question[];
  state: AttemptState;
  /** Increases with every stored change. Passed back to saveProgress. */
  version: number;
  /** Present once the attempt has been scored. */
  result: StoredResult | null;
}

export type StoredResult = Omit<AttemptResult, 'perQuestion'>;

export interface ExamStore {
  activeBlueprint(code: string): Promise<StoredBlueprint | null>;
  /** Every question the generator may consider, with keys. Server-side only. */
  pool(blueprintId: string): Promise<Question[]>;
  recentQuestionIds(userId: string, lastAttempts: number): Promise<string[]>;
  /** Throws ActiveAttemptExistsError when the user already has an unfinished attempt. */
  createAttempt(userId: string, blueprintId: string, form: ExamForm, state: AttemptState): Promise<string>;
  /** Resolves to null when the attempt does not exist or belongs to someone else. */
  loadAttempt(attemptId: string, userId: string): Promise<LoadedAttempt | null>;
  /** Resolves to false when someone else changed the attempt since it was loaded. */
  saveProgress(attemptId: string, state: AttemptState, expectedVersion: number, ordinal?: number): Promise<boolean>;
  /** Title and scenario of case studies, for the questions of an open section. */
  caseStudies(ids: string[]): Promise<Array<{ id: string; title: string; scenario: string; titleAr?: string; scenarioAr?: string; exhibits?: ExhibitRef[] }>>;
  /** Resolves to false when the attempt was already scored. */
  finalizeAttempt(attemptId: string, state: AttemptState, result: AttemptResult): Promise<boolean>;
}

export class ActiveAttemptExistsError extends Error {
  constructor() {
    super('the user already has an active attempt');
    this.name = 'ActiveAttemptExistsError';
  }
}
