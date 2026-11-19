// End-to-end API tests: real HTTP requests against the server, on the
// throwaway PostgreSQL from scripts/pg-temp.sh. Responses are also checked
// against the schemas in api/openapi.yaml.
//   eval "$(scripts/pg-temp.sh start)" && (cd packages/api && npm test)

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { MockExamService } from '../../exam-store/src/service.ts';
import { ApiStore } from '../src/api-store.ts';
import { PgPool } from '../../exam-store/src/pg-wire.ts';
import { DEFAULT_APP_CONFIG, createApp } from '../src/app.ts';
import type { Mail } from '../src/app.ts';
import { hashPassword, signAccessToken, verifyPassword } from '../src/auth.ts';

const configured = Boolean(process.env.PGDATABASE);
const SECRET = 'test-secret-not-for-production';
const MIN = 60_000;

type Json = Record<string, any>;
interface Res {
  status: number;
  body: Json;
  type: string;
}

// ---- contract: a small structural check of a value against a named schema

const contractPath = new URL('../../../api/openapi.yaml', import.meta.url).pathname;
const contract = configured
  ? (JSON.parse(
      execFileSync('python3', ['-c', 'import yaml,json,sys;print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', contractPath], {
        encoding: 'utf8',
      }),
    ) as Json)
  : {};

