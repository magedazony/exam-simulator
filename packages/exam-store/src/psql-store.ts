// PostgreSQL implementation of the ExamStore port.
//
// Every call goes through a SqlRunner. In production that is PgPool
// (pg-wire.ts): pooled connections speaking the PostgreSQL protocol. Without
// one, calls fall back to the `psql` command, one process per call, which is
// only for tests, scripts and local tooling.
//
// Connection settings come from the standard PG* environment variables.

import { execFile, execFileSync } from 'node:child_process';
import type { SqlRunner } from './pg-wire.ts';
import { randomBytes } from 'node:crypto';
import type { AttemptResult, AttemptState, ExamForm, Question } from '../../exam-engine/src/index.ts';
import { ActiveAttemptExistsError } from './ports.ts';
import type { ExamStore, LoadedAttempt, StoredBlueprint } from './ports.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SQL literals. Every value is validated or dollar-quoted; nothing is concatenated raw. */
export const lit = {
  uuid(value: string): string {
    if (!UUID.test(value)) throw new Error('invalid uuid');
    return `'${value}'::uuid`;
  },
  int(value: number): string {
    if (!Number.isSafeInteger(value)) throw new Error('invalid integer');
    return String(value);
  },
  text(value: string): string {
    return lit.dollar(value);
  },
  json(value: unknown): string {
    return `${lit.dollar(JSON.stringify(value))}::jsonb`;
  },
  dollar(body: string): string {
    let tag: string;
    do {
      tag = `q${randomBytes(6).toString('hex')}`;
    } while (body.includes(tag));
    return `$${tag}$${body}$${tag}$`;
  },
};

/** Runs SQL through the psql command. Tests, scripts and local tooling only. */
export function psqlRunner(env: NodeJS.ProcessEnv = process.env): SqlRunner {
  return {
    run: (sql) =>
      new Promise((resolve, reject) => {
        const child = execFile(
          'psql',
          ['-qAtX', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
          { env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error) reject(Object.assign(error, { stderr }));
            else resolve(String(stdout).trim());
          },
        );
        child.stdin?.end(sql);
      }),
  };
}

export class PsqlStore implements ExamStore {
  private readonly env: NodeJS.ProcessEnv;
  private readonly runner: SqlRunner;

  /** Pass a PgPool in production. Without a runner, calls go through psql (tests and scripts only). */
  constructor(runner?: SqlRunner, env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
    this.runner = runner ?? psqlRunner(env);
  }

  /** Runs SQL and returns its single value as text ('' for NULL). */
  run(sql: string): Promise<string> {
    return this.runner.run(sql);
  }

  /**
   * Synchronous psql call, for test assertions and scripts only. It blocks
   * the process; application code must use run().
   */
  query(sql: string): string {
    return execFileSync('psql', ['-qAtX', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
      input: sql,
      env: this.env,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  }

  private async json<T>(sql: string): Promise<T | null> {
    const out = await this.run(sql);
    return out === '' ? null : (JSON.parse(out) as T);
  }

  async activeBlueprint(code: string): Promise<StoredBlueprint | null> {
    return await this.json<StoredBlueprint>(`SELECT active_blueprint(${lit.text(code)});`);
  }

  async pool(blueprintId: string): Promise<Question[]> {
    return await this.json<Question[]>(`SELECT engine_pool(${lit.uuid(blueprintId)});`) ?? [];
  }

  async recentQuestionIds(userId: string, lastAttempts: number): Promise<string[]> {
    return await this.json<string[]>(`SELECT recent_question_ids(${lit.uuid(userId)}, ${lit.int(lastAttempts)});`) ?? [];
  }

  async createAttempt(userId: string, blueprintId: string, form: ExamForm, state: AttemptState): Promise<string> {
    try {
      return await this.run(
        `SELECT create_attempt(${lit.uuid(userId)}, ${lit.uuid(blueprintId)}, ${lit.json(form)}, ${lit.json(state)});`,
      );
    } catch (error) {
      if (String((error as { stderr?: unknown }).stderr ?? error).includes('exam_attempts_one_active')) {
        throw new ActiveAttemptExistsError();
      }
      throw error;
    }
  }

  async loadAttempt(attemptId: string, userId: string): Promise<LoadedAttempt | null> {
    return await this.json<LoadedAttempt>(
      `SELECT la || jsonb_build_object('blueprint', engine_blueprint((la->>'blueprintId')::uuid))
       FROM load_attempt(${lit.uuid(attemptId)}, ${lit.uuid(userId)}) la WHERE la IS NOT NULL;`,
    );
  }

  async saveProgress(
    attemptId: string,
    state: AttemptState,
    expectedVersion: number,
    ordinal?: number,
  ): Promise<boolean> {
    const ord = ordinal === undefined ? 'NULL' : lit.int(ordinal);
    return (
      (await this.run(
        `SELECT save_progress(${lit.uuid(attemptId)}, ${lit.json(state)}, ${lit.int(expectedVersion)}, ${ord});`,
      )) === 't'
    );
  }

  async caseStudies(ids: string[]): Promise<Array<{ id: string; title: string; scenario: string; titleAr?: string; scenarioAr?: string; exhibits?: import('../../exam-engine/src/index.ts').ExhibitRef[] }>> {
    if (ids.length === 0) return [];
    ids.forEach((id) => lit.uuid(id));
    return await this.json(`SELECT case_study_views(${lit.json(ids)});`) ?? [];
  }

  async finalizeAttempt(attemptId: string, state: AttemptState, result: AttemptResult): Promise<boolean> {
    return (
      (await this.run(`SELECT finalize_attempt(${lit.uuid(attemptId)}, ${lit.json(state)}, ${lit.json(result)});`)) === 't'
    );
  }
}
