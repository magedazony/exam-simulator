// Storage used by the HTTP layer on top of the exam store: accounts,
// sessions, practice, results, analytics, staff tools and access. Every call
// is asynchronous and goes through the SqlRunner given to PsqlStore: PgPool
// in production, psql in tests.

import type { Question } from '../../exam-engine/src/index.ts';
import { PsqlStore, lit } from '../../exam-store/src/psql-store.ts';

export class EmailTakenError extends Error {}
export class NoQuestionsMatchError extends Error {}

/** A rule enforced by the database refused a staff action. `code` is lower case, e.g. 'self_review'. */
export class AdminError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'AdminError';
    this.code = code;
  }
}

const ADMIN_MESSAGES: Array<[string, string]> = [
  ['only an approved version can be published', 'state'],
  ['has not passed every review gate', 'gates'],
  ['originality declaration is missing', 'originality'],
  ['authors cannot review their own', 'self_review'],
  ['has no valid answer key', 'key'],
  ['exam_blueprints_code_version_key', 'blueprint_version_exists'],
  ['only a draft blueprint can be activated', 'state'],
  ['blueprint not found', 'not_found'],
  ['plan_prices_store_product_id_key', 'product_in_use'],
];

export interface UserRecord {
  id: string;
  passwordHash: string;
  totpEnabled: boolean;
  emailVerifiedAt: string | null;
  status: string;
  roles: string[];
}

export interface SessionRecord {
  id: string;
  userId: string;
  familyId: string;
  expiresAt: string;
  revokedAt: string | null;
  mfa: boolean;
}

export interface TotpState {
  enabled: boolean;
  secretEnc: string | null;
  pendingEnc: string | null;
  lastStep: number;
}

export interface PracticeItem {
  question: Question;
  taskName: string;
  answered: boolean;
  response: string[] | null;
}

export interface ReviewRow {
  ordinal: number;
  question: Question;
  selected: string[];
  flagged: boolean;
  correct: boolean;
}

const ts = (iso: string): string => `${lit.text(iso)}::timestamptz`;
const SESSION_JSON =
  "jsonb_build_object('id', id, 'userId', user_id, 'familyId', family_id, 'expiresAt', expires_at, 'revokedAt', revoked_at, 'mfa', mfa)";
const stderr = (e: unknown): string => String((e as { stderr?: unknown }).stderr ?? e);

export class ApiStore extends PsqlStore {
  private async one<T>(sql: string): Promise<T | null> {
    const out = await this.run(sql);
    return out === '' ? null : (JSON.parse(out) as T);
  }

