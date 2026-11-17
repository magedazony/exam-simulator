// HTTP layer for /api/v1, built on Node's http module with no dependencies.
// It is a reference implementation of the candidate-facing part of
// api/openapi.yaml: it maps requests to the mock-exam service and the store,
// and owns authentication, validation, rate limiting and error format.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { scoreQuestion, toCandidateQuestion } from '../../exam-engine/src/index.ts';
import type { Question } from '../../exam-engine/src/index.ts';
import { ActiveAttemptExistsError } from '../../exam-store/src/ports.ts';
import type { StoredResult } from '../../exam-store/src/ports.ts';
import { MockExamError } from '../../exam-store/src/service.ts';
import type { MockExamService } from '../../exam-store/src/service.ts';
import { adminRoutes } from './admin.ts';
import { AdminError, EmailTakenError, NoQuestionsMatchError } from './api-store.ts';
import { BillingNotConfiguredError, notConfiguredVerifier } from './billing.ts';
import { toArabic } from './messages-ar.ts';
import type { WebFile } from './web.ts';
import type { StoreVerifier } from './billing.ts';
import type { ApiStore } from './api-store.ts';
import {
  hashPassword,
  hashToken,
  newOpaqueToken,
  passwordProblem,
  readReportToken,
  signAccessToken,
  signReportToken,
  verifyAccessToken,
  verifyPassword,
  decryptSecret,
  deriveKey,
  encryptSecret,
  newTotpSecret,
  otpauthUri,
  base32Encode,
  totpStep,
  verifyTotp,
  isRecoveryCode,
  newRecoveryCodes,
  normalizeAccessCode,
  signExhibitUrl,
  verifyExhibitUrl,
} from './auth.ts';
import type { CandidateExhibit } from '../../exam-engine/src/index.ts';
import type { AccessClaims } from './auth.ts';
import { HttpError, invalid, notFound } from './http.ts';
import type { Handler, RouteOptions } from './http.ts';

export interface AppConfig {
  tokenSecret: string;
  accessTtlSeconds: number;
  refreshTtlDays: number;
  blueprintCode: string;
  /** Requests per minute per client on the unauthenticated auth endpoints. */
  authRateLimit: number;
  maxBodyBytes: number;
  /** Shown in authenticator apps. */
  mfaIssuer: string;
  /** Practice questions a day for an account without a pass. */
  freeDailyPractice: number;
  /**
   * Reverse proxies in front of the server that add X-Forwarded-For (for
   * example 1 for Caddy or nginx). 0 trusts no header and uses the socket
   * address. Used for rate limiting and logs.
   */
  trustProxyHops: number;
  /** Send Strict-Transport-Security. Turn on only when the site is served over HTTPS. */
  hsts: boolean;
  /** Public pages and contact shown in the apps. Empty when not set. */
  site: { termsUrl: string; privacyUrl: string; supportEmail: string };
}

export const DEFAULT_APP_CONFIG: Omit<AppConfig, 'tokenSecret'> = {
  accessTtlSeconds: 900,
  refreshTtlDays: 30,
  blueprintCode: 'PMP-ECO',
  authRateLimit: 10,
  /** Large enough for an import of 500 questions, or one 1 MiB image as base64. */
  maxBodyBytes: 2 * 1024 * 1024,
  mfaIssuer: 'Exam Simulator',
  freeDailyPractice: 15,
  trustProxyHops: 0,
  hsts: false,
  site: { termsUrl: '', privacyUrl: '', supportEmail: '' },
};

/** One line per request, for the operator's logs. Holds no tokens, bodies or query strings. */
export interface AccessLogEntry {
  at: string;
  requestId: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  ip: string;
}

export interface Mail {
  to: string;
  purpose: 'verify' | 'reset';
  token: string;
  /** The person's interface language, so the email leads with it. */
  language?: 'en' | 'ar';
}

export interface AppDeps {
  store: ApiStore;
  service: MockExamService;
  /** Current time in milliseconds. Injected so the server clock is testable. */
  now: () => number;
  /** Delivers account emails. The token must never be returned in an API response. Failures are logged, never shown to the user. */
  mailer: (mail: Mail) => void | Promise<void>;
  /** Receives one entry per request. Optional. */
  log?: (entry: AccessLogEntry) => void;
  /** Receives server-side errors, without personal data. Defaults to console.error. */
  logError?: (message: string) => void;
  config: AppConfig;
  /** HTML of the admin panel, served at /admin. Optional. */
  adminPage?: string;
  /** HTML of the candidate web app, served at /app. Optional. */
  candidatePage?: string;
  /** Verifies App Store and Google Play purchases. Defaults to refusing them until configured. */
  billingVerifier?: StoreVerifier;
  /** Public web files (landing page, manifest, service worker, icons), by path. See web.ts. */
  webFiles?: Map<string, WebFile>;
}

const DISCLAIMER =
  'Educational estimate based on practice questions. It is not a prediction or guarantee of the official exam result.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const MODES = ['quick', 'focused', 'weak_areas', 'timed', 'incorrect_only'];
const DIMENSIONS = ['domain', 'task', 'approach', 'difficulty', 'type'];
const REPORT_REASONS = ['wrong_answer', 'ambiguous', 'typo', 'outdated', 'other'];

/** Maps exam rule outcomes to HTTP status codes. */
const SERVICE_STATUS: Record<string, number> = {
  attempt_not_found: 404,
  unknown_ordinal: 404,
  invalid_option: 422,
  too_many_selections: 422,
  no_active_blueprint: 503,
  exam_generation_failed: 503,
};

interface Route {
  method: string;
  pattern: RegExp;
  auth: boolean;
  limited: boolean;
  staff: string[] | null;
  handler: Handler;
}