function check(schema: Json, value: unknown, path: string): void {
  if (schema.$ref) return check(contract.components.schemas[schema.$ref.split('/').pop()], value, path);
  if (schema.oneOf || schema.allOf) return;
  const types: string[] = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (value === null) return assert.ok(types.includes('null') || types.length === 0, `${path} must not be null`);
  if (types.includes('array')) {
    assert.ok(Array.isArray(value), `${path} must be an array`);
    (value as unknown[]).forEach((v, i) => schema.items && check(schema.items, v, `${path}[${i}]`));
    return;
  }
  if (types.includes('object')) {
    assert.equal(typeof value, 'object', `${path} must be an object`);
    const obj = value as Json;
    for (const key of schema.required ?? []) assert.ok(key in obj, `${path}.${key} is required`);
    const props: Json = schema.properties ?? {};
    for (const [key, v] of Object.entries(obj)) {
      if (props[key]) check(props[key], v, `${path}.${key}`);
      else if (schema.additionalProperties === false) assert.fail(`${path}.${key} is not in the contract`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        check(schema.additionalProperties, v, `${path}.${key}`);
      }
    }
    return;
  }
  if (types.includes('integer')) assert.ok(Number.isInteger(value), `${path} must be an integer`);
  else if (types.includes('number')) assert.equal(typeof value, 'number', `${path} must be a number`);
  else if (types.includes('string')) assert.equal(typeof value, 'string', `${path} must be a string`);
  else if (types.includes('boolean')) assert.equal(typeof value, 'boolean', `${path} must be a boolean`);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${path} must be one of ${schema.enum}`);
}
const conforms = (name: string, value: unknown) => check({ $ref: `#/components/schemas/${name}` }, value, name);

describe('HTTP API', { skip: configured ? false : 'PGDATABASE is not set; see scripts/pg-temp.sh' }, () => {
  // Application calls use the production connection pool; test assertions use store.query (psql).
  const db = new PgPool(undefined, { max: 4 });
  const store = new ApiStore(db);
  const clock = { t: Date.UTC(2026, 10, 20, 8, 0, 0) };
  const outbox: Mail[] = [];
  const app = createApp({
    store,
    service: new MockExamService(store),
    now: () => clock.t,
    mailer: (m) => outbox.push(m),
    config: { ...DEFAULT_APP_CONFIG, tokenSecret: SECRET, authRateLimit: 12 },
  });
  const server = createServer(app);
  let base = '';

  const call = async (method: string, path: string, opts: { token?: string; body?: unknown; raw?: string; lang?: string } = {}): Promise<Res> => {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.lang) headers['accept-language'] = opts.lang;
    if (opts.body !== undefined || opts.raw !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(`${base}/api/v1${path}`, {
      method,
      headers,
      body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    });
    const text = await r.text();
    return { status: r.status, body: text ? (JSON.parse(text) as Json) : {}, type: r.headers.get('content-type') ?? '' };
  };
  const newMinute = () => {
    clock.t += MIN + 1;
  };

  /** Registers, verifies and signs in a fresh user. */
  const signUp = async (email: string, password = 'correct horse battery') => {
    newMinute();
    assert.equal((await call('POST', '/auth/register', { body: { email, password, acceptTerms: true } })).status, 201);
    const mail = outbox.findLast((m) => m.to === email && m.purpose === 'verify')!;
    assert.equal((await call('POST', '/auth/verify-email', { body: { token: mail.token } })).status, 204);
    const login = await call('POST', '/auth/login', { body: { email, password } });
    assert.equal(login.status, 200);
    return login.body as { accessToken: string; refreshToken: string };
  };

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await db.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  let alice = { accessToken: '', refreshToken: '' };
  let bob = { accessToken: '', refreshToken: '' };
  /** Access tokens live 15 minutes; long exams renew them, as a real client does. */
  const renew = async (who: { accessToken: string; refreshToken: string }) => {
    const r = await call('POST', '/auth/refresh', { body: { refreshToken: who.refreshToken } });
    assert.equal(r.status, 200);
    who.accessToken = r.body.accessToken;
    who.refreshToken = r.body.refreshToken;
  };

  it('hashes passwords with a salted memory-hard function', () => {
    const h = hashPassword('correct horse battery');
    assert.match(h, /^scrypt\$32768\$8\$1\$/);
    assert.notEqual(h, hashPassword('correct horse battery'));
    assert.ok(verifyPassword('correct horse battery', h));
    assert.ok(!verifyPassword('correct horse batterx', h));
    assert.ok(!verifyPassword('x', 'not-a-hash'));
  });

  it('registers with validation and never returns the verification token', async () => {
    const weak = await call('POST', '/auth/register', { body: { email: 'alice@example.test', password: 'short', acceptTerms: true } });
    assert.equal(weak.status, 422);
    conforms('Problem', weak.body);
    assert.match(weak.type, /application\/problem\+json/);
    assert.equal(weak.body.errors[0].field, 'password');
    assert.equal((await call('POST', '/auth/register', { body: { email: 'not-an-email', password: 'correct horse battery', acceptTerms: true } })).status, 422);
    assert.equal((await call('POST', '/auth/register', { body: { email: 'alice@example.test', password: 'correct horse battery' } })).status, 422);

    const ok = await call('POST', '/auth/register', { body: { email: 'alice@example.test', password: 'correct horse battery', acceptTerms: true } });
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.body, {});
    assert.equal(outbox.length, 1);
    const dup = await call('POST', '/auth/register', { body: { email: 'ALICE@example.test', password: 'correct horse battery', acceptTerms: true } });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.code, 'email_taken');
    assert.equal(store.query(`SELECT count(*) FROM users WHERE password_hash LIKE 'scrypt$%' AND email = 'alice@example.test';`), '1');
  });

  it('requires a verified email, then signs in', async () => {
    const creds = { email: 'alice@example.test', password: 'correct horse battery' };
    const early = await call('POST', '/auth/login', { body: creds });
    assert.equal(early.status, 401);
    assert.equal(early.body.code, 'email_not_verified');
    assert.equal((await call('POST', '/auth/verify-email', { body: { token: 'wrong' } })).status, 422);
    assert.equal((await call('POST', '/auth/verify-email', { body: { token: outbox[0]!.token } })).status, 204);
    assert.equal((await call('POST', '/auth/verify-email', { body: { token: outbox[0]!.token } })).status, 422);

    const wrong = await call('POST', '/auth/login', { body: { ...creds, password: 'wrong wrong wrong' } });
    const unknown = await call('POST', '/auth/login', { body: { email: 'nobody@example.test', password: 'wrong wrong wrong' } });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.body, unknown.body);

    const login = await call('POST', '/auth/login', { body: creds });
    assert.equal(login.status, 200);
    conforms('TokenPair', login.body);
    alice = login.body as typeof alice;
  });

  it('protects every other endpoint and rejects forged or expired tokens', async () => {
    assert.equal((await call('GET', '/me')).status, 401);
    assert.equal((await call('GET', '/me', { token: 'abc.def.ghi' })).status, 401);
    const forged = signAccessToken({ sub: '00000000-0000-4000-8000-000000000003', sid: '00000000-0000-4000-8000-000000000003', roles: ['administrator'], exp: 9_999_999_999 }, 'another-secret');
    assert.equal((await call('GET', '/me', { token: forged })).status, 401);
    const tampered = `${alice.accessToken.slice(0, -3)}abc`;
    assert.equal((await call('GET', '/me', { token: tampered })).status, 401);

    const me = await call('GET', '/me', { token: alice.accessToken });
    assert.equal(me.status, 200);
    conforms('Profile', me.body);
    assert.deepEqual(me.body.roles, ['student']);
    assert.ok(!JSON.stringify(me.body).includes('scrypt'));

    clock.t += 16 * MIN;
    assert.equal((await call('GET', '/me', { token: alice.accessToken })).status, 401);
  });

  it('rotates refresh tokens and revokes the chain when an old one is reused', async () => {
    const first = await call('POST', '/auth/refresh', { body: { refreshToken: alice.refreshToken } });
    assert.equal(first.status, 200);
    assert.notEqual(first.body.refreshToken, alice.refreshToken);
    assert.equal((await call('GET', '/me', { token: first.body.accessToken })).status, 200);

    const reuse = await call('POST', '/auth/refresh', { body: { refreshToken: alice.refreshToken } });
    assert.equal(reuse.status, 401);
    // The stolen-token response also kills the legitimate new session.
    assert.equal((await call('GET', '/me', { token: first.body.accessToken })).status, 401);
    assert.equal((await call('POST', '/auth/refresh', { body: { refreshToken: first.body.refreshToken } })).status, 401);

    newMinute();
    const login = await call('POST', '/auth/login', { body: { email: 'alice@example.test', password: 'correct horse battery' } });
    alice = login.body as typeof alice;
  });

  it('signs out immediately and resets a password through an emailed token', async () => {
    const extra = await call('POST', '/auth/login', { body: { email: 'alice@example.test', password: 'correct horse battery' } });
    assert.equal((await call('POST', '/auth/logout', { token: extra.body.accessToken })).status, 204);
    assert.equal((await call('GET', '/me', { token: extra.body.accessToken })).status, 401);
    assert.equal((await call('POST', '/auth/refresh', { body: { refreshToken: extra.body.refreshToken } })).status, 401);

    const unknown = await call('POST', '/auth/password/reset-request', { body: { email: 'nobody@example.test' } });
    const known = await call('POST', '/auth/password/reset-request', { body: { email: 'alice@example.test' } });
    assert.deepEqual([unknown.status, known.status], [202, 202]);
    const mail = outbox.findLast((m) => m.purpose === 'reset')!;
    assert.equal(mail.to, 'alice@example.test');
    assert.equal((await call('POST', '/auth/password/reset', { body: { token: mail.token, newPassword: 'short' } })).status, 422);
    assert.equal((await call('POST', '/auth/password/reset', { body: { token: mail.token, newPassword: 'a brand new passphrase' } })).status, 204);
    assert.equal((await call('POST', '/auth/password/reset', { body: { token: mail.token, newPassword: 'another new passphrase' } })).status, 422);
    assert.equal((await call('GET', '/me', { token: alice.accessToken })).status, 401);

    newMinute();
    assert.equal((await call('POST', '/auth/login', { body: { email: 'alice@example.test', password: 'correct horse battery' } })).status, 401);
    const login = await call('POST', '/auth/login', { body: { email: 'alice@example.test', password: 'a brand new passphrase' } });
    assert.equal(login.status, 200);
    alice = login.body as typeof alice;
  });

  it('limits repeated sign-in attempts from one client', async () => {
    newMinute();
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      statuses.push((await call('POST', '/auth/login', { body: { email: 'alice@example.test', password: 'wrong wrong wrong' } })).status);
    }
    assert.deepEqual(statuses.slice(0, 12), Array(12).fill(401));
    assert.deepEqual(statuses.slice(12), [429, 429]);
    newMinute();
    assert.equal((await call('POST', '/auth/login', { body: { email: 'alice@example.test', password: 'wrong wrong wrong' } })).status, 401);
  });

  it('shares the sign-in limit between two copies of the app, and stores no client address', async () => {
    newMinute();
    const second = createServer(createApp({ store, service: new MockExamService(store), now: () => clock.t, mailer: () => {}, config: { ...DEFAULT_APP_CONFIG, tokenSecret: SECRET, authRateLimit: 12 } }));
    await new Promise<void>((r) => second.listen(0, '127.0.0.1', r));
    const otherBase = `http://127.0.0.1:${(second.address() as AddressInfo).port}/api/v1`;
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      // Alternate between the two servers: the count is one.
      const r = i % 2 === 0
        ? await call('POST', '/auth/login', { body: { email: 'alice@example.test', password: 'wrong wrong wrong' } })
        : { status: (await fetch(`${otherBase}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'alice@example.test', password: 'wrong wrong wrong' }) })).status };
      statuses.push(r.status);
    }
    assert.deepEqual(statuses.slice(12), [429, 429]);
    assert.equal(store.query(`SELECT count(*) FROM rate_limits WHERE key_hash LIKE '%127.0.0.1%';`), '0');
    await new Promise<void>((r) => second.close(() => r()));
    newMinute();
  });

  it('updates the profile with validation', async () => {
    const bad = await call('PATCH', '/me', { token: alice.accessToken, body: { examTargetDate: '31/12/2026' } });
    assert.equal(bad.status, 422);
    assert.equal((await call('PATCH', '/me', { token: alice.accessToken, body: { language: 'fr' } })).status, 422);
    const ok = await call('PATCH', '/me', {
      token: alice.accessToken,
      body: { displayName: "Alice O'Neil $$; DROP TABLE users;--", countryCode: 'eg', language: 'ar', examTargetDate: '2026-12-20', weeklyStudyHours: 8 },
    });
    assert.equal(ok.status, 200);
    conforms('Profile', ok.body);
    assert.equal(ok.body.displayName, "Alice O'Neil $$; DROP TABLE users;--");
    assert.equal(ok.body.countryCode, 'EG');
    assert.equal(ok.body.examTargetDate, '2026-12-20');
    assert.ok(Number(store.query('SELECT count(*) FROM users;')) >= 6);
  });

  it('handles malformed requests without leaking internals', async () => {
    assert.equal((await call('POST', '/auth/login', { raw: '{not json' })).status, 400);
    assert.equal((await call('POST', '/auth/login', { raw: '[1,2]' })).status, 400);
    const big = await call('POST', '/auth/login', { raw: JSON.stringify({ email: 'a@b.cd', password: 'x'.repeat(2_200_000) }) });
    assert.equal(big.status, 413);
    assert.equal((await call('GET', '/nope', { token: alice.accessToken })).status, 404);
    assert.equal((await call('DELETE', '/blueprints/active', { token: alice.accessToken })).status, 405);
    assert.equal((await call('GET', '/exams/attempts/not-a-uuid', { token: alice.accessToken })).status, 404);
    const res = await fetch(`${base}/api/v1/blueprints/active`, { headers: { authorization: `Bearer ${alice.accessToken}` } });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  it('serves the active blueprint', async () => {
    const r = await call('GET', '/blueprints/active', { token: alice.accessToken });
    assert.equal(r.status, 200);
    conforms('BlueprintSummary', r.body);
    assert.deepEqual(r.body.domains.map((d: Json) => [d.code, Number(d.weightPct), d.tasks.length]), [
      ['PEOPLE', 33, 8],
      ['PROCESS', 41, 10],
      ['BUSINESS', 26, 8],
    ]);
  });

  it('starts with an empty dashboard', async () => {
    const r = await call('GET', '/me/dashboard', { token: alice.accessToken });
    assert.equal(r.status, 200);
    conforms('Dashboard', r.body);
    assert.equal(r.body.questionsCompleted, 0);
    assert.equal(r.body.accuracyPercent, null);
    assert.equal(r.body.daysToExam, 30);
    assert.equal(r.body.weakestDomain, null);
  });

  let practiceId = '';
  it('practice: serves a question without its key, then explains it after the answer is stored', async () => {
    const none = await call('POST', '/practice/sessions', { token: alice.accessToken, body: { mode: 'focused', questionCount: 5, taskCodes: ['NO-SUCH-TASK'] } });
    assert.equal(none.status, 409);
    assert.equal(none.body.code, 'no_questions_match');
    assert.equal((await call('POST', '/practice/sessions', { token: alice.accessToken, body: { mode: 'focused', questionCount: 500 } })).status, 422);

    const s = await call('POST', '/practice/sessions', {
      token: alice.accessToken,
      body: { mode: 'focused', questionCount: 12, taskCodes: ['PEOPLE-2'], approaches: ['agile', 'hybrid'] },
    });
    assert.equal(s.status, 201);
    conforms('PracticeSession', s.body);
    assert.equal(s.body.questionCount, 12);
    practiceId = s.body.id;

    const q = await call('GET', `/practice/sessions/${practiceId}/questions/1`, { token: alice.accessToken });
    assert.equal(q.status, 200);
    conforms('CandidateQuestion', q.body);
    assert.equal(q.body.taskName, 'Manage conflicts');
    assert.ok(!/isCorrect|rationale|correct|explanation/i.test(JSON.stringify(q.body)));
    assert.equal((await call('GET', `/practice/sessions/${practiceId}/questions/13`, { token: alice.accessToken })).status, 404);

    const item = (await store.practiceItem(practiceId, (await store.userByEmail('alice@example.test'))!.id, 1))!;
    assert.ok(item.question.approach !== 'predictive' && item.question.taskId === 'PEOPLE-2');
    const key = item.question.options.filter((o) => o.isCorrect).map((o) => o.id);

    assert.equal((await call('POST', `/practice/sessions/${practiceId}/questions/1/answer`, { token: alice.accessToken, body: { selectedOptionIds: [] } })).status, 422);
    assert.equal((await call('POST', `/practice/sessions/${practiceId}/questions/1/answer`, { token: alice.accessToken, body: { selectedOptionIds: ['zzz'] } })).status, 422);
    const a = await call('POST', `/practice/sessions/${practiceId}/questions/1/answer`, { token: alice.accessToken, body: { selectedOptionIds: key, timeSpentMs: 42_000 } });
    assert.equal(a.status, 200);
    conforms('AnswerFeedback', a.body);
    assert.equal(a.body.correct, true);
    assert.deepEqual(a.body.correctOptionIds, key);
    assert.equal(a.body.explanation.taskName, 'Manage conflicts');
    assert.equal(a.body.explanation.options.length, 4);
    const again = await call('POST', `/practice/sessions/${practiceId}/questions/1/answer`, { token: alice.accessToken, body: { selectedOptionIds: key } });
    assert.equal(again.status, 409);

    // Second question answered wrongly.
    const item2 = (await store.practiceItem(practiceId, (await store.userByEmail('alice@example.test'))!.id, 2))!;
    const wrong = [item2.question.options.find((o) => !o.isCorrect)!.id];
    const b = await call('POST', `/practice/sessions/${practiceId}/questions/2/answer`, { token: alice.accessToken, body: { selectedOptionIds: wrong } });
    assert.equal(b.body.correct, false);
    conforms('AnswerFeedback', b.body);
    assert.equal(typeof b.body.errorType, 'string'); // a wrong answer gets a likely error type
    assert.equal(a.body.errorType, null);

    const report = await call('POST', '/question-reports', { token: alice.accessToken, body: { reportToken: a.body.reportToken, reason: 'ambiguous', comment: 'Two options look right' } });
    assert.equal(report.status, 202);
    assert.equal((await call('POST', '/question-reports', { token: alice.accessToken, body: { reportToken: 'forged.token', reason: 'typo' } })).status, 422);
    assert.equal(store.query(`SELECT count(*) FROM question_reports WHERE comment = 'Two options look right';`), '1');

    const sum = await call('GET', `/practice/sessions/${practiceId}/summary`, { token: alice.accessToken });
    assert.equal(sum.status, 200);
    conforms('PracticeSummary', sum.body);
    assert.deepEqual([sum.body.overall.total, sum.body.overall.correct, sum.body.overall.percent], [2, 1, 50]);
  });

  it('keeps one user out of another user’s practice and exams', async () => {
    bob = await signUp('bob@example.test');
    assert.equal((await call('GET', `/practice/sessions/${practiceId}/questions/3`, { token: bob.accessToken })).status, 404);
    assert.equal((await call('GET', `/practice/sessions/${practiceId}/summary`, { token: bob.accessToken })).status, 404);
    assert.equal((await call('POST', `/practice/sessions/${practiceId}/questions/3/answer`, { token: bob.accessToken, body: { selectedOptionIds: ['x'] } })).status, 404);
  });

  it('answers errors in Arabic for Arabic requests, with the same codes and fields', async () => {
    const r = await call('POST', '/auth/register', { lang: 'ar', body: { email: 'not-an-email', password: 'short', acceptTerms: false } });
    assert.equal(r.status, 422);
    assert.equal(r.body.code, 'validation_failed');
    assert.equal(r.body.title, 'الطلب غير صحيح');
    assert.deepEqual(r.body.errors, [{ field: 'email', message: 'يجب أن يكون بريداً إلكترونياً' }]);
    const pw = await call('POST', '/auth/register', { lang: 'ar', body: { email: 'new@example.test', password: 'short', acceptTerms: true } });
    assert.deepEqual(pw.body.errors, [{ field: 'password', message: 'يجب أن تتكون كلمة المرور من 10 أحرف على الأقل' }]);
    const en = await call('GET', '/me');
    assert.equal(en.body.title, 'Sign in to continue');
    assert.equal((await call('GET', '/me', { lang: 'ar' })).body.title, 'سجّل الدخول للمتابعة');
  });

  it('health: answers without sign-in and checks the database', async () => {
    const r = await call('GET', '/health');
    assert.equal(r.status, 200);
    conforms('Health', r.body);
    assert.equal(r.body.database, 'ok');
  });

  it('plans: public list, prices only where an administrator set them', async () => {
    const r = await call('GET', '/plans?region=EG');
    assert.equal(r.status, 200);
    conforms('PlanList', r.body);
    assert.deepEqual(r.body.items.map((p: Json) => p.code), ['free', 'pass30', 'pass90']);
    assert.ok(r.body.items.every((p: Json) => p.price === null), 'no price is seeded');
    await store.setPlanPrice('00000000-0000-4000-8000-000000000003', 'pass30', 'EG', 'EGP', 49_900, 'test.pass30.eg');
    const priced = await call('GET', '/plans?region=EG');
    assert.deepEqual(priced.body.items[1].price, { currency: 'EGP', amountMinor: 49_900, storeProductId: 'test.pass30.eg' });
    assert.equal((await call('GET', '/plans?region=GULF')).body.items[1].price, null);
    assert.equal((await call('GET', '/plans?region=MARS')).status, 422);
  });

  it('access: free accounts get a daily practice allowance and no mock exams', async () => {
    const acc = await call('GET', '/me/access', { token: bob.accessToken });
    assert.equal(acc.status, 200);
    conforms('Access', acc.body);
    assert.equal(acc.body.entitled, false);
    assert.equal(acc.body.planCode, 'free');
    assert.equal(acc.body.practiceLeftToday, 15);

    const mock = await call('POST', '/exams/attempts', { token: bob.accessToken });
    assert.equal(mock.status, 402);
    assert.equal(mock.body.code, 'payment_required');

    // A large request is trimmed to what is left today.
    const s = await call('POST', '/practice/sessions', { token: bob.accessToken, body: { mode: 'quick', questionCount: 40 } });
    assert.equal(s.status, 201);
    assert.equal(s.body.questionCount, 15);

    const bobId = (await store.userByEmail('bob@example.test'))!.id;
    const qv = store.query(`SELECT id FROM question_versions LIMIT 1;`);
    const at = new Date(clock.t).toISOString();
    store.query(`INSERT INTO practice_answers (user_id, question_version_id, response, is_correct, answered_at)
                 SELECT '${bobId}', '${qv}', '{}', true, '${at}' FROM generate_series(1, 15);`);
    const used = await call('GET', '/me/access', { token: bob.accessToken });
    assert.equal(used.body.practiceLeftToday, 0);
    const blocked = await call('POST', '/practice/sessions', { token: bob.accessToken, body: { mode: 'quick', questionCount: 5 } });
    assert.equal(blocked.status, 402);
    assert.equal(blocked.body.code, 'daily_limit_reached');

    // Tomorrow (UTC) the allowance is back.
    clock.t += 24 * 60 * MIN;
    await renew(bob);
    await renew(alice);
    assert.equal((await call('GET', '/me/access', { token: bob.accessToken })).body.practiceLeftToday, 15);
  });

  it('access codes: redeem once, then mock exams open; reuse, typos and expiry are refused', async () => {
    const adminId = '00000000-0000-4000-8000-000000000003';
    const { hashToken, newAccessCodes, normalizeAccessCode } = await import('../src/auth.ts');
    const codes = newAccessCodes(3);
    assert.match(codes[0]!, /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    await store.createAccessCodes(adminId, 'pass30', 30, codes.slice(0, 2).map((c) => hashToken(normalizeAccessCode(c))), 'Course test batch', null);
    await store.createAccessCodes(adminId, 'pass30', 30, [hashToken(normalizeAccessCode(codes[2]!))], 'Expired batch', new Date(clock.t - MIN).toISOString());
    assert.equal(store.query(`SELECT count(*) FROM access_codes WHERE code_hash LIKE '%-%';`), '0', 'only hashes are stored');

    const bad = await call('POST', '/me/redeem', { token: alice.accessToken, body: { code: 'AAAA-BBBB-CCCC' } });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.code, 'code_invalid');
    assert.equal((await call('POST', '/me/redeem', { token: alice.accessToken, body: { code: 'short' } })).status, 422);
    const expired = await call('POST', '/me/redeem', { token: alice.accessToken, body: { code: codes[2] } });
    assert.equal(expired.body.code, 'code_expired');

    // Typed in lower case with spaces still works.
    const ok = await call('POST', '/me/redeem', { token: alice.accessToken, body: { code: ` ${codes[0]!.toLowerCase().replace(/-/g, ' ')} ` } });
    assert.equal(ok.status, 200);
    conforms('Access', ok.body);
    assert.equal(ok.body.entitled, true);
    assert.equal(ok.body.planCode, 'pass30');
    assert.equal(ok.body.practiceLeftToday, null);
    assert.equal(Date.parse(ok.body.endsAt), clock.t + 30 * 24 * 60 * MIN);
    const reused = await call('POST', '/me/redeem', { token: bob.accessToken, body: { code: codes[0] } });
    assert.equal(reused.status, 422);
    assert.equal(reused.body.code, 'code_used');

    // A second code stacks on the first.
    const stacked = await call('POST', '/me/redeem', { token: alice.accessToken, body: { code: codes[1] } });
    assert.equal(Date.parse(stacked.body.endsAt), clock.t + 60 * 24 * 60 * MIN);
    assert.equal(store.query(`SELECT count(*) FROM audit_logs WHERE action = 'access.grant' AND after->>'source' = 'access_code';`), '2');

    await store.grantEntitlement((await store.userByEmail('bob@example.test'))!.id, 'pass30', 'admin_grant', null, 30, new Date(clock.t).toISOString(), adminId, 'test');
  });

  it('store purchases are refused until store billing is configured', async () => {
    const r = await call('POST', '/billing/purchases', { token: alice.accessToken, body: { platform: 'google', productId: 'test.pass30.eg', purchaseToken: 'x'.repeat(40) } });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'store_billing_not_configured');
    const unknown = await call('POST', '/billing/purchases', { token: alice.accessToken, body: { platform: 'google', productId: 'nope', purchaseToken: 'x' } });
    assert.equal(unknown.status, 422);
    assert.equal((await call('POST', '/billing/purchases', { token: alice.accessToken, body: { platform: 'web', productId: 'test.pass30.eg', purchaseToken: 'x' } })).status, 422);
  });

  it('grants a verified store purchase once, refuses it to another account, and reports a failed completion', async () => {
    let failComplete = false;
    const verifier = {
      async verify(_p: string, productId: string, token: string) { return token.startsWith('ok-') ? { transactionId: `GPA.${token}`, productId } : null; },
      async complete() { if (failComplete) throw new Error('google down'); },
    };
    const errors: string[] = [];
    const shop = createServer(createApp({ store, service: new MockExamService(store), now: () => clock.t, mailer: () => {}, billingVerifier: verifier as never, logError: (m) => errors.push(m), config: { ...DEFAULT_APP_CONFIG, tokenSecret: SECRET } }));
    await new Promise<void>((r) => shop.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(shop.address() as AddressInfo).port}/api/v1/billing/purchases`;
    const buy = (token: string, who: string, purchaseToken: string) =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${who}` }, body: JSON.stringify({ platform: 'google', productId: 'test.pass30.eg', purchaseToken }) }).then(async (r) => ({ status: r.status, body: await r.json() as Json }));
    const first = await buy('', bob.accessToken, 'ok-111');
    assert.equal(first.status, 200);
    assert.equal(first.body.entitled, true);
    assert.equal((await buy('', bob.accessToken, 'ok-111')).status, 200, 'a retry by the buyer is fine');
    const stolen = await buy('', alice.accessToken, 'ok-111');
    assert.equal(stolen.status, 409);
    assert.equal(stolen.body.code, 'purchase_already_used');
    assert.equal((await buy('', alice.accessToken, 'forged')).body.code, 'purchase_not_valid');
    failComplete = true;
    const late = await buy('', alice.accessToken, 'ok-222');
    assert.equal(late.status, 502);
    assert.equal(late.body.code, 'store_completion_failed');
    assert.equal(store.query(`SELECT count(*) FROM entitlements WHERE external_ref = 'GPA.ok-222';`), '1', 'the pass stays granted');
    assert.match(errors.join('\n'), /store completion failed for google: google down/);
    await new Promise<void>((r) => shop.close(() => r()));
  });

  let attemptId = '';
  it('mock exam over HTTP: start, answer, sections, breaks, submit', async () => {
    const start = await call('POST', '/exams/attempts', { token: alice.accessToken });
    assert.equal(start.status, 201);
    conforms('AttemptStatus', start.body);
    assert.equal(start.body.remainingMs, 240 * MIN);
    attemptId = start.body.id;
    const second = await call('POST', '/exams/attempts', { token: alice.accessToken });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'active_attempt_exists');

    for (const path of ['', '/sections/0/questions', '/result']) {
      assert.equal((await call('GET', `/exams/attempts/${attemptId}${path}`, { token: bob.accessToken })).status, 404);
    }

    const sec = await call('GET', `/exams/attempts/${attemptId}/sections/0/questions`, { token: alice.accessToken });
    assert.equal(sec.status, 200);
    conforms('SectionQuestions', sec.body);
    assert.equal(sec.body.questions.length, 20);
    assert.equal(Object.keys(sec.body.caseStudies).length, 4);
    const firstCase = sec.body.caseStudies[sec.body.questions[0].caseKey];
    assert.equal(firstCase.firstOrdinal, 1);
    assert.match(firstCase.scenario, /^Synthetic scenario/);
    assert.ok(!/isCorrect|rationale|correct|explanation/i.test(JSON.stringify(sec.body)));
    assert.equal((await call('GET', `/exams/attempts/${attemptId}/sections/1/questions`, { token: alice.accessToken })).status, 409);
    for (const path of ['/result', '/review']) {
      const early = await call('GET', `/exams/attempts/${attemptId}${path}`, { token: alice.accessToken });
      assert.equal(early.status, 409);
      assert.equal(early.body.code, 'not_finished');
    }

    const aliceId = (await store.userByEmail('alice@example.test'))!.id;
    const loaded = (await store.loadAttempt(attemptId, aliceId))!;
    const key = (o: number) => loaded.pool.find((q) => q.id === loaded.form.items[o - 1]!.questionId)!.options.filter((x) => x.isCorrect).map((x) => x.id);
    const wrongOf = (o: number) => [loaded.pool.find((q) => q.id === loaded.form.items[o - 1]!.questionId)!.options.find((x) => !x.isCorrect)!.id];
    const put = (o: number, body: Json) => call('PUT', `/exams/attempts/${attemptId}/answers/${o}`, { token: alice.accessToken, body });

    clock.t += 5 * MIN;
    const saved = await put(1, { selectedOptionIds: key(1), clientSeq: 1, flagged: true });
    assert.equal(saved.status, 200);
    conforms('SaveAnswerResponse', saved.body);
    assert.equal(saved.body.remainingMs, 235 * MIN);
    assert.deepEqual(saved.body.saved, { ordinal: 1, selectedOptionIds: key(1), flagged: true, clientSeq: 1 });
    const stale = await put(1, { selectedOptionIds: wrongOf(1), clientSeq: 1 });
    assert.equal(stale.body.staleIgnored, true);
    assert.deepEqual(stale.body.saved.selectedOptionIds, key(1));
    await put(2, { selectedOptionIds: wrongOf(2), clientSeq: 1 });
    await put(3, { selectedOptionIds: key(3), clientSeq: 1 });
    await put(3, { selectedOptionIds: [], clientSeq: 2 }); // cleared
    assert.equal((await put(4, { selectedOptionIds: ['zzz'], clientSeq: 1 })).status, 422);
    assert.equal((await put(4, { selectedOptionIds: key(4) })).status, 422);
    assert.equal((await put(21, { selectedOptionIds: key(21), clientSeq: 1 })).status, 409);
    assert.equal((await put(999, { selectedOptionIds: [], clientSeq: 1 })).status, 404);

    const review = await call('GET', `/exams/attempts/${attemptId}/sections/0/review`, { token: alice.accessToken });
    conforms('SectionReview', review.body);
    assert.deepEqual([review.body.answered, review.body.unanswered.length, review.body.flagged], [2, 18, [1]]);

    assert.equal((await call('POST', `/exams/attempts/${attemptId}/submit`, { token: alice.accessToken })).status, 409);
    assert.equal((await call('POST', `/exams/attempts/${attemptId}/sections/1/close`, { token: alice.accessToken })).status, 409);
    const closed = await call('POST', `/exams/attempts/${attemptId}/sections/0/close`, { token: alice.accessToken });
    assert.equal(closed.body.status, 'on_break');
    assert.equal(closed.body.breakRemainingMs, 10 * MIN);
    assert.equal((await put(21, { selectedOptionIds: key(21), clientSeq: 1 })).body.code, 'on_break');

    clock.t += 3 * MIN;
    const resumed = await call('POST', `/exams/attempts/${attemptId}/resume`, { token: alice.accessToken });
    conforms('AttemptStatus', resumed.body);
    assert.deepEqual(resumed.body.sections.map((s: Json) => s.state), ['closed', 'open', 'locked']);
    assert.equal(resumed.body.remainingMs, 235 * MIN);
    assert.equal((await put(1, { selectedOptionIds: wrongOf(1), clientSeq: 5 })).body.code, 'section_locked');
    await put(21, { selectedOptionIds: key(21), clientSeq: 1 });

    await call('POST', `/exams/attempts/${attemptId}/sections/1/close`, { token: alice.accessToken });
    clock.t += 11 * MIN; // break runs out
    assert.equal((await call('GET', `/exams/attempts/${attemptId}`, { token: alice.accessToken })).status, 401);
    await renew(alice);
    const status = await call('GET', `/exams/attempts/${attemptId}`, { token: alice.accessToken });
    assert.equal(status.body.status, 'in_progress');
    assert.equal(status.body.currentSection, 2);

    const result = await call('POST', `/exams/attempts/${attemptId}/submit`, { token: alice.accessToken });
    assert.equal(result.status, 200);
    conforms('AttemptResult', result.body);
    assert.deepEqual([result.body.overall.total, result.body.overall.answered, result.body.overall.correct], [180, 3, 2]);
    assert.equal(result.body.byDomain.reduce((s: number, t: Json) => s + t.total, 0), 180);
    assert.match(result.body.disclaimer, /not a prediction or guarantee/);
    assert.equal((await put(180, { selectedOptionIds: [], clientSeq: 9 })).status, 409);
    const same = await call('GET', `/exams/attempts/${attemptId}/result`, { token: alice.accessToken });
    assert.deepEqual(same.body, result.body);
  });

  it('answer review is available only after the exam, with keys and explanations', async () => {
    await renew(bob);
    const page = await call('GET', `/exams/attempts/${attemptId}/review?limit=5`, { token: alice.accessToken });
    assert.equal(page.status, 200);
    assert.equal(page.body.items.length, 5);
    assert.equal(page.body.nextCursor, '5');
    page.body.items.forEach((item: Json) => conforms('ReviewedQuestion', item));
    assert.equal(page.body.items[0].feedback.correct, true);
    assert.equal(page.body.items[0].flagged, true);
    assert.equal(page.body.items[1].feedback.correct, false);
    const next = await call('GET', `/exams/attempts/${attemptId}/review?limit=5&cursor=5`, { token: alice.accessToken });
    assert.equal(next.body.items[0].question.ordinal, 6);

    const incorrect = await call('GET', `/exams/attempts/${attemptId}/review?filter=incorrect`, { token: alice.accessToken });
    assert.deepEqual(incorrect.body.items.map((i: Json) => i.question.ordinal), [2]);
    const flagged = await call('GET', `/exams/attempts/${attemptId}/review?filter=flagged`, { token: alice.accessToken });
    assert.deepEqual(flagged.body.items.map((i: Json) => i.question.ordinal), [1]);
    const unanswered = await call('GET', `/exams/attempts/${attemptId}/review?filter=unanswered&limit=100`, { token: alice.accessToken });
    assert.equal(unanswered.body.items.length, 100);
    assert.equal((await call('GET', `/exams/attempts/${attemptId}/review`, { token: bob.accessToken })).status, 404);

    const list = await call('GET', '/exams/attempts', { token: alice.accessToken });
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].status, 'submitted');
    assert.equal((await call('GET', '/exams/attempts', { token: bob.accessToken })).body.items.length, 0);
  });

  it('dashboard and analytics reconcile with the raw answers', async () => {
    const d = await call('GET', '/me/dashboard', { token: alice.accessToken });
    conforms('Dashboard', d.body);
    // 2 practice answers (1 right) + 3 answered mock questions (2 right).
    assert.equal(d.body.questionsCompleted, 5);
    assert.equal(d.body.accuracyPercent, 60);
    assert.equal(d.body.mocksCompleted, 1);
    assert.equal(d.body.streakDays, 2); // practice on day one, the mock on day two
    assert.equal(d.body.recentScores.length, 1);

    const byDomain = await call('GET', '/me/analytics?dimension=domain', { token: alice.accessToken });
    assert.equal(byDomain.status, 200);
    assert.equal(byDomain.body.rows.reduce((s: number, r: Json) => s + r.total, 0), 5);
    assert.equal(byDomain.body.rows.reduce((s: number, r: Json) => s + r.correct, 0), 3);
    const byTask = await call('GET', '/me/analytics?dimension=task', { token: alice.accessToken });
    assert.ok(byTask.body.rows.some((r: Json) => r.key === 'PEOPLE-2' && r.label === 'Manage conflicts'));
    assert.equal((await call('GET', '/me/analytics?dimension=password', { token: alice.accessToken })).status, 422);
    assert.equal((await call('GET', '/me/analytics?dimension=domain', { token: bob.accessToken })).body.rows.length, 0);
  });

  it('practice never offers questions from an exam that is still running', async () => {
    const start = await call('POST', '/exams/attempts', { token: bob.accessToken });
    const bobId = (await store.userByEmail('bob@example.test'))!.id;
    const inExam = new Set((await store.loadAttempt(start.body.id, bobId))!.form.items.map((i) => i.questionId));
    for (let i = 0; i < 3; i++) {
      const s = await call('POST', '/practice/sessions', { token: bob.accessToken, body: { mode: 'quick', questionCount: 100 } });
      const ids = store.query(`SELECT string_agg(question_id::text, ',') FROM practice_items WHERE session_id = '${s.body.id}';`).split(',');
      assert.equal(ids.length, 100);
      assert.equal(ids.filter((id) => inExam.has(id)).length, 0);
    }
  });

  it('incorrect-only practice returns exactly the questions last answered wrongly', async () => {
    const s = await call('POST', '/practice/sessions', { token: alice.accessToken, body: { mode: 'incorrect_only', questionCount: 50 } });
    assert.equal(s.status, 201);
    // One wrong practice answer; the wrong mock answer was on a case-set question, which practice does not serve.
    assert.equal(s.body.questionCount, 1);
    const timed = await call('POST', '/practice/sessions', { token: alice.accessToken, body: { mode: 'timed', questionCount: 10 } });
    assert.equal(timed.body.timeLimitSeconds, 800);
  });

  it('learns from answers: task mastery, readiness, spaced review and adaptive practice', async () => {
    const tk = alice.accessToken;
    // Practice answers and the finished mock exam both feed mastery.
    const m = await call('GET', '/me/mastery', { token: tk });
    assert.equal(m.status, 200);
    assert.ok(m.body.items.length > 0, 'mastery is recorded');
    assert.ok(m.body.items.every((x: { attempts: number }) => x.attempts > 0));
    const mocks = Number(store.query(`SELECT count(*) FROM spaced_reviews r JOIN users u ON u.id = r.user_id WHERE u.email = 'alice@example.test' AND r.source = 'mock';`));
    assert.ok(mocks > 0, 'mock answers are learned from');
    const r = await call('GET', '/me/readiness', { token: tk });
    assert.ok(Number(r.body.score) > 0 && Number(r.body.score) < 100);
    // Nothing is due yet, so a review session has nothing to serve.
    assert.equal((await call('POST', '/practice/sessions', { token: tk, body: { mode: 'spaced_review', questionCount: 10 } })).status, 409);
    store.query(`UPDATE spaced_state SET next_review_at = now() - interval '1 hour' WHERE user_id = (SELECT id FROM users WHERE email = 'alice@example.test') AND repetition = 0;`);
    const due = Number(store.query(`SELECT count(*) FROM spaced_state s JOIN questions q ON q.id = s.question_id JOIN question_versions v ON v.id = q.current_version_id
      WHERE s.user_id = (SELECT id FROM users WHERE email = 'alice@example.test') AND s.next_review_at <= now() AND v.case_study_id IS NULL;`));
    const rev = await call('POST', '/practice/sessions', { token: tk, body: { mode: 'spaced_review', questionCount: 50 } });
    assert.equal(rev.status, 201);
    assert.equal(rev.body.questionCount, Math.min(due, 50));
    const ad = await call('POST', '/practice/sessions', { token: tk, body: { mode: 'adaptive', questionCount: 10 } });
    assert.equal(ad.status, 201);
    assert.equal(ad.body.mode, 'adaptive');
    // Wrong answers get a rule-based error type, shown in the summary.
    const errs = await call('GET', '/me/errors', { token: tk });
    assert.ok(errs.body.items.length > 0, 'wrong answers are classified');
    assert.ok(errs.body.items.every((e: { errorType: string; count: number }) => e.errorType && e.count > 0));
    const plan = await call('POST', '/me/study-plan/refresh', { token: tk });
    assert.ok(Array.isArray(plan.body.days) && plan.body.days.length === 7);
    assert.ok(plan.body.focusAreas.length <= 3);
  });

  it('answers every study-tool endpoint without a server error, after practice and a finished mock', async () => {
    const tk = alice.accessToken;
    const qid = store.query(`SELECT pi.question_id FROM practice_items pi JOIN practice_sessions ps ON ps.id = pi.session_id
                             JOIN users u ON u.id = ps.user_id WHERE u.email = 'alice@example.test' AND pi.answered_at IS NOT NULL LIMIT 1;`);
    const checks: Array<[string, string, unknown?]> = [
      ['GET', '/me/dashboard'], ['GET', '/me/analytics'], ['GET', '/me/mastery'], ['GET', '/me/readiness'],
      ['GET', '/me/spaced-reviews/due'], ['GET', '/me/profile'], ['GET', '/me/errors'], ['GET', '/me/study-plan'],
      ['POST', '/me/study-plan/refresh'], ['GET', '/me/bookmarks'], ['POST', `/me/bookmarks/${qid}`],
      ['PUT', `/me/notes/${qid}`, { content: 'my note' }], ['GET', `/me/notes/${qid}`], ['DELETE', `/me/notes/${qid}`],
      ['GET', '/me/analytics/domains'], ['GET', '/me/analytics/difficulty'], ['GET', '/case-studies'],
      ['POST', '/coach/hint', { questionId: qid, hintType: 'approach' }], ['POST', '/practice/adaptive', {}],
      ['GET', '/me/notifications'], ['POST', '/me/notifications/read-all'], ['GET', '/me/referral'],
      ['POST', '/me/coupon', { code: 'NOPE' }], ['GET', '/me/streak'], ['GET', '/me/certificates'],
      ['GET', '/me/weekly-snapshots'], ['POST', '/me/weekly-snapshots/refresh'], ['GET', '/tips'],
    ];
    const broken: string[] = [];
    for (const [method, path, body] of checks) {
      const r = await call(method, path, { token: tk, ...(body === undefined ? {} : { body }) });
      if (r.status >= 500) broken.push(`${method} ${path} → ${r.status}`);
    }
    assert.deepEqual(broken, []);

    // The finished mock exam earned a completion certificate that verifies publicly, with no pass/fail claim.
    const certs = (await call('GET', '/me/certificates', { token: tk })).body.items;
    assert.equal(certs.length, 1);
    assert.equal(certs[0].attempt_id, attemptId);
    assert.equal(certs[0].passed, null);
    const pub = await call('GET', `/verify/${certs[0].token}`);
    assert.equal(pub.status, 200);
    assert.equal(pub.body.revoked, false);

    const snap = (await call('GET', '/me/weekly-snapshots', { token: tk })).body.items;
    assert.ok(snap.length >= 1 && snap[0].questions_answered > 0, 'this week shows the answers just given');
    const streak = (await call('GET', '/me/streak', { token: tk })).body;
    assert.ok(streak.currentStreak >= 1);
  });

  it('lets a candidate download everything stored about them, without secrets or other people', async () => {
    const r = await fetch(`${base}/api/v1/me/export`, { headers: { authorization: `Bearer ${alice.accessToken}` } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition') ?? '', /attachment; filename="my-exam-simulator-data.json"/);
    const text = await r.text();
    const data = JSON.parse(text);
    assert.equal(data.profile.email, 'alice@example.test');
    assert.ok(data.practiceAnswers.length >= 2);
    assert.ok(data.mockExams.length >= 1);
    assert.ok(data.questionReports.some((q: Json) => q.comment === 'Two options look right'));
    assert.ok(data.access.some((a: Json) => a.source === 'access_code'));
    assert.doesNotMatch(text, /scrypt\$|password_hash|refresh_token|totp_secret|bob@example\.test/);
    assert.equal((await fetch(`${base}/api/v1/me/export`)).status, 401);
  });

  it('deleting the account ends every session', async () => {
    const carol = await signUp('carol@example.test');
    assert.equal((await call('DELETE', '/me', { token: carol.accessToken })).status, 202);
    assert.equal((await call('GET', '/me', { token: carol.accessToken })).status, 401);
    newMinute();
    assert.equal((await call('POST', '/auth/login', { body: { email: 'carol@example.test', password: 'correct horse battery' } })).status, 401);
  });
});