  /** Run a parameterised query and return all rows as typed objects.
   *  Uses PostgreSQL's json_agg so the wire client only needs to handle
   *  a single text result, consistent with the rest of the store. */
  async rows<T>(sql: string, params: (string | number | boolean | null)[] = []): Promise<T[]> {
    // Substitute $1, $2 … with the literal values from params.
    // This is intentionally simple: values are escaped with lit.* helpers
    // from the caller or are plain identifiers. Never call this with
    // untrusted string parameters; use lit.text() first.
    let parameterised = sql;
    for (let i = params.length; i >= 1; i--) {
      const v = params[i - 1];
      let escaped: string;
      if (v === null) escaped = 'NULL';
      else if (typeof v === 'boolean') escaped = v ? 'TRUE' : 'FALSE';
      else if (typeof v === 'number') escaped = String(v);
      else escaped = "'" + String(v).replace(/'/g, "''") + "'";
      parameterised = parameterised.replaceAll('$' + i, escaped);
    }
    // INSERT/UPDATE/DELETE cannot sit inside FROM (...); run them as they are.
    if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(parameterised) && !/\bRETURNING\b/i.test(parameterised)) {
      await this.run(parameterised.trimEnd().replace(/;?$/, ';'));
      return [];
    }
    if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(parameterised)) {
      const out = await this.run(`WITH t AS (${parameterised.trimEnd().replace(/;$/, '')}) SELECT coalesce(json_agg(t), '[]'::json) FROM t;`);
      return (out === '' ? [] : JSON.parse(out)) as T[];
    }
    const wrapped = `SELECT coalesce(json_agg(t), '[]'::json) AS r FROM (${parameterised}) t;`;
    const out = await this.run(wrapped);
    return (out === '' ? [] : JSON.parse(out)) as T[];
  }

  // ---------------------------------------------------------------- accounts

  async createUser(email: string, passwordHash: string, language: string): Promise<string> {
    try {
      const id = await this.run(
        `INSERT INTO users (email, password_hash, language, explanation_language)
         VALUES (${lit.text(email)}, ${lit.text(passwordHash)}, ${lit.text(language)}, ${lit.text(language)}) RETURNING id;`,
      );
      await this.run(`INSERT INTO user_roles (user_id, role_id) VALUES (${lit.uuid(id)}, 1);`);
      return id;
    } catch (e) {
      if (stderr(e).includes('users_email_key')) throw new EmailTakenError();
      throw e;
    }
  }

  async userByEmail(email: string): Promise<UserRecord | null> {
    return await this.one<UserRecord>(
      `SELECT jsonb_build_object('id', u.id, 'passwordHash', u.password_hash, 'emailVerifiedAt', u.email_verified_at,
         'totpEnabled', u.totp_enabled_at IS NOT NULL,
         'status', u.status, 'roles', coalesce((SELECT jsonb_agg(r.code) FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                                                WHERE ur.user_id = u.id), '[]'::jsonb))
       FROM users u WHERE u.email = ${lit.text(email)};`,
    );
  }

  async roles(userId: string): Promise<string[]> {
    return (
      await this.one<string[]>(
        `SELECT coalesce(jsonb_agg(r.code), '[]'::jsonb) FROM user_roles ur JOIN roles r ON r.id = ur.role_id
         JOIN users u ON u.id = ur.user_id WHERE ur.user_id = ${lit.uuid(userId)} AND u.status = 'active';`,
      ) ?? []
    );
  }

  async profile(userId: string): Promise<Record<string, unknown> | null> {
    return await this.one(
      `SELECT jsonb_build_object('id', u.id, 'email', u.email, 'displayName', u.display_name,
         'countryCode', u.country_code, 'language', u.language, 'explanationLanguage', u.explanation_language,
         'examTargetDate', u.exam_target_date, 'weeklyStudyHours', u.weekly_study_hours,
         'roles', coalesce((SELECT jsonb_agg(r.code) FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                            WHERE ur.user_id = u.id), '[]'::jsonb))
       FROM users u WHERE u.id = ${lit.uuid(userId)} AND u.status = 'active';`,
    );
  }

  /** `patch` must already be validated: keys are fixed here, values are quoted. */
  async updateProfile(userId: string, patch: Record<string, string | number | null>): Promise<void> {
    const columns: Record<string, string> = {
      displayName: 'display_name',
      countryCode: 'country_code',
      language: 'language',
      explanationLanguage: 'explanation_language',
      examTargetDate: 'exam_target_date',
      weeklyStudyHours: 'weekly_study_hours',
    };
    const sets: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key];
      if (!column) continue;
      const literal =
        value === null ? 'NULL' : typeof value === 'number' ? lit.int(value) : key === 'examTargetDate' ? `${lit.text(value)}::date` : lit.text(value);
      sets.push(`${column} = ${literal}`);
    }
    if (sets.length === 0) return;
    await this.run(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = ${lit.uuid(userId)};`);
  }

  async markDeleted(userId: string): Promise<void> {
    await this.run(
      `UPDATE users SET status = 'deleted', updated_at = now() WHERE id = ${lit.uuid(userId)};
       UPDATE sessions SET revoked_at = now() WHERE user_id = ${lit.uuid(userId)} AND revoked_at IS NULL;`,
    );
  }

  async saveEmailToken(userId: string, purpose: 'verify' | 'reset', tokenHash: string, expiresAt: string): Promise<void> {
    await this.run(
      `INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at)
       VALUES (${lit.uuid(userId)}, '${purpose}', ${lit.text(tokenHash)}, ${ts(expiresAt)});`,
    );
  }

  /** Marks the token used and returns its user, or null if unknown, used or expired. */
  async consumeEmailToken(purpose: 'verify' | 'reset', tokenHash: string, now: string): Promise<string | null> {
    const id = await this.run(
      `UPDATE email_tokens SET used_at = ${ts(now)}
       WHERE purpose = '${purpose}' AND token_hash = ${lit.text(tokenHash)} AND used_at IS NULL AND expires_at > ${ts(now)}
       RETURNING user_id;`,
    );
    return id === '' ? null : id;
  }

  async audit(actorId: string, action: string, entityType: string, entityId: string, details: Record<string, unknown> = {}): Promise<void> {
    await this.run(`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, after) VALUES (${lit.uuid(actorId)}, ${lit.text(action)}, ${lit.text(entityType)}, ${lit.text(entityId)}, ${lit.json(details)});`);
  }

  async markVerified(userId: string, now: string): Promise<void> {
    await this.run(`UPDATE users SET email_verified_at = coalesce(email_verified_at, ${ts(now)}) WHERE id = ${lit.uuid(userId)};`);
  }

  async setPassword(userId: string, passwordHash: string, now: string): Promise<void> {
    await this.run(
      `UPDATE users SET password_hash = ${lit.text(passwordHash)}, updated_at = now() WHERE id = ${lit.uuid(userId)};
       UPDATE sessions SET revoked_at = ${ts(now)} WHERE user_id = ${lit.uuid(userId)} AND revoked_at IS NULL;`,
    );
  }

  // ---------------------------------------------------------------- sessions

  async createSession(
    userId: string,
    tokenHash: string,
    familyId: string | null,
    device: string | null,
    expiresAt: string,
    mfa: boolean,
  ): Promise<SessionRecord> {
    return (await this.one<SessionRecord>(
      `INSERT INTO sessions (user_id, refresh_token_hash, device_label, expires_at, mfa${familyId ? ', family_id' : ''})
       VALUES (${lit.uuid(userId)}, ${lit.text(tokenHash)}, ${device === null ? 'NULL' : lit.text(device)}, ${ts(expiresAt)}, ${mfa}${familyId ? `, ${lit.uuid(familyId)}` : ''})
       RETURNING ${SESSION_JSON};`,
    ))!;
  }

  async sessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    return await this.one<SessionRecord>(
      `SELECT ${SESSION_JSON} FROM sessions WHERE refresh_token_hash = ${lit.text(tokenHash)};`,
    );
  }

  async sessionActive(sessionId: string): Promise<boolean> {
    return await this.run(`SELECT 1 FROM sessions WHERE id = ${lit.uuid(sessionId)} AND revoked_at IS NULL;`) === '1';
  }

  async revokeSession(sessionId: string, now: string): Promise<void> {
    await this.run(`UPDATE sessions SET revoked_at = ${ts(now)} WHERE id = ${lit.uuid(sessionId)} AND revoked_at IS NULL;`);
  }

  async revokeFamily(familyId: string, now: string): Promise<void> {
    await this.run(`UPDATE sessions SET revoked_at = ${ts(now)} WHERE family_id = ${lit.uuid(familyId)} AND revoked_at IS NULL;`);
  }

  // ---------------------------------------------------------------- practice

  async createPracticeSession(userId: string, blueprintCode: string, mode: string, filters: unknown, count: number): Promise<string> {
    try {
      return await this.run(
        `SELECT create_practice_session(${lit.uuid(userId)}, ${lit.text(blueprintCode)}, ${lit.text(mode)}, ${lit.json(filters)}, ${lit.int(count)});`,
      );
    } catch (e) {
      if (stderr(e).includes('no questions match')) throw new NoQuestionsMatchError();
      throw e;
    }
  }

  async practiceSession(sessionId: string, userId: string): Promise<{ id: string; mode: string; questionCount: number } | null> {
    return await this.one(`SELECT practice_session_json(${lit.uuid(sessionId)}, ${lit.uuid(userId)});`);
  }

  async practiceItem(sessionId: string, userId: string, ordinal: number): Promise<PracticeItem | null> {
    return await this.one<PracticeItem>(`SELECT practice_item(${lit.uuid(sessionId)}, ${lit.uuid(userId)}, ${lit.int(ordinal)});`);
  }

  async recordPracticeAnswer(sessionId: string, userId: string, ordinal: number, selected: string[], correct: boolean, timeMs: number, now: string): Promise<boolean> {
    return (
      await this.run(
        `SELECT record_practice_answer(${lit.uuid(sessionId)}, ${lit.uuid(userId)}, ${lit.int(ordinal)}, ${lit.json(selected)}, ${correct}, ${lit.int(timeMs)}, ${ts(now)});`,
      ) === 't'
    );
  }

  async explanation(versionId: string, language: string): Promise<Record<string, unknown>> {
    return await this.one(`SELECT explanation_json(${lit.uuid(versionId)}, ${lit.text(language)});`) ?? {};
  }

  async practiceSummary(sessionId: string, userId: string): Promise<Record<string, unknown> | null> {
    return await this.one(`SELECT practice_summary(${lit.uuid(sessionId)}, ${lit.uuid(userId)});`);
  }

  // ------------------------------------------------------ results, analytics

  async analytics(userId: string, dimension: string): Promise<unknown[]> {
    return await this.one<unknown[]>(`SELECT user_analytics(${lit.uuid(userId)}, ${lit.text(dimension)});`) ?? [];
  }

  async dashboard(userId: string, now: string): Promise<Record<string, unknown>> {
    return await this.one(`SELECT user_dashboard(${lit.uuid(userId)}, ${ts(now)});`) ?? {};
  }

  async listAttempts(userId: string, limit: number, before: string | null): Promise<Array<Record<string, unknown>>> {
    return (
      await this.one(`SELECT list_attempts(${lit.uuid(userId)}, ${lit.int(limit)}, ${before === null ? 'NULL' : ts(before)});`) ?? []
    );
  }

  async attemptReview(attemptId: string, userId: string, filter: string, after: number, limit: number): Promise<{ items: ReviewRow[] } | null> {
    return await this.one(
      `SELECT attempt_review(${lit.uuid(attemptId)}, ${lit.uuid(userId)}, ${lit.text(filter)}, ${lit.int(after)}, ${lit.int(limit)});`,
    );
  }

  /** True when the user has met this question version in a scored mock or an answered practice item. */
  async hasSeenVersion(userId: string, versionId: string): Promise<boolean> {
    return (
      await this.run(
        `SELECT 1 FROM user_answer_events(${lit.uuid(userId)}) WHERE question_version_id = ${lit.uuid(versionId)}
         UNION SELECT 1 FROM attempt_questions aq JOIN exam_attempts ea ON ea.id = aq.attempt_id
               WHERE ea.user_id = ${lit.uuid(userId)} AND ea.result IS NOT NULL AND aq.question_version_id = ${lit.uuid(versionId)}
         LIMIT 1;`,
      ) === '1'
    );
  }

  async createReport(userId: string, versionId: string, reason: string, comment: string | null): Promise<void> {
    await this.run(
      `INSERT INTO question_reports (user_id, question_version_id, reason, comment)
       VALUES (${lit.uuid(userId)}, ${lit.uuid(versionId)}, ${lit.text(reason)}, ${comment === null ? 'NULL' : lit.text(comment)});`,
    );
  }

  // ---------------------------------------------------------------- two-factor

  async totpState(userId: string): Promise<TotpState> {
    return (await this.one<TotpState>(
      `SELECT jsonb_build_object('enabled', totp_enabled_at IS NOT NULL, 'secretEnc', totp_secret_enc,
         'pendingEnc', totp_pending_enc, 'lastStep', totp_last_step) FROM users WHERE id = ${lit.uuid(userId)};`,
    ))!;
  }

  async setPendingTotp(userId: string, sealed: string): Promise<void> {
    await this.run(`UPDATE users SET totp_pending_enc = ${lit.text(sealed)} WHERE id = ${lit.uuid(userId)} AND totp_enabled_at IS NULL;`);
  }

  async enableTotp(userId: string, step: number, now: string): Promise<void> {
    await this.run(
      `UPDATE users SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_enabled_at = ${ts(now)},
         totp_last_step = ${lit.int(step)}
       WHERE id = ${lit.uuid(userId)} AND totp_pending_enc IS NOT NULL;
       INSERT INTO audit_logs (actor_id, action, entity_type, entity_id) VALUES (${lit.uuid(userId)}, 'user.mfa_enable', 'user', '${userId}');`,
    );
  }

  /** Records a used code's step. False when the step was already used (replay or race). */
  async useTotpStep(userId: string, step: number): Promise<boolean> {
    return (
      await this.run(
        `UPDATE users SET totp_last_step = ${lit.int(step)} WHERE id = ${lit.uuid(userId)} AND totp_last_step < ${lit.int(step)} RETURNING 1;`,
      ) === '1'
    );
  }

  // ---------------------------------------------------------------- staff tools

  private async admin<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      const text = stderr(e);
      const coded = /\bE_([A-Z_]+)\b/.exec(text);
      if (coded) throw new AdminError(coded[1]!.toLowerCase());
      for (const [needle, code] of ADMIN_MESSAGES) if (text.includes(needle)) throw new AdminError(code);
      throw e;
    }
  }

  async adminQuestion(versionId: string): Promise<Record<string, unknown> | null> {
    return await this.one(`SELECT admin_question_json(${lit.uuid(versionId)});`);
  }

  async listQuestions(state: string | null, taskCode: string | null, after: string | null, limit: number): Promise<Array<Record<string, unknown>>> {
    const opt = (v: string | null) => (v === null ? 'NULL' : lit.text(v));
    return await this.one(`SELECT admin_list_questions(${opt(state)}, ${opt(taskCode)}, ${opt(after)}, ${lit.int(limit)});`) ?? [];
  }

  async createDraft(authorId: string, blueprintId: string, doc: Record<string, unknown>): Promise<string> {
    return await this.admin(async () =>
      await this.run(`SELECT create_question_draft(${lit.uuid(authorId)}, ${lit.uuid(blueprintId)}, ${lit.json(doc)});`),
    );
  }

  async updateDraft(versionId: string, actorId: string, isAdmin: boolean, blueprintId: string, doc: Record<string, unknown>): Promise<void> {
    await this.admin(async () =>
      await this.run(
        `SELECT update_question_draft(${lit.uuid(versionId)}, ${lit.uuid(actorId)}, ${isAdmin}, ${lit.uuid(blueprintId)}, ${lit.json(doc)});`,
      ),
    );
  }

  async newVersion(questionId: string, actorId: string): Promise<string> {
    return await this.admin(async () => await this.run(`SELECT new_question_version(${lit.uuid(questionId)}, ${lit.uuid(actorId)});`));
  }

  async transition(
    versionId: string,
    actorId: string,
    action: string,
    comment: string | null,
    checklist: Record<string, unknown> | null,
    originality: boolean,
    isAdmin: boolean,
  ): Promise<string> {
    return await this.admin(async () =>
      await this.run(
        `SELECT transition_question_version(${lit.uuid(versionId)}, ${lit.uuid(actorId)}, ${lit.text(action)},
           ${comment === null ? 'NULL' : lit.text(comment)}, ${checklist === null ? 'NULL' : lit.json(checklist)},
           ${originality}, ${isAdmin});`,
      ),
    );
  }

  async bulkApprovePublish(versionIds: string[], actorId: string): Promise<{ published: string[]; failed: Array<{ id: string; code: string; publicCode: string | null }> }> {
    const arr = versionIds.length ? `ARRAY[${versionIds.map((v) => lit.uuid(v)).join(',')}]::uuid[]` : `ARRAY[]::uuid[]`;
    return await this.admin(async () => (await this.one(`SELECT bulk_approve_publish(${arr}, ${lit.uuid(actorId)});`)) ?? { published: [], failed: [] });
  }

  async exportCases(): Promise<Array<Record<string, any>>> {
    return await this.one(`SELECT admin_export_cases();`) ?? [];
  }

  async exportQuestions(): Promise<Array<Record<string, any>>> {
    return await this.one(`SELECT admin_export_questions();`) ?? [];
  }

  async translateByStem(actorId: string, norms: string[], doc: Record<string, unknown>, applyKey = false): Promise<{ versions: string[]; skipped: number }> {
    return await this.admin(async () =>
      (await this.one<{ versions: string[]; skipped: number }>(
        `SELECT translate_questions_by_stem(${lit.uuid(actorId)}, ${lit.json(norms)}, ${lit.json(doc)}, ${applyKey});`,
      )) ?? { versions: [], skipped: 0 },
    );
  }

  async questionIdByStem(norms: string[]): Promise<string | null> {
    const out = await this.run(`SELECT find_question_by_stem(${lit.json(norms)});`);
    return out === '' ? null : out;
  }

  async updateQuestionByStem(actorId: string, blueprintId: string, norms: string[], doc: Record<string, unknown>): Promise<{ action: string; versionId: string | null }> {
    return await this.admin(async () =>
      (await this.one<{ action: string; versionId: string | null }>(
        `SELECT update_question_by_stem(${lit.uuid(actorId)}, ${lit.uuid(blueprintId)}, ${lit.json(norms)}, ${lit.json(doc)});`,
      )) ?? { action: 'skipped', versionId: null },
    );
  }

  async existingStems(normalized: string[]): Promise<string[]> {
    return await this.one<string[]>(`SELECT existing_stems(${lit.json(normalized)});`) ?? [];
  }

  async questionReports(status: string): Promise<Array<Record<string, unknown>>> {
    return await this.one(`SELECT admin_question_reports(${lit.text(status)});`) ?? [];
  }

  async replaceRecoveryCodes(userId: string, hashes: string[]): Promise<void> {
    await this.run(`SELECT replace_recovery_codes(${lit.uuid(userId)}, ${lit.json(hashes)});`);
  }

  async useRecoveryCode(userId: string, hash: string): Promise<boolean> {
    return await this.run(`SELECT use_recovery_code(${lit.uuid(userId)}, ${lit.text(hash)});`) === 't';
  }

  async createCaseStudy(authorId: string, doc: Record<string, unknown>): Promise<string> {
    return await this.admin(async () => await this.run(`SELECT create_case_study(${lit.uuid(authorId)}, ${lit.json(doc)});`));
  }

  async updateCaseStudy(caseId: string, actorId: string, isAdmin: boolean, doc: Record<string, unknown>): Promise<void> {
    await this.admin(async () =>
      await this.run(`SELECT update_case_study(${lit.uuid(caseId)}, ${lit.uuid(actorId)}, ${isAdmin}, ${lit.json(doc)});`),
    );
  }

  async caseStudy(caseId: string): Promise<Record<string, unknown> | null> {
    return await this.one(`SELECT case_study_json(${lit.uuid(caseId)});`);
  }

  async listCaseStudies(status: string | null): Promise<Array<Record<string, unknown>>> {
    return await this.one(`SELECT list_case_studies(${status === null ? 'NULL' : lit.text(status)});`) ?? [];
  }

  async publishCaseStudy(caseId: string, actorId: string): Promise<void> {
    await this.admin(async () => await this.run(`SELECT publish_case_study(${lit.uuid(caseId)}, ${lit.uuid(actorId)});`));
  }

  async withdrawCaseStudy(caseId: string, actorId: string): Promise<void> {
    await this.admin(async () => await this.run(`SELECT withdraw_case_study(${lit.uuid(caseId)}, ${lit.uuid(actorId)});`));
  }

  async createExhibit(authorId: string, doc: { kind: string; altText: string; mimeType?: string; base64?: string; table?: unknown }): Promise<string> {
    return await this.run(
      `SELECT create_exhibit(${lit.uuid(authorId)}, ${lit.text(doc.kind)}, ${doc.mimeType ? lit.text(doc.mimeType) : 'NULL'},
         ${doc.base64 ? lit.text(doc.base64) : 'NULL'}, ${doc.table ? lit.json(doc.table) : 'NULL'}, ${lit.text(doc.altText)});`,
    );
  }

  async exhibitRefs(ids: string[]): Promise<Array<Record<string, unknown>>> {
    ids.forEach((id) => lit.uuid(id));
    return await this.one(`SELECT exhibit_refs(ARRAY(SELECT jsonb_array_elements_text(${lit.json(ids)})::uuid));`) ?? [];
  }

  async exhibitImage(exhibitId: string): Promise<{ mimeType: string; base64: string; sha256: string } | null> {
    return await this.one(`SELECT exhibit_image(${lit.uuid(exhibitId)});`);
  }

  async findUsers(query: string): Promise<Array<Record<string, unknown>>> {
    return await this.one(`SELECT admin_find_users(${lit.text(query)});`) ?? [];
  }

  async setRoles(userId: string, actorId: string, roles: string[]): Promise<void> {
    await this.admin(async () => await this.run(`SELECT admin_set_roles(${lit.uuid(userId)}, ${lit.uuid(actorId)}, ${lit.json(roles)});`));
  }

  async resetMfa(userId: string, actorId: string): Promise<void> {
    await this.admin(async () => await this.run(`SELECT admin_reset_mfa(${lit.uuid(userId)}, ${lit.uuid(actorId)});`));
  }

  async userAccess(userId: string, now: string): Promise<{ entitled: boolean; planCode: string; endsAt: string | null; practiceUsedToday: number }> {
    return (await this.one(`SELECT user_access(${lit.uuid(userId)}, ${ts(now)});`))!;
  }

  async grantEntitlement(userId: string, planCode: string, source: string, ref: string | null, days: number, now: string, actorId: string | null, note: string | null): Promise<boolean> {
    return await this.admin(async () =>
      await this.run(
        `SELECT grant_entitlement(${lit.uuid(userId)}, ${lit.text(planCode)}, ${lit.text(source)}, ${ref === null ? 'NULL' : lit.text(ref)},
           ${lit.int(days)}, ${ts(now)}, ${actorId === null ? 'NULL' : lit.uuid(actorId)}, ${note === null ? 'NULL' : lit.text(note)});`,
      ) === 't',
    );
  }

  /** Who received the entitlement for a store transaction or code, if anyone. */
  async entitlementOwner(source: string, ref: string): Promise<string | null> {
    const id = await this.run(`SELECT user_id FROM entitlements WHERE source = ${lit.text(source)} AND external_ref = ${lit.text(ref)};`);
    return id || null;
  }

  async createAccessCodes(actorId: string, planCode: string, days: number, hashes: string[], label: string, expiresAt: string | null): Promise<number> {
    return Number(
      await this.admin(async () =>
        await this.run(
          `SELECT create_access_codes(${lit.uuid(actorId)}, ${lit.text(planCode)}, ${lit.int(days)}, ${lit.json(hashes)}, ${lit.text(label)},
             ${expiresAt === null ? 'NULL' : ts(expiresAt)});`,
        ),
      ),
    );
  }

  async redeemAccessCode(userId: string, hash: string, now: string): Promise<Record<string, unknown>> {
    return await this.admin(async () => JSON.parse(await this.run(`SELECT redeem_access_code(${lit.uuid(userId)}, ${lit.text(hash)}, ${ts(now)});`)));
  }

  async plans(region: string): Promise<Array<Record<string, unknown>>> {
    return await this.one(`SELECT plans_json(${lit.text(region)});`) ?? [];
  }

  async adminPlans(): Promise<Array<Record<string, unknown>>> {
    return await this.one(`SELECT admin_plans_json();`) ?? [];
  }

  async setPlanPrice(actorId: string, planCode: string, region: string, currency: string, amountMinor: number, productId: string | null): Promise<void> {
    await this.admin(async () =>
      await this.run(
        `SELECT set_plan_price(${lit.uuid(actorId)}, ${lit.text(planCode)}, ${lit.text(region)}, ${lit.text(currency)}, ${lit.int(amountMinor)},
           ${productId === null ? 'NULL' : lit.text(productId)});`,
      ),
    );
  }

  async planForProduct(productId: string): Promise<{ planCode: string; days: number } | null> {
    return await this.one(`SELECT plan_for_product(${lit.text(productId)});`);
  }

  /** Counts a request against a per-minute limit shared by every app copy. True when over the limit. */
  async rateLimitHit(keyHash: string, now: string, limit: number): Promise<boolean> {
    return (await this.run(`SELECT rate_limit_hit(${lit.text(keyHash)}, ${ts(now)}, ${lit.int(limit)});`)) === 't';
  }

  async userExport(userId: string): Promise<Record<string, unknown>> {
    return (await this.one(`SELECT user_export(${lit.uuid(userId)});`))!;
  }

  async auditPage(actionPrefix: string | null, actorEmail: string | null, before: number | null, limit: number): Promise<Array<Record<string, unknown>>> {
    return (
      (await this.one<Array<Record<string, unknown>>>(
        `SELECT audit_page(${actionPrefix === null ? 'NULL' : lit.text(actionPrefix)}, ${actorEmail === null ? 'NULL' : lit.text(actorEmail)},
           ${before === null ? 'NULL' : lit.int(before)}, ${lit.int(limit)});`,
      )) ?? []
    );
  }

  /** Issues the completion certificate for a finished mock exam (no-op if not finished or already issued). */
  async issueCertificate(attemptId: string): Promise<void> {
    await this.run(`SELECT issue_certificate_if_passed(${lit.uuid(attemptId)});`);
  }

  /** Exam tips sections. allSections = true includes unpublished ones (staff view). */
  async tips(allSections: boolean): Promise<Array<Record<string, unknown>>> {
    return await this.one(`SELECT tips_json(${allSections ? 'true' : 'false'});`) ?? [];
  }

  /** Replaces every exam tips section in one transaction and records it in the audit log. */
  async replaceTips(actorId: string, sections: unknown[]): Promise<void> {
    await this.admin(async () => await this.run(`SELECT replace_tips(${lit.uuid(actorId)}, ${lit.json(sections)});`));
  }

  async listBlueprints(): Promise<Array<Record<string, unknown>>> {
    return await this.one(`SELECT list_blueprints();`) ?? [];
  }

  async engineBlueprintById(blueprintId: string): Promise<Record<string, unknown> | null> {
    return await this.one(`SELECT engine_blueprint(${lit.uuid(blueprintId)}) || jsonb_build_object('status', status)
                     FROM exam_blueprints WHERE id = ${lit.uuid(blueprintId)};`);
  }

  async importBlueprint(doc: unknown): Promise<string> {
    return await this.admin(async () => await this.run(`SELECT import_blueprint(${lit.json(doc)});`));
  }

  async activateBlueprint(blueprintId: string, actorId: string): Promise<void> {
    await this.admin(async () => await this.run(`SELECT activate_blueprint(${lit.uuid(blueprintId)}, ${lit.uuid(actorId)});`));
  }

  // ---------------------------------------------------------------- adaptive learning

  /** Record a question response: task mastery and spaced repetition. The task is found from the question. */
  async recordAdaptiveResponse(userId: string, questionId: string, _taskId: string, correct: boolean, source: string): Promise<void> {
    await this.run(`SELECT record_learning(${lit.uuid(userId)}, ${lit.uuid(questionId)}, ${correct ? 'true' : 'false'}, ${lit.text(source)});`);
  }

  /** Learn from a scored mock exam, once. */
  async learnFromAttempt(attemptId: string): Promise<void> {
    await this.run(`SELECT learn_from_attempt(${lit.uuid(attemptId)});`);
  }

  /** Return task mastery rows sorted weakest first. */
  async taskMastery(userId: string): Promise<Array<Record<string, unknown>>> {
    return (
      (await this.one<Array<Record<string, unknown>>>(
        `SELECT coalesce(jsonb_agg(jsonb_build_object(
          'taskCode', t.code, 'taskName', t.name, 'domainCode', d.code,
          'score', tm.weighted_score, 'attempts', tm.attempts,
          'correct', tm.correct, 'nextReviewAt', tm.next_review_at
        ) ORDER BY tm.weighted_score ASC), '[]'::jsonb)
        FROM task_mastery tm
        JOIN tasks t ON t.id = tm.task_id
        JOIN domains d ON d.id = t.domain_id
        WHERE tm.user_id = ${lit.uuid(userId)};`,
      )) ?? []
    );
  }

  /** Count of spaced-review items currently due. */
  async spacedReviewsDue(userId: string, now: string): Promise<number> {
    const r = await this.run(
      `SELECT count(*) FROM spaced_state WHERE user_id = ${lit.uuid(userId)} AND next_review_at <= ${ts(now)};`,
    );
    return parseInt(r ?? '0', 10);
  }

  /** Next-best-action recommendation for the dashboard. */
  async nextBestAction(userId: string, now: string): Promise<Record<string, unknown>> {
    return (await this.one(`SELECT next_best_action(${lit.uuid(userId)}, ${ts(now)});`)) ?? { type: 'general', message: 'Keep practising!', action: 'practice', params: {} };
  }

  /** Computed readiness score 0–100. */
  async readinessScore(userId: string): Promise<number> {
    const r = await this.run(`SELECT readiness_score(${lit.uuid(userId)});`);
    return parseFloat(r ?? '0');
  }

  /** Questions due for spaced review for this user, up to `limit`. */
  async spacedReviewQuestions(userId: string, now: string, limit: number): Promise<Array<Record<string, unknown>>> {
    return (
      (await this.one<Array<Record<string, unknown>>>(
        `SELECT coalesce(jsonb_agg(engine_question(qv.id, 'live') ORDER BY ss.next_review_at ASC), '[]'::jsonb)
         FROM spaced_state ss
         JOIN questions q ON q.id = ss.question_id
         JOIN question_versions qv ON qv.question_id = q.id AND qv.workflow_state = 'published'
         WHERE ss.user_id = ${lit.uuid(userId)} AND ss.next_review_at <= ${ts(now)}
         LIMIT ${lit.int(limit)};`,
      )) ?? []
    );
  }

  // ---------------------------------------------------------------- study plan + profile

  /** Generate (or refresh) the weekly study plan. Returns the plan JSON. */
  async generateStudyPlan(userId: string, weekStart: string): Promise<Record<string, unknown>> {
    return (await this.one(`SELECT generate_study_plan(${lit.uuid(userId)}, ${lit.text(weekStart)}::date);`)) ?? {};
  }

  /** Get the current week's study plan (or null if not generated yet). */
  async currentStudyPlan(userId: string, weekStart: string): Promise<Record<string, unknown> | null> {
    return await this.one(
      `SELECT plan_json FROM study_plans WHERE user_id = ${lit.uuid(userId)} AND week_start = ${lit.text(weekStart)}::date;`,
    );
  }

  /** Refresh the learner profile (async-safe: upserts). */
  async refreshLearnerProfile(userId: string): Promise<void> {
    await this.run(`SELECT refresh_learner_profile(${lit.uuid(userId)});`);
  }

  /** Get the current learner profile. */
  async learnerProfile(userId: string): Promise<Record<string, unknown> | null> {
    return await this.one(`
      SELECT jsonb_build_object(
        'readinessScore', lp.readiness_score,
        'predictedPassPct', lp.predicted_pass_pct,
        'totalQuestionsSeen', lp.total_questions_seen,
        'studyStreakDays', lp.study_streak_days,
        'lastStudiedAt', lp.last_studied_at,
        'dominantErrorType', lp.dominant_error_type,
        'strongestTask', (SELECT jsonb_build_object('code', t.code, 'name', t.name) FROM tasks t WHERE t.id = lp.strongest_task_id),
        'weakestTask', (SELECT jsonb_build_object('code', t.code, 'name', t.name) FROM tasks t WHERE t.id = lp.weakest_task_id),
        'profileAt', lp.profile_at
      ) FROM learner_profiles lp WHERE lp.user_id = ${lit.uuid(userId)};
    `);
  }

  /** Error type distribution for a user. */
  async errorDistribution(userId: string): Promise<Array<Record<string, unknown>>> {
    return (await this.one<Array<Record<string, unknown>>>(`SELECT error_summary(${lit.uuid(userId)});`)) ?? [];
  }

  /** Classify a wrong answer by simple rules and record it. Returns the error type, or null. */
  async recordAnswerError(userId: string, versionId: string, selected: string[], correct: boolean, timeMs: number, source: string): Promise<string | null> {
    if (correct) return null;
    return await this.one<string | null>(
      `SELECT to_jsonb(record_answer_error(${lit.uuid(userId)}, ${lit.uuid(versionId)}, ${lit.json(selected)}, false, ${lit.int(timeMs)}, ${lit.text(source)}));`);
  }

  /** Classify errors for a batch of responses (from the API). */
  async classifyErrors(userId: string, rows: unknown[]): Promise<void> {
    await this.run(`SELECT classify_errors(${lit.uuid(userId)}, ${lit.json(rows)});`);
  }

  // ---------------------------------------------------------------- bookmarks + notes

  async toggleBookmark(userId: string, questionId: string): Promise<{ bookmarked: boolean }> {
    const exists = await this.run(
      `SELECT 1 FROM question_bookmarks WHERE user_id = ${lit.uuid(userId)} AND question_id = ${lit.uuid(questionId)};`,
    );
    if (exists === '1') {
      await this.run(`DELETE FROM question_bookmarks WHERE user_id = ${lit.uuid(userId)} AND question_id = ${lit.uuid(questionId)};`);
      return { bookmarked: false };
    } else {
      await this.run(`INSERT INTO question_bookmarks (user_id, question_id) VALUES (${lit.uuid(userId)}, ${lit.uuid(questionId)}) ON CONFLICT DO NOTHING;`);
      return { bookmarked: true };
    }
  }

  async listBookmarks(userId: string, limit: number, after: string | null): Promise<Array<Record<string, unknown>>> {
    const afterParam = after ? lit.text(after) + '::timestamptz' : 'NULL';
    return (await this.one<Array<Record<string, unknown>>>(
      `SELECT bookmarked_questions(${lit.uuid(userId)}, ${lit.int(limit)}, ${afterParam});`,
    )) ?? [];
  }

  async upsertNote(userId: string, questionId: string, content: string): Promise<Record<string, unknown>> {
    return (await this.one(
      `INSERT INTO question_notes (user_id, question_id, content)
       VALUES (${lit.uuid(userId)}, ${lit.uuid(questionId)}, ${lit.text(content)})
       ON CONFLICT (user_id, question_id) DO UPDATE SET content = EXCLUDED.content, updated_at = now()
       RETURNING jsonb_build_object('id', id, 'questionId', question_id, 'content', content, 'updatedAt', updated_at);`,
    ))!;
  }

  async getNote(userId: string, questionId: string): Promise<Record<string, unknown> | null> {
    return await this.one(
      `SELECT jsonb_build_object('id', id, 'questionId', question_id, 'content', content, 'updatedAt', updated_at)
       FROM question_notes WHERE user_id = ${lit.uuid(userId)} AND question_id = ${lit.uuid(questionId)};`,
    );
  }

  async deleteNote(userId: string, questionId: string): Promise<void> {
    await this.run(`DELETE FROM question_notes WHERE user_id = ${lit.uuid(userId)} AND question_id = ${lit.uuid(questionId)};`);
  }

  // ---------------------------------------------------------------- case studies + AI coach + subscriptions

  /** Get a published case set with its questions. */
  async caseSet(caseId: string): Promise<Record<string, unknown> | null> {
    return await this.one(`SELECT case_set_json(${lit.uuid(caseId)});`);
  }

  /** List published case studies. */
  async listCaseSets(limit: number): Promise<Array<Record<string, unknown>>> {
    return (await this.one<Array<Record<string, unknown>>>(
      `SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', cs.id, 'publicCode', cs.public_code, 'title', cs.title, 'titleAr', cs.title_ar,
        'language', cs.language, 'questionCount',
        (SELECT count(*) FROM question_versions qv WHERE qv.case_study_id = cs.id AND qv.workflow_state = 'published')
      ) ORDER BY cs.created_at DESC), '[]'::jsonb)
      FROM case_studies cs WHERE cs.status = 'published'
      LIMIT ${lit.int(limit)};`,
    )) ?? [];
  }

  /** Record a coach hint request. Returns whether user is under daily quota. */
  async recordCoachHint(userId: string, questionId: string, hintType: string, now: string): Promise<{ allowed: boolean; usedToday: number }> {
    const usedStr = await this.run(`SELECT hints_today(${lit.uuid(userId)}, ${ts(now)});`);
    const usedToday = parseInt(usedStr ?? '0', 10);
    // Free plan limit: 3 per day; pass holders: unlimited
    const userAccess = await this.one<{ entitled: boolean }>(`SELECT user_access(${lit.uuid(userId)}, ${ts(now)});`);
    const limit = userAccess?.entitled ? 9999 : 3;
    if (usedToday >= limit) return { allowed: false, usedToday };
    await this.run(
      `INSERT INTO coach_hint_requests (user_id, question_id, hint_type) VALUES (${lit.uuid(userId)}, ${lit.uuid(questionId)}, ${lit.text(hintType)});`,
    );
    return { allowed: true, usedToday: usedToday + 1 };
  }

  /** Restore a purchase by transaction ID. */
  async restorePurchase(userId: string, transactionId: string, productId: string, now: string): Promise<Record<string, unknown>> {
    return (await this.one(
      `SELECT restore_purchase(${lit.uuid(userId)}, ${lit.text(transactionId)}, ${lit.text(productId)}, ${ts(now)});`,
    )) ?? { status: 'error' };
  }

  // ---------------------------------------------------------------- enhanced analytics

  async analyticsDomainBreakdown(userId: string): Promise<Array<Record<string, unknown>>> {
    return (await this.one<Array<Record<string, unknown>>>(`SELECT analytics_domain_breakdown(${lit.uuid(userId)});`)) ?? [];
  }

  async analyticsDifficultyBreakdown(userId: string): Promise<Array<Record<string, unknown>>> {
    return (await this.one<Array<Record<string, unknown>>>(`SELECT analytics_difficulty_breakdown(${lit.uuid(userId)});`)) ?? [];
  }

  /** Questions targeting a specific weak task (adaptive selection). */
  async adaptiveQuestions(userId: string, taskCode: string | null, limit: number): Promise<Array<Record<string, unknown>>> {
    const taskFilter = taskCode
      ? `AND t.code = ${lit.text(taskCode)}`
      : `AND t.id = (SELECT task_id FROM task_mastery WHERE user_id = ${lit.uuid(userId)} ORDER BY weighted_score ASC LIMIT 1)`;
    return (
      (await this.one<Array<Record<string, unknown>>>(
        `SELECT coalesce(jsonb_agg(engine_question(qv.id, 'live') ORDER BY random()), '[]'::jsonb)
         FROM question_versions qv
         JOIN tasks t ON t.id = qv.task_id
         WHERE qv.workflow_state = 'published'
           ${taskFilter}
           AND qv.question_id NOT IN (
             SELECT question_id FROM spaced_state
             WHERE user_id = ${lit.uuid(userId)} AND next_review_at > now()
           )
         LIMIT ${lit.int(limit)};`,
      )) ?? []
    );
  }

  /** Diagnostic mode: one question per task to assess baseline. */
  async diagnosticQuestions(userId: string, limit: number): Promise<Array<Record<string, unknown>>> {
    return (
      (await this.one<Array<Record<string, unknown>>>(
        `SELECT coalesce(jsonb_agg(engine_question(qv.id, 'live') ORDER BY random()), '[]'::jsonb)
         FROM (
           SELECT DISTINCT ON (qv.task_id) qv.id
           FROM question_versions qv
           WHERE qv.workflow_state = 'published'
             AND qv.task_id NOT IN (
               SELECT task_id FROM task_mastery
               WHERE user_id = ${lit.uuid(userId)} AND attempts >= 1
             )
           ORDER BY qv.task_id, random()
         ) sub
         JOIN question_versions qv ON qv.id = sub.id
         LIMIT ${lit.int(limit)};`,
      )) ?? []
    );
  }

  // ---------------------------------------------------------------- Notifications
  async listNotifications(userId: string, limit: number, unreadOnly: boolean): Promise<Array<Record<string, unknown>>> {
    const whereRead = unreadOnly ? `AND read_at IS NULL` : '';
    return (
      (await this.one<Array<Record<string, unknown>>>(
        `SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.created_at DESC), '[]'::jsonb)
         FROM (SELECT * FROM notifications
               WHERE user_id = ${lit.uuid(userId)} ${whereRead}
               ORDER BY created_at DESC LIMIT ${lit.int(limit)}) n;`,
      )) ?? []
    );
  }

  async markNotificationRead(userId: string, notificationId: string): Promise<void> {
    await this.run(
      `UPDATE notifications SET read_at = now()
       WHERE id = ${lit.uuid(notificationId)} AND user_id = ${lit.uuid(userId)} AND read_at IS NULL;`,
    );
  }

  async markAllNotificationsRead(userId: string): Promise<void> {
    await this.run(
      `UPDATE notifications SET read_at = now()
       WHERE user_id = ${lit.uuid(userId)} AND read_at IS NULL;`,
    );
  }

  // ---------------------------------------------------------------- Exam heartbeat
  async recordHeartbeat(userId: string, attemptId: string, timeRemainingMs: number | null, now: number): Promise<void> {
    // Update the attempt's last_heartbeat_at so server-side expiry jobs can detect abandonment.
    await this.run(
      `UPDATE exam_attempts
       SET last_heartbeat_at = to_timestamp(${lit.int(Math.floor(now / 1000))}),
           time_remaining_ms = CASE WHEN ${timeRemainingMs === null ? 'false' : 'true'} THEN ${lit.int(timeRemainingMs ?? 0)} ELSE time_remaining_ms END
       WHERE id = ${lit.uuid(attemptId)} AND user_id = ${lit.uuid(userId)} AND state = 'in_progress';`,
    );
  }

  // ---------------------------------------------------------------- Referral & coupons
  async referralCode(userId: string): Promise<Record<string, unknown>> {
    // Returns the user's referral code, creating it on first use.
    const select = `SELECT jsonb_build_object('id', id, 'code', code, 'created_at', created_at,
                      'uses_count', uses_count, 'credits_earned', credits_earned)
                    FROM referral_codes WHERE user_id = ${lit.uuid(userId)};`;
    const row = await this.one<Record<string, unknown>>(select);
    if (row) return row;
    const suffix = userId.replace(/-/g, '').slice(0, 8).toUpperCase();
    await this.run(
      `INSERT INTO referral_codes (user_id, code) VALUES (${lit.uuid(userId)}, ${lit.text(`PMP-${suffix}`)})
       ON CONFLICT (user_id) DO NOTHING;`,
    );
    return (await this.one<Record<string, unknown>>(select)) ?? { code: `PMP-${suffix}`, uses_count: 0, credits_earned: 0 };
  }

  async applyCoupon(userId: string, code: string, now: number): Promise<Record<string, unknown>> {
    const coupon = await this.one<{ id: string; discount_pct: number; max_uses: number; uses_count: number; expires_at: string | null }>(
      `SELECT jsonb_build_object('id', id, 'discount_pct', discount_pct, 'max_uses', max_uses,
                                 'uses_count', uses_count, 'expires_at', expires_at)
       FROM coupons WHERE code = ${lit.text(code)} AND active = true LIMIT 1;`,
    );
    if (!coupon) return { valid: false, reason: 'code_not_found' };
    if (coupon.expires_at && new Date(coupon.expires_at).getTime() < now) return { valid: false, reason: 'expired' };
    if (coupon.max_uses > 0 && coupon.uses_count >= coupon.max_uses) return { valid: false, reason: 'exhausted' };
    // Record application (actual discount applied at payment time).
    await this.run(
      `INSERT INTO coupon_applications (user_id, coupon_id, applied_at)
       VALUES (${lit.uuid(userId)}, ${lit.uuid(coupon.id)}, now())
       ON CONFLICT (user_id, coupon_id) DO NOTHING;`,
    );
    return { valid: true, discountPct: coupon.discount_pct, code };
  }

  // ---------------------------------------------------------------- Streak
  async streakInfo(userId: string, now: number): Promise<Record<string, unknown>> {
    // Days in a row with at least one answer, from stored answers (same rule as the dashboard).
    return (await this.one<Record<string, unknown>>(
      `WITH days AS (SELECT DISTINCT (answered_at AT TIME ZONE 'UTC')::date AS day FROM user_answer_events(${lit.uuid(userId)})),
            runs AS (SELECT day, day - (row_number() OVER (ORDER BY day))::integer AS grp FROM days),
            spans AS (SELECT grp, count(*)::int AS len, max(day) AS last_day FROM runs GROUP BY grp)
       SELECT jsonb_build_object(
         'currentStreak', coalesce((SELECT len FROM spans WHERE last_day >= (${ts(new Date(now).toISOString())} AT TIME ZONE 'UTC')::date - 1
                                    ORDER BY last_day DESC LIMIT 1), 0),
         'longestStreak', coalesce((SELECT max(len) FROM spans), 0),
         'lastActivityDate', (SELECT max(day) FROM days));`,
    )) ?? { currentStreak: 0, longestStreak: 0, lastActivityDate: null };
  }

  /** Task and type of a published question, for the rule-based coach. */
  async coachQuestionMeta(questionId: string): Promise<{ taskCode: string; approach: string; difficulty: string; type: string } | null> {
    return await this.one(
      `SELECT jsonb_build_object('taskCode', t.code, 'approach', qv.approach_code,
         'difficulty', qv.difficulty_code, 'type', qv.type_code)
       FROM question_versions qv JOIN tasks t ON t.id = qv.task_id
       WHERE qv.question_id = ${lit.uuid(questionId)} AND qv.workflow_state = 'published'
       ORDER BY qv.version_no DESC LIMIT 1;`,
    );
  }
}
