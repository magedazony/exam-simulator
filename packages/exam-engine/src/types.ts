// Core types for the exam engine. Framework-free so the same code runs inside
// the NestJS backend, in jobs, and in tests.

export type QuestionStatus = 'draft' | 'published' | 'withdrawn';
export type Approach = 'predictive' | 'agile' | 'hybrid';
export type Difficulty = 'easy' | 'medium' | 'hard';

export interface Option {
  id: string;
  text: string;
  /** Never leaves the server before submission. See sanitize.ts. */
  isCorrect: boolean;
  rationale?: string;
}

/** A chart, diagram or table the candidate needs to answer. */
export interface ExhibitRef {
  id: string;
  kind: 'image' | 'table';
  altText: string;
  table?: { header: string[]; rows: string[][] };
}

export interface Question {
  /** Stable identity of the question across versions. */
  id: string;
  /** Immutable published version. Attempts reference this. */
  versionId: string;
  status: QuestionStatus;
  domainId: string;
  taskId: string;
  approach: Approach;
  difficulty: Difficulty;
  /** Question type key. Each type has a scorer registered in scoring.ts. */
  type: string;
  /** True when the question requires reading a chart, diagram or image. */
  graphic?: boolean;
  exhibits?: ExhibitRef[];
  /** Set when the question belongs to a case-study set. */
  caseSetId?: string;
  /** Position of the question inside its case-study set. */
  caseOrdinal?: number;
  stem: string;
  options: Option[];
}

export interface BlueprintTask {
  id: string;
  name: string;
}

export interface BlueprintDomain {
  id: string;
  name: string;
  weightPct: number;
  tasks: BlueprintTask[];
}

export type MixDimension = 'approach' | 'difficulty' | 'type' | 'graphic';

/** Share of the exam that questions matching `keys` on `dimension` must hold. */
export interface MixRule {
  dimension: MixDimension;
  keys: string[];
  targetPct: number;
  tolerancePct: number;
  /** 'official' = stated in the PMI outline; 'house' = our own setting. */
  source: 'official' | 'house';
}

export interface BlueprintSection {
  kind: 'case' | 'independent';
  questionCount: number;
  /** Break offered after this section closes. 0 = no break. */
  breakAfterMinutes: number;
}

export interface Blueprint {
  code: string;
  version: number;
  effectiveFrom: string;
  totalQuestions: number;
  durationMinutes: number;
  domains: BlueprintDomain[];
  mixRules: MixRule[];
  /** Every task must appear at least this many times in an exam. */
  minPerTask: number;
  /** Allowed deviation, in questions, from each domain quota. */
  domainToleranceQuestions: number;
  sections: BlueprintSection[];
  scoring: { partialCredit: boolean };
}

export interface ExamItem {
  ordinal: number;
  sectionIndex: number;
  questionId: string;
  versionId: string;
}

export interface ExamForm {
  blueprintCode: string;
  blueprintVersion: number;
  seed: number;
  durationMinutes: number;
  items: ExamItem[];
}

export type GenerateResult =
  | { ok: true; form: ExamForm; attempts: number }
  | { ok: false; violations: string[]; attempts: number };

export interface GenerateOptions {
  seed: number;
  /** Question ids the candidate saw recently and should not see again. */
  excludeQuestionIds?: ReadonlySet<string>;
  maxAttempts?: number;
}