export function createApp(deps: AppDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const { store, service, config } = deps;
  const iso = (ms = deps.now()): string => new Date(ms).toISOString();
  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Handler, opts: RouteOptions = {}) => {
    const pattern = new RegExp(`^/api/v1${path.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
    routes.push({ method, pattern, auth: opts.auth ?? true, limited: opts.limited ?? false, staff: opts.staff ?? null, handler });
  };
  const totpKey = deriveKey(config.tokenSecret, 'totp-secret');
  const exhibitKey = deriveKey(config.tokenSecret, 'exhibit-url');
  /** Image addresses last 4 hours: long enough for a full mock exam with breaks. */
  const exhibitUrl = (id: string) => signExhibitUrl(id, Math.floor(deps.now() / 1000) + 4 * 3600, exhibitKey);
  const STAFF_ROLES = ['content_author', 'content_reviewer', 'administrator'];
  /** What this account may use now. Staff always have full access, to check content. */
  const access = async (userId: string, roles: string[]) => {
    const a = await store.userAccess(userId, iso());
    const staff = roles.some((r) => STAFF_ROLES.includes(r));
    const entitled = a.entitled || staff;
    return {
      entitled,
      planCode: a.planCode,
      endsAt: a.endsAt,
      freeDailyPractice: config.freeDailyPractice,
      practiceUsedToday: Number(a.practiceUsedToday),
      practiceLeftToday: entitled ? null : Math.max(0, config.freeDailyPractice - Number(a.practiceUsedToday)),
    };
  };
  const verifier = deps.billingVerifier ?? notConfiguredVerifier;
  const present = (list: CandidateExhibit[]) =>
    list.map((e) => (e.kind === 'image' ? { kind: 'image', altText: e.altText, url: exhibitUrl(e.exhibitId) } : e));

  // ------------------------------------------------------------- helpers

  const logError = deps.logError ?? ((m: string) => console.error(m));
  /** Sends in the background: the response does not wait for, or reveal, the mail provider. */
  const sendMail = (mail: Mail) => {
    Promise.resolve()
      .then(() => deps.mailer(mail))
      .catch((e: unknown) => logError(`mail to purpose=${mail.purpose} failed: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown'}`));
  };
  /**
   * Sign-in and sign-up attempts per client per minute, counted in the
   * database so every copy of the app shares the count. Only a hash of the
   * client address and endpoint is stored.
   */
  const rateLimited = (key: string): Promise<boolean> =>
    store.rateLimitHit(hashToken(`rate-limit|${key}`), iso(), config.authRateLimit);

  const str = (body: Record<string, unknown>, field: string, max = 200): string => {
    const v = body[field];
    if (typeof v !== 'string' || v.length === 0 || v.length > max) throw invalid(field, 'must be a non-empty string');
    return v;
  };
  const uuid = (value: string | undefined): string => {
    if (!value || !UUID.test(value)) throw notFound();
    return value;
  };
  const int = (value: string | undefined, min: number, max: number): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw notFound();
    return n;
  };
  const stringList = (body: Record<string, unknown>, field: string, maxItems = 60): string[] => {
    const v = body[field];
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > maxItems || v.some((x) => typeof x !== 'string' || x.length > 64)) {
      throw invalid(field, 'must be a list of strings');
    }
    return v as string[];
  };

  const issueTokens = async (userId: string, roles: string[], familyId: string | null, device: string | null, mfa: boolean) => {
    const refreshToken = newOpaqueToken();
    const expires = iso(deps.now() + config.refreshTtlDays * 86_400_000);
    const session = await store.createSession(userId, hashToken(refreshToken), familyId, device, expires, mfa);
    const exp = Math.floor(deps.now() / 1000) + config.accessTtlSeconds;
    return {
      accessToken: signAccessToken({ sub: userId, sid: session.id, roles, exp, mfa }, config.tokenSecret),
      refreshToken,
      expiresInSeconds: config.accessTtlSeconds,
    };
  };

  const candidate = (q: Question, ordinal: number, taskName: string | null) => {
    const { caseSetId: _hidden, exhibits, ...view } = toCandidateQuestion(q);
    return { ordinal, ...view, exhibits: present(exhibits), caseKey: null, taskName };
  };

  const feedback = async (q: Question, correct: boolean, userId: string, language: string) => {
    const [explMain, explAr] = await Promise.all([
      store.explanation(q.versionId, language),
      language !== 'ar' ? store.explanation(q.versionId, 'ar') : Promise.resolve(null),
    ]);
    const result: Record<string, unknown> = {
      correct,
      correctOptionIds: q.options.filter((o) => o.isCorrect).map((o) => o.id),
      explanation: {
        ...explMain,
        options: q.options.map((o) => {
          const opt: { id: string; isCorrect: boolean; rationale: string; rationaleAr?: string } =
            { id: o.id, isCorrect: o.isCorrect, rationale: o.rationale ?? '' };
          if (o.rationaleAr) opt.rationaleAr = o.rationaleAr;
          return opt;
        }),
      },
      reportToken: signReportToken(q.versionId, userId, config.tokenSecret),
    };
    if (explAr && Object.keys(explAr).length > 0) result.explanationAr = explAr;
    return result;
  };

  const tallies = (group: Record<string, { total: number; answered: number; correct: number; percent: number }>) =>
    Object.entries(group).map(([key, t]) => ({ key, total: t.total, answered: t.answered, correct: t.correct, percent: t.percent }));
  const resultBody = (r: StoredResult) => ({
    overall: { key: 'overall', total: r.overall.total, answered: r.overall.answered, correct: r.overall.correct, percent: r.overall.percent },
    byDomain: tallies(r.byDomain),
    byTask: tallies(r.byTask),
    byApproach: tallies(r.byApproach),
    byDifficulty: tallies(r.byDifficulty),
    byType: tallies(r.byType),
    disclaimer: DISCLAIMER,
  });

  const statusBody = (v: Awaited<ReturnType<MockExamService['status']>>) => ({
    id: v.attemptId,
    status: v.status,
    currentSection: v.currentSection,
    sections: v.sections,
    remainingMs: v.remainingMs,
    breakRemainingMs: v.breakRemainingMs,
    serverTime: iso(),
  });

  const validSelection = (q: Question, selected: string[]): void => {
    const ids = new Set(q.options.map((o) => o.id));
    if (selected.some((id) => !ids.has(id))) throw invalid('selectedOptionIds', 'contains an unknown option');
    const limit = q.type === 'single' ? 1 : q.options.filter((o) => o.isCorrect).length;
    if (new Set(selected).size > limit) throw invalid('selectedOptionIds', `select at most ${limit}`);
  };

  // ---------------------------------------------------------------- auth

  add('POST', '/auth/register', async (c) => {
    const email = str(c.body, 'email', 320).trim();
    if (!EMAIL.test(email)) throw invalid('email', 'must be an email address');
    const problem = passwordProblem(c.body.password);
    if (problem) throw invalid('password', problem);
    if (c.body.acceptTerms !== true) throw invalid('acceptTerms', 'the terms must be accepted');
    const language = c.body.language === 'ar' ? 'ar' : 'en';
    let userId: string;
    try {
      userId = await store.createUser(email, hashPassword(c.body.password as string), language);
    } catch (e) {
      if (e instanceof EmailTakenError) throw new HttpError(409, 'email_taken', 'An account with this email already exists');
      throw e;
    }
    const token = newOpaqueToken();
    await store.saveEmailToken(userId, 'verify', hashToken(token), iso(deps.now() + 86_400_000));
    sendMail({ to: email, purpose: 'verify', token, language: language === 'ar' ? 'ar' : 'en' });
    return { status: 201 };
  }, { auth: false, limited: true });

  add('POST', '/auth/verify-email', async (c) => {
    const userId = await store.consumeEmailToken('verify', hashToken(str(c.body, 'token')), iso());
    if (!userId) throw invalid('token', 'is invalid or has expired');
    await store.markVerified(userId, iso());
    return { status: 204 };
  }, { auth: false, limited: true });

  add('POST', '/auth/login', async (c) => {
    const email = str(c.body, 'email', 320).trim();
    const password = str(c.body, 'password', 128);
    const user = await store.userByEmail(email);
    // Same response for an unknown email and a wrong password.
    if (!user || user.status !== 'active' || !verifyPassword(password, user.passwordHash)) {
      throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');
    }
    if (!user.emailVerifiedAt) throw new HttpError(401, 'email_not_verified', 'Verify your email address before signing in');
    let mfa = false;
    if (user.totpEnabled) {
      if (c.body.otp === undefined) throw new HttpError(401, 'mfa_required', 'Enter the code from your authenticator app');
      if (isRecoveryCode(c.body.otp)) {
        // A recovery code stands in for the authenticator once.
        if (!await store.useRecoveryCode(user.id, hashToken(c.body.otp.trim().toLowerCase()))) {
          throw new HttpError(401, 'invalid_otp', 'The code is not valid or was already used');
        }
      } else {
        const state = await store.totpState(user.id);
        const step = verifyTotp(decryptSecret(state.secretEnc!, totpKey), c.body.otp, deps.now(), state.lastStep);
        if (step === null || !await store.useTotpStep(user.id, step)) {
          throw new HttpError(401, 'invalid_otp', 'The code is not valid or was already used');
        }
      }
      mfa = true;
    }
    const device = typeof c.body.deviceLabel === 'string' ? c.body.deviceLabel.slice(0, 80) : null;
    return { status: 200, body: await issueTokens(user.id, user.roles, null, device, mfa) };
  }, { auth: false, limited: true });

  add('POST', '/auth/refresh', async (c) => {
    const session = await store.sessionByTokenHash(hashToken(str(c.body, 'refreshToken')));
    const denied = new HttpError(401, 'invalid_refresh_token', 'Sign in again');
    if (!session) throw denied;
    if (session.revokedAt) {
      // A used token came back: assume it was stolen and end the whole chain.
      await store.revokeFamily(session.familyId, iso());
      throw denied;
    }
    if (Date.parse(session.expiresAt) <= deps.now()) throw denied;
    const roles = await store.roles(session.userId);
    if (roles.length === 0) throw denied;
    await store.revokeSession(session.id, iso());
    return { status: 200, body: await issueTokens(session.userId, roles, session.familyId, null, session.mfa) };
  }, { auth: false, limited: true });

  add('POST', '/auth/logout', async (c) => {
    await store.revokeSession(c.claims.sid, iso());
    return { status: 204 };
  });

  // Two-factor enrolment. Required for every staff role before staff tools open.
  add('POST', '/auth/mfa/setup', async (c) => {
    if ((await store.totpState(c.claims.sub)).enabled) throw new HttpError(409, 'mfa_already_enabled', 'Two-factor sign-in is already on');
    const secret = newTotpSecret();
    await store.setPendingTotp(c.claims.sub, encryptSecret(secret, totpKey));
    const email = String((await store.profile(c.claims.sub))?.email ?? '');
    return { status: 200, body: { secret: base32Encode(secret), otpauthUri: otpauthUri(secret, email, config.mfaIssuer) } };
  });

  add('POST', '/auth/mfa/enable', async (c) => {
    const state = await store.totpState(c.claims.sub);
    if (state.enabled) throw new HttpError(409, 'mfa_already_enabled', 'Two-factor sign-in is already on');
    if (!state.pendingEnc) throw new HttpError(409, 'mfa_not_started', 'Start two-factor setup first');
    const step = verifyTotp(decryptSecret(state.pendingEnc, totpKey), c.body.code, deps.now(), 0);
    if (step === null) throw invalid('code', 'is not valid');
    await store.enableTotp(c.claims.sub, step, iso());
    const codes = newRecoveryCodes();
    await store.replaceRecoveryCodes(c.claims.sub, codes.map((code) => hashToken(code)));
    // Shown once; only hashes are kept.
    return { status: 200, body: { recoveryCodes: codes } };
  }, { limited: true });

  add('POST', '/auth/mfa/recovery-codes', async (c) => {
    if (c.claims.mfa !== true) throw new HttpError(403, 'mfa_required', 'Sign in with two-factor authentication first');
    const codes = newRecoveryCodes();
    await store.replaceRecoveryCodes(c.claims.sub, codes.map((code) => hashToken(code)));
    return { status: 200, body: { recoveryCodes: codes } };
  });

  add('POST', '/auth/password/reset-request', async (c) => {
    const email = str(c.body, 'email', 320).trim();
    const user = await store.userByEmail(email);
    if (user && user.status === 'active') {
      const token = newOpaqueToken();
      await store.saveEmailToken(user.id, 'reset', hashToken(token), iso(deps.now() + 3_600_000));
      sendMail({ to: email, purpose: 'reset', token });
    }
    return { status: 202 };
  }, { auth: false, limited: true });

  add('POST', '/auth/password/reset', async (c) => {
    const token = str(c.body, 'token');
    const problem = passwordProblem(c.body.newPassword);
    if (problem) throw invalid('newPassword', problem);
    const userId = await store.consumeEmailToken('reset', hashToken(token), iso());
    if (!userId) throw invalid('token', 'is invalid or has expired');
    await store.setPassword(userId, hashPassword(c.body.newPassword as string), iso());
    await store.markVerified(userId, iso());
    return { status: 204 };
  }, { auth: false, limited: true });

  // ------------------------------------------------------------- profile

  add('GET', '/me', async (c) => ({ status: 200, body: await store.profile(c.claims.sub) }));

  add('PATCH', '/me', async (c) => {
    const patch: Record<string, string | number | null> = {};
    const b = c.body;
    if (b.displayName !== undefined) patch.displayName = str(b, 'displayName', 80);
    if (b.countryCode !== undefined) {
      const cc = str(b, 'countryCode', 2).toUpperCase();
      if (!/^[A-Z]{2}$/.test(cc)) throw invalid('countryCode', 'must be a two-letter country code');
      patch.countryCode = cc;
    }
    for (const field of ['language', 'explanationLanguage']) {
      if (b[field] === undefined) continue;
      if (b[field] !== 'en' && b[field] !== 'ar') throw invalid(field, 'must be en or ar');
      patch[field] = b[field] as string;
    }
    if (b.examTargetDate !== undefined) {
      if (b.examTargetDate === null) patch.examTargetDate = null;
      else {
        const d = str(b, 'examTargetDate', 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) throw invalid('examTargetDate', 'must be a date (YYYY-MM-DD)');
        patch.examTargetDate = d;
      }
    }
    if (b.weeklyStudyHours !== undefined) {
      const h = b.weeklyStudyHours;
      if (typeof h !== 'number' || !Number.isInteger(h) || h < 0 || h > 100) throw invalid('weeklyStudyHours', 'must be between 0 and 100');
      patch.weeklyStudyHours = h;
    }
    await store.updateProfile(c.claims.sub, patch);
    return { status: 200, body: await store.profile(c.claims.sub) };
  });

  add('DELETE', '/me', async (c) => {
    await store.markDeleted(c.claims.sub);
    return { status: 202 };
  });

  // Everything stored about the signed-in person, as a JSON download (right of access).
  add('GET', '/me/export', async (c) => ({
    status: 200,
    raw: {
      bytes: Buffer.from(JSON.stringify({ exportedAt: iso(), ...(await store.userExport(c.claims.sub)) }, null, 2), 'utf8'),
      contentType: 'application/json; charset=utf-8',
      headers: { 'Content-Disposition': 'attachment; filename="my-exam-simulator-data.json"', 'Cache-Control': 'no-store' },
    },
  }));

  add('GET', '/me/dashboard', async (c) => ({
    status: 200,
    body: { ...await store.dashboard(c.claims.sub, iso()) },
  }));

  add('GET', '/me/analytics', async (c) => {
    const dimension = c.query.get('dimension') ?? '';
    if (!DIMENSIONS.includes(dimension)) throw invalid('dimension', `must be one of ${DIMENSIONS.join(', ')}`);
    return { status: 200, body: { dimension, rows: await store.analytics(c.claims.sub, dimension) } };
  });

  // ------------------------------------------------------------ adaptive learning

  /** GET /me/mastery — task-level mastery scores */
  add('GET', '/me/mastery', async (c) => ({
    status: 200,
    body: { items: await store.taskMastery(c.claims.sub) },
  }));

  /** GET /me/readiness — computed readiness score 0–100 */
  add('GET', '/me/readiness', async (c) => ({
    status: 200,
    body: { score: await store.readinessScore(c.claims.sub) },
  }));

  /** GET /me/spaced-reviews/due — count of items due for review */
  add('GET', '/me/spaced-reviews/due', async (c) => ({
    status: 200,
    body: { count: await store.spacedReviewsDue(c.claims.sub, iso()) },
  }));

  /** GET /me/profile — learner intelligence profile */
  add('GET', '/me/profile', async (c) => {
    // Refresh profile in background
    store.refreshLearnerProfile(c.claims.sub).catch(() => { /* non-fatal */ });
    const profile = await store.learnerProfile(c.claims.sub);
    return { status: 200, body: profile ?? { message: 'No profile yet — answer some questions first.' } };
  });

  /** GET /me/errors — error type distribution */
  add('GET', '/me/errors', async (c) => ({
    status: 200,
    body: { items: await store.errorDistribution(c.claims.sub) },
  }));

  /** POST /me/errors — classify errors for a batch of responses */
  add('POST', '/me/errors', async (c) => {
    const rows = c.body as unknown[];
    if (!Array.isArray(rows) || rows.length === 0) throw invalid('body', 'must be a non-empty array of error records');
    await store.classifyErrors(c.claims.sub, rows);
    return { status: 200, body: { ok: true, classified: rows.length } };
  });

  /** GET /me/study-plan?weekStart=2026-11-17 — current week study plan */
  add('GET', '/me/study-plan', async (c) => {
    const weekStart = c.query.get('weekStart') ?? new Date().toISOString().slice(0, 10);
    // Try existing; generate if missing
    let plan = await store.currentStudyPlan(c.claims.sub, weekStart);
    if (!plan) {
      plan = await store.generateStudyPlan(c.claims.sub, weekStart);
    }
    return { status: 200, body: plan };
  });

  /** POST /me/study-plan/refresh — force regenerate study plan for current week */
  add('POST', '/me/study-plan/refresh', async (c) => {
    const weekStart = new Date().toISOString().slice(0, 10);
    const plan = await store.generateStudyPlan(c.claims.sub, weekStart);
    return { status: 200, body: plan };
  });

  // ------------------------------------------------------------ bookmarks

  /** GET /me/bookmarks — list bookmarked questions */
  add('GET', '/me/bookmarks', async (c) => {
    const limit = Math.min(Number(c.query.get('limit') ?? 20), 100);
    const after = c.query.get('after') ?? null;
    return { status: 200, body: { items: await store.listBookmarks(c.claims.sub, limit, after) } };
  });

  /** POST /me/bookmarks/:questionId — toggle bookmark on/off */
  add('POST', '/me/bookmarks/:questionId', async (c) => {
    const questionId = uuid(c.params.questionId);
    const result = await store.toggleBookmark(c.claims.sub, questionId);
    return { status: 200, body: result };
  });

  // ------------------------------------------------------------ question notes

  /** GET /me/notes/:questionId */
  add('GET', '/me/notes/:questionId', async (c) => {
    const note = await store.getNote(c.claims.sub, uuid(c.params.questionId));
    if (!note) throw notFound();
    return { status: 200, body: note };
  });

  /** PUT /me/notes/:questionId — create or update note */
  add('PUT', '/me/notes/:questionId', async (c) => {
    const content = String((c.body as Record<string, unknown>).content ?? '').trim();
    if (!content || content.length > 2000) throw invalid('content', 'must be 1–2000 characters');
    const note = await store.upsertNote(c.claims.sub, uuid(c.params.questionId), content);
    return { status: 200, body: note };
  });

  /** DELETE /me/notes/:questionId */
  add('DELETE', '/me/notes/:questionId', async (c) => {
    await store.deleteNote(c.claims.sub, uuid(c.params.questionId));
    return { status: 200, body: { ok: true } };
  });

  // ------------------------------------------------------------ enhanced analytics

  /** GET /me/analytics/domains — per-domain accuracy + mastery */
  add('GET', '/me/analytics/domains', async (c) => ({
    status: 200,
    body: { items: await store.analyticsDomainBreakdown(c.claims.sub) },
  }));

  /** GET /me/analytics/difficulty — per-difficulty accuracy */
  add('GET', '/me/analytics/difficulty', async (c) => ({
    status: 200,
    body: { items: await store.analyticsDifficultyBreakdown(c.claims.sub) },
  }));

  /**
   * POST /practice/sessions  (adaptive modes)
   * mode: 'adaptive'       — targets weakest task
   * mode: 'spaced_review'  — questions overdue for review
   * mode: 'diagnostic'     — one question per unseen task (baseline)
   * Falls through to existing session creation for mode: 'standard'
   */
  add('POST', '/practice/adaptive', async (c) => {
    const body = c.body as Record<string, unknown>;
    const mode = String(body.mode ?? 'adaptive');
    const limit = Math.min(Number(body.limit ?? 20), 50);
    const now = iso();
    let questions: Array<Record<string, unknown>>;

    if (mode === 'spaced_review') {
      questions = await store.spacedReviewQuestions(c.claims.sub, now, limit);
    } else if (mode === 'diagnostic') {
      questions = await store.diagnosticQuestions(c.claims.sub, limit);
    } else {
      // 'adaptive' or default: target weakest task
      const taskCode = typeof body.taskCode === 'string' ? body.taskCode : null;
      questions = await store.adaptiveQuestions(c.claims.sub, taskCode, limit);
    }

    if (questions.length === 0) {
      return { status: 200, body: { mode, questions: [], message: 'No questions available for this mode yet. Try standard practice first.' } };
    }
    return { status: 200, body: { mode, questions } };
  });

  /**
   * POST /practice/adaptive/response — record an adaptive response
   * Updates task mastery and spaced-repetition state
   */
  add('POST', '/practice/adaptive/response', async (c) => {
    const body = c.body as Record<string, unknown>;
    const { questionId, taskId, correct, source } = body as {
      questionId: string;
      taskId: string;
      correct: boolean;
      source?: string;
    };
    if (!questionId || !taskId || typeof correct !== 'boolean') throw invalid('body', 'questionId, taskId, and correct are required');
    await store.recordAdaptiveResponse(c.claims.sub, questionId, taskId, correct, source ?? 'adaptive');
    return { status: 200, body: { ok: true } };
  });

  // ------------------------------------------------------------ health

  // For load balancers and monitoring: is the process up and the database reachable?
  add('GET', '/health', async () => {
    const started = Date.now();
    try {
      await Promise.race([store.run('SELECT 1;'), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))]);
      return { status: 200, body: { status: 'ok', database: 'ok', databaseMs: Date.now() - started } };
    } catch {
      return { status: 503, body: { status: 'degraded', database: 'unreachable', databaseMs: Date.now() - started } };
    }
  }, { auth: false });

  add('GET', '/site', async () => ({ status: 200, body: config.site }), { auth: false });

  // ------------------------------------------------------------ access and plans

  add('GET', '/plans', async (c) => {
    const region = c.query.get('region') ?? 'INTL';
    if (!['EG', 'GULF', 'INTL'].includes(region)) throw invalid('region', 'must be EG, GULF or INTL');
    return { status: 200, body: { region, items: await store.plans(region) } };
  }, { auth: false });

  add('GET', '/me/access', async (c) => ({ status: 200, body: await access(c.claims.sub, c.claims.roles) }));

  add('POST', '/me/redeem', async (c) => {
    const code = normalizeAccessCode(str(c.body, 'code', 40));
    if (!/^[A-Z2-7]{12}$/.test(code)) throw invalid('code', 'is not a valid access code');
    try {
      await store.redeemAccessCode(c.claims.sub, hashToken(code), iso());
    } catch (e) {
      if (e instanceof AdminError) {
        const titles: Record<string, string> = { code_invalid: 'This code is not valid', code_used: 'This code was already used', code_expired: 'This code has expired' };
        throw new HttpError(422, e.code, titles[e.code] ?? 'This code cannot be used');
      }
      throw e;
    }
    return { status: 200, body: await access(c.claims.sub, c.claims.roles) };
  }, { limited: true });

  add('POST', '/billing/purchases', async (c) => {
    const platform = c.body.platform;
    if (platform !== 'apple' && platform !== 'google') throw invalid('platform', 'must be apple or google');
    const productId = str(c.body, 'productId', 200);
    const token = str(c.body, 'purchaseToken', 20_000);
    const plan = await store.planForProduct(productId);
    if (!plan) throw invalid('productId', 'is not a product we sell');
    let verified;
    try {
      verified = await verifier.verify(platform, productId, token);
    } catch (e) {
      if (e instanceof BillingNotConfiguredError) throw new HttpError(503, 'store_billing_not_configured', 'In-app purchases are not available yet');
      throw e;
    }
    if (!verified || verified.productId !== productId) throw new HttpError(422, 'purchase_not_valid', 'The store did not confirm this purchase');
    const source = platform === 'apple' ? 'store_apple' : 'store_google';
    const granted = await store.grantEntitlement(c.claims.sub, plan.planCode, source, verified.transactionId, plan.days, iso(), null, null);
    // A purchase already granted is fine when it is this person's (a retry); never to someone else.
    if (!granted && (await store.entitlementOwner(source, verified.transactionId)) !== c.claims.sub) {
      throw new HttpError(409, 'purchase_already_used', 'This purchase was already used by another account');
    }
    try {
      await verifier.complete?.(platform, productId, token);
    } catch (e) {
      // The pass is granted; the app sends the purchase again later and completion is retried.
      logError(`store completion failed for ${platform}: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown'}`);
      throw new HttpError(502, 'store_completion_failed', 'Your pass is active. The store confirmation will be retried automatically');
    }
    return { status: 200, body: await access(c.claims.sub, c.claims.roles) };
  });

  add('GET', '/blueprints/active', async () => {
    const active = await store.activeBlueprint(config.blueprintCode);
    if (!active) throw new HttpError(503, 'no_active_blueprint', 'No exam blueprint is active');
    const b = active.blueprint;
    return {
      status: 200,
      body: {
        code: b.code,
        version: b.version,
        totalQuestions: b.totalQuestions,
        durationMinutes: b.durationMinutes,
        domains: b.domains.map((d) => ({
          code: d.id,
          name: d.name,
          weightPct: d.weightPct,
          tasks: d.tasks.map((t) => ({ code: t.id, name: t.name })),
        })),
        sections: b.sections,
      },
    };
  });

  // ------------------------------------------------------------ practice

  add('POST', '/practice/sessions', async (c) => {
    const mode = str(c.body, 'mode', 20);
    if (!MODES.includes(mode)) throw invalid('mode', `must be one of ${MODES.join(', ')}`);
    const count = c.body.questionCount;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 100) {
      throw invalid('questionCount', 'must be between 1 and 100');
    }
    const acc = await access(c.claims.sub, c.claims.roles);
    let wanted = count;
    if (!acc.entitled) {
      if (acc.practiceLeftToday === 0) {
        throw new HttpError(402, 'daily_limit_reached', 'You have used today’s free practice questions. Unlock full access or come back tomorrow');
      }
      wanted = Math.min(count, acc.practiceLeftToday!);
    }
    const filters = {
      domainCodes: stringList(c.body, 'domainCodes'),
      taskCodes: stringList(c.body, 'taskCodes'),
      approaches: stringList(c.body, 'approaches'),
      difficulties: stringList(c.body, 'difficulties'),
      types: stringList(c.body, 'types'),
    };
    let id: string;
    try {
      id = await store.createPracticeSession(c.claims.sub, config.blueprintCode, mode, filters, wanted);
    } catch (e) {
      if (e instanceof NoQuestionsMatchError) throw new HttpError(409, 'no_questions_match', 'No questions match these filters');
      throw e;
    }
    const session = (await store.practiceSession(id, c.claims.sub))!;
    // 80 seconds a question is the pace of 180 questions in 240 minutes.
    return { status: 201, body: { ...session, timeLimitSeconds: mode === 'timed' ? session.questionCount * 80 : null } };
  });

  add('GET', '/practice/sessions/:sessionId/questions/:ordinal', async (c) => {
    const ordinal = int(c.params.ordinal, 1, 100);
    const item = await store.practiceItem(uuid(c.params.sessionId), c.claims.sub, ordinal);
    if (!item) throw notFound();
    return { status: 200, body: candidate(item.question, ordinal, item.taskName) };
  });

  add('POST', '/practice/sessions/:sessionId/questions/:ordinal/answer', async (c) => {
    const ordinal = int(c.params.ordinal, 1, 100);
    const sessionId = uuid(c.params.sessionId);
    const selected = stringList(c.body, 'selectedOptionIds', 10);
    if (selected.length === 0) throw invalid('selectedOptionIds', 'select at least one option');
    const timeMs = typeof c.body.timeSpentMs === 'number' && Number.isInteger(c.body.timeSpentMs) && c.body.timeSpentMs >= 0
      ? Math.min(c.body.timeSpentMs, 3_600_000) : 0;
    const item = await store.practiceItem(sessionId, c.claims.sub, ordinal);
    if (!item) throw notFound();
    validSelection(item.question, selected);
    const score = scoreQuestion(item.question, selected, false);
    // The answer is stored before anything about the key is returned.
    if (!await store.recordPracticeAnswer(sessionId, c.claims.sub, ordinal, selected, score.correct, timeMs, iso())) {
      throw new HttpError(409, 'already_answered', 'This question was already answered');
    }
    // Update adaptive learning signals (task mastery + spaced repetition)
    // Fire-and-forget: do not block the response on this
    if (item.question.taskId) {
      store.recordAdaptiveResponse(c.claims.sub, item.question.id, item.question.taskId, score.correct, 'practice').catch(() => { /* non-fatal */ });
    }
    return { status: 200, body: await feedback(item.question, score.correct, c.claims.sub, c.language) };
  });

  add('GET', '/practice/sessions/:sessionId/summary', async (c) => {
    const summary = await store.practiceSummary(uuid(c.params.sessionId), c.claims.sub);
    if (!summary) throw notFound();
    return { status: 200, body: { ...summary, disclaimer: DISCLAIMER } };
  });

  // --------------------------------------------------------------- exams

  add('GET', '/exams/attempts', async (c) => {
    const limit = Math.min(Math.max(Number(c.query.get('limit') ?? 20) || 20, 1), 100);
    const cursor = c.query.get('cursor');
    if (cursor !== null && Number.isNaN(Date.parse(cursor))) throw invalid('cursor', 'is not valid');
    const items = await store.listAttempts(c.claims.sub, limit, cursor);
    const last = items[items.length - 1];
    return { status: 200, body: { items, nextCursor: items.length === limit && last ? String(last.startedAt) : null } };
  });

  add('POST', '/exams/attempts', async (c) => {
    if (!(await access(c.claims.sub, c.claims.roles)).entitled) {
      throw new HttpError(402, 'payment_required', 'Full mock exams need a pass');
    }
    const seed = Math.floor(Math.random() * 2 ** 31);
    return { status: 201, body: statusBody(await service.start(c.claims.sub, deps.now(), seed)) };
  });

  add('GET', '/exams/attempts/:attemptId', async (c) => ({
    status: 200,
    body: statusBody(await service.status(c.claims.sub, uuid(c.params.attemptId), deps.now())),
  }));

  add('GET', '/exams/attempts/:attemptId/sections/:sectionIndex/questions', async (c) => {
    const section = int(c.params.sectionIndex, 0, 20);
    const view = await service.questions(c.claims.sub, uuid(c.params.attemptId), deps.now());
    if (view.sectionIndex !== section) throw new HttpError(409, 'section_locked', 'This section is not open');
    const body = {
      ...view,
      questions: view.questions.map((q) => ({ ...q, exhibits: present(q.exhibits) })),
      caseStudies: Object.fromEntries(Object.entries(view.caseStudies).map(([k, c]) => [k, { ...c, exhibits: present(c.exhibits) }])),
    };
    return { status: 200, body };
  });

  add('PUT', '/exams/attempts/:attemptId/answers/:ordinal', async (c) => {
    const attemptId = uuid(c.params.attemptId);
    const ordinal = int(c.params.ordinal, 1, 1000);
    const selected = stringList(c.body, 'selectedOptionIds', 10);
    if (!Array.isArray(c.body.selectedOptionIds)) throw invalid('selectedOptionIds', 'is required (empty list clears the answer)');
    const seq = c.body.clientSeq;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) throw invalid('clientSeq', 'must be a positive integer');
    const saved = await service.saveAnswer(c.claims.sub, attemptId, { ordinal, selected, clientSeq: seq }, deps.now());
    if (typeof c.body.flagged === 'boolean') await service.setFlag(c.claims.sub, attemptId, ordinal, c.body.flagged, deps.now());
    const stored = (await store.loadAttempt(attemptId, c.claims.sub))!.state;
    return {
      status: 200,
      body: {
        saved: {
          ordinal,
          selectedOptionIds: stored.answers[ordinal]?.selected ?? [],
          flagged: stored.flags.includes(ordinal),
          clientSeq: stored.answers[ordinal]?.clientSeq ?? 0,
        },
        staleIgnored: saved.staleIgnored,
        remainingMs: saved.remainingMs,
      },
    };
  });

  add('GET', '/exams/attempts/:attemptId/sections/:sectionIndex/review', async (c) => ({
    status: 200,
    body: await service.review(c.claims.sub, uuid(c.params.attemptId), int(c.params.sectionIndex, 0, 20), deps.now()),
  }));

  add('POST', '/exams/attempts/:attemptId/sections/:sectionIndex/close', async (c) => {
    const attemptId = uuid(c.params.attemptId);
    const section = int(c.params.sectionIndex, 0, 20);
    const current = await service.status(c.claims.sub, attemptId, deps.now());
    if (current.status === 'in_progress' && current.currentSection !== section) {
      throw new HttpError(409, 'section_locked', 'This section is not open');
    }
    return { status: 200, body: statusBody(await service.closeSection(c.claims.sub, attemptId, deps.now())) };
  });

  add('POST', '/exams/attempts/:attemptId/resume', async (c) => ({
    status: 200,
    body: statusBody(await service.resume(c.claims.sub, uuid(c.params.attemptId), deps.now())),
  }));

  add('POST', '/exams/attempts/:attemptId/submit', async (c) => ({
    status: 200,
    body: resultBody(await service.submit(c.claims.sub, uuid(c.params.attemptId), deps.now())),
  }));

  add('GET', '/exams/attempts/:attemptId/result', async (c) => ({
    status: 200,
    body: resultBody(await service.result(c.claims.sub, uuid(c.params.attemptId), deps.now())),
  }));

  add('GET', '/exams/attempts/:attemptId/review', async (c) => {
    const attemptId = uuid(c.params.attemptId);
    // Scores an expired attempt if needed, and refuses while the exam is still running.
    await service.result(c.claims.sub, attemptId, deps.now());
    const filter = c.query.get('filter') ?? 'all';
    if (!['all', 'incorrect', 'flagged', 'unanswered'].includes(filter)) throw invalid('filter', 'is not valid');
    const limit = Math.min(Math.max(Number(c.query.get('limit') ?? 20) || 20, 1), 100);
    const after = Math.max(Number(c.query.get('cursor') ?? 0) || 0, 0);
    const page = await store.attemptReview(attemptId, c.claims.sub, filter, after, limit);
    if (!page) throw notFound();
    const items = await Promise.all(page.items.map(async (row) => ({
      question: candidate(row.question, row.ordinal, null),
      selectedOptionIds: row.selected,
      flagged: row.flagged,
      feedback: await feedback(row.question, row.correct, c.claims.sub, c.language),
    })));
    const last = page.items[page.items.length - 1];
    return { status: 200, body: { items, nextCursor: page.items.length === limit && last ? String(last.ordinal) : null } };
  });

  add('POST', '/question-reports', async (c) => {
    const reason = str(c.body, 'reason', 20);
    if (!REPORT_REASONS.includes(reason)) throw invalid('reason', `must be one of ${REPORT_REASONS.join(', ')}`);
    const comment = c.body.comment === undefined ? null : str(c.body, 'comment', 2000);
    const versionId = readReportToken(str(c.body, 'reportToken', 400), c.claims.sub, config.tokenSecret);
    if (!versionId || !UUID.test(versionId)) throw invalid('reportToken', 'is not valid');
    await store.createReport(c.claims.sub, versionId, reason, comment);
    return { status: 202 };
  });

  for (const r of adminRoutes({ store, blueprintCode: config.blueprintCode, exhibitUrl, now: () => iso() })) add(r.method, r.path, r.handler, r.options);

  // Exhibit images, reachable only through a signed address that has not expired.
  add('GET', '/exhibits/:exhibitId', async (c) => {
    const id = c.params.exhibitId ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(id) || !verifyExhibitUrl(id, c.query.get('exp'), c.query.get('sig'), Math.floor(deps.now() / 1000), exhibitKey)) {
      throw notFound();
    }
    const img = await store.exhibitImage(id);
    if (!img) throw notFound();
    return {
      status: 200,
      raw: {
        bytes: Buffer.from(img.base64, 'base64'),
        contentType: img.mimeType,
        headers: { 'Cache-Control': 'private, max-age=3600', ETag: `"${img.sha256}"`, 'Content-Disposition': 'inline' },
      },
    };
  }, { auth: false });

  // ------------------------------------------------------------ dispatch

  const HSTS: Record<string, string> = config.hsts ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {};
  const send = (res: ServerResponse, status: number, body: unknown, problem = false): void => {
    const headers: Record<string, string> = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...HSTS,
    };
    if (body === undefined) {
      res.writeHead(status, headers);
      res.end();
      return;
    }
    headers['Content-Type'] = problem ? 'application/problem+json; charset=utf-8' : 'application/json; charset=utf-8';
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  };
  /** Error responses: titles and field messages in Arabic when the request asks for Arabic; `code` and `field` never change. */
  const fail = (res: ServerResponse, e: HttpError, language: 'en' | 'ar' = 'en'): void => {
    const tr = language === 'ar' ? toArabic : (t: string) => t;
    const errors = e.errors?.map((x) => ({ field: x.field, message: tr(x.message) }));
    send(res, e.status, { type: 'about:blank', title: tr(e.message), status: e.status, code: e.code, ...(errors ? { errors } : {}) }, true);
  };

  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > config.maxBodyBytes) tooLarge = true;
        else chunks.push(chunk);
      });
      req.on('error', reject);
      req.on('end', () => {
        if (tooLarge) return reject(new HttpError(413, 'body_too_large', 'The request body is too large'));
        if (size === 0) return resolve({});
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
          resolve(parsed as Record<string, unknown>);
        } catch {
          reject(new HttpError(400, 'invalid_json', 'The request body is not valid JSON'));
        }
      });
    });

  /** The client address: the socket, or the entry the trusted proxies added to X-Forwarded-For. */
  const clientIp = (req: IncomingMessage): string => {
    const socketIp = req.socket.remoteAddress ?? 'unknown';
    if (config.trustProxyHops <= 0) return socketIp;
    const header = req.headers['x-forwarded-for'];
    const list = (Array.isArray(header) ? header.join(',') : header ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    return list[list.length - config.trustProxyHops] ?? socketIp;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ip = clientIp(req);
    const matches = routes.filter((r) => r.pattern.test(url.pathname));
    if (matches.length === 0) throw notFound();
    const route = matches.find((r) => r.method === req.method);
    if (!route) throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    if (route.limited && await rateLimited(`${ip} ${url.pathname}`)) {
      throw new HttpError(429, 'rate_limited', 'Too many requests. Try again in a minute');
    }

    let claims: AccessClaims = { sub: '', sid: '', roles: [], exp: 0 };
    if (route.auth) {
      const header = req.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      const verified = verifyAccessToken(token, config.tokenSecret, Math.floor(deps.now() / 1000));
      // The session is checked too, so sign-out and password change take effect at once.
      if (!verified || !UUID.test(verified.sid) || !await store.sessionActive(verified.sid)) {
        throw new HttpError(401, 'unauthenticated', 'Sign in to continue');
      }
      claims = verified;
    }
    let roles = claims.roles;
    if (route.staff) {
      roles = await store.roles(claims.sub);
      if (!route.staff.some((r) => roles.includes(r))) throw new HttpError(403, 'forbidden', 'You do not have access to this action');
      if (claims.mfa !== true) {
        throw new HttpError(403, 'mfa_required', 'Sign in with two-factor authentication to use staff tools');
      }
    }
    const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
    const reply = await route.handler({
      params: route.pattern.exec(url.pathname)?.groups ?? {},
      query: url.searchParams,
      body,
      claims,
      roles,
      language: (req.headers['accept-language'] ?? '').toLowerCase().startsWith('ar') ? 'ar' : 'en',
      ip,
    });
    if (reply.raw) {
      res.writeHead(reply.status, {
        'Content-Type': reply.raw.contentType,
        'Content-Length': String(reply.raw.bytes.length),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
        ...HSTS,
        ...reply.raw.headers,
      });
      res.end(reply.raw.bytes);
      return;
    }
    send(res, reply.status, reply.body);
  };

  const ADMIN_CSP =
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'";

  return (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const started = Date.now();
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    if (deps.log) {
      const log = deps.log;
      res.on('finish', () =>
        log({ at: new Date(started).toISOString(), requestId, method: req.method ?? '', path: path ?? '', status: res.statusCode, ms: Date.now() - started, ip: clientIp(req) }),
      );
    }
    const file = req.method === 'GET' || req.method === 'HEAD' ? deps.webFiles?.get(path ?? '') : undefined;
    if (file) {
      res.writeHead(200, {
        'Content-Type': file.contentType,
        'Content-Length': String(file.bytes.length),
        'Cache-Control': file.cacheControl,
        'X-Content-Type-Options': 'nosniff',
        ...(file.contentType.startsWith('text/html') ? { 'Content-Security-Policy': ADMIN_CSP, 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' } : {}),
        ...HSTS,
      });
      res.end(req.method === 'HEAD' ? undefined : file.bytes);
      return;
    }
    if (req.method === 'GET' && path === '/') {
      res.writeHead(302, { Location: '/app', ...HSTS });
      res.end();
      return;
    }
    const page =
      req.method !== 'GET' ? undefined
      : path === '/admin' || path === '/admin/' ? deps.adminPage
      : path === '/app' || path === '/app/' ? deps.candidatePage
      : undefined;
    if (page) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': ADMIN_CSP,
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
        ...HSTS,
      });
      res.end(page);
      return;
    }
    const language = (req.headers['accept-language'] ?? '').toLowerCase().startsWith('ar') ? 'ar' : 'en';
    handle(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) return fail(res, e, language);
      if (e instanceof ActiveAttemptExistsError) {
        return fail(res, new HttpError(409, 'active_attempt_exists', 'Finish your current mock exam first'), language);
      }
      if (e instanceof MockExamError) {
        return fail(res, new HttpError(SERVICE_STATUS[e.code] ?? 409, e.code, e.code.replaceAll('_', ' ')), language);
      }
      // Never leak internals: log server-side, answer with a generic problem.
      logError(`unhandled error request=${requestId}: ${e instanceof Error ? e.message.slice(0, 300) : 'unknown'}`);
      fail(res, new HttpError(500, 'internal_error', 'Something went wrong'), language);
    });
  };
}
