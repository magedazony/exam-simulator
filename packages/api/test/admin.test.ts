// Staff tools over real HTTP: two-factor sign-in, authoring, the review
// workflow, versioning, import, blueprint versions and report triage.
// Uses the seeded staff accounts of db/seed/synthetic_bank.sql.
//   eval "$(scripts/pg-temp.sh start)" && (cd packages/api && npm test)

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { MockExamService } from '../../exam-store/src/service.ts';
import { ApiStore } from '../src/api-store.ts';
import { PgPool } from '../../exam-store/src/pg-wire.ts';
import { DEFAULT_APP_CONFIG, createApp } from '../src/app.ts';
import type { Mail } from '../src/app.ts';
import { hashPassword, totpCode, totpStep, verifyTotp } from '../src/auth.ts';

const configured = Boolean(process.env.PGDATABASE);
const SECRET = 'admin-test-secret-not-for-production';
const STAFF = {
  author: { id: '00000000-0000-4000-8000-000000000001', email: 'author@example.test' },
  reviewer: { id: '00000000-0000-4000-8000-000000000002', email: 'reviewer@example.test' },
  admin: { id: '00000000-0000-4000-8000-000000000003', email: 'admin@example.test' },
};
const PASS = 'staff passphrase for tests';
type Json = Record<string, any>;

const b32decode = (s: string): Buffer => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    value = ((value << 5) | alphabet.indexOf(ch)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};

const CHECKS = {
  technical: true,
  outlineMapping: true,
  language: true,
  ambiguity: true,
  singleAnswer: true,
  distractors: true,
  difficulty: true,
  biasFairness: true,
};

const draft = (over: Json = {}): Json => ({
  taskCode: 'PEOPLE-2',
  approach: 'agile',
  difficulty: 'medium',
  type: 'single',
  stem: 'Two developers disagree about a design during iteration planning. What should the project manager do first?',
  options: [
    { text: 'Decide the design approach', isCorrect: false, rationale: 'Takes the decision from the team.' },
    { text: 'Facilitate a discussion so the team can agree', isCorrect: true, rationale: 'Helps the team resolve it.' },
    { text: 'Escalate to the functional manager', isCorrect: false, rationale: 'Too early to escalate.' },
    { text: 'Ask the product owner to decide', isCorrect: false, rationale: 'Design is not the product owner decision.' },
  ],
  explanation: { whyCorrect: 'The team owns how work is done; the project manager facilitates.', mindset: 'Facilitate first.' },
  ...over,
});

describe('staff tools', { skip: configured ? false : 'PGDATABASE is not set; see scripts/pg-temp.sh' }, () => {
  // Application calls use the production connection pool; test assertions use store.query (psql).
  const db = new PgPool(undefined, { max: 4 });
  const store = new ApiStore(db);
  const clock = { t: Date.UTC(2026, 11, 1, 8, 0, 0) };
  const outbox: Mail[] = [];
  const server = createServer(
    createApp({
      store,
      service: new MockExamService(store),
      now: () => clock.t,
      mailer: (m) => outbox.push(m),
      config: { ...DEFAULT_APP_CONFIG, tokenSecret: SECRET, authRateLimit: 200 },
    }),
  );
  let base = '';
  const call = async (method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; body: Json }> => {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? (JSON.parse(text) as Json) : {} };
  };
  const tick = (seconds = 31) => {
    clock.t += seconds * 1000;
  };

  const secrets: Record<string, Buffer> = {};
  const recovery: Record<string, string[]> = {};
  const tokens: Record<string, { accessToken: string; refreshToken: string }> = {};
  const signIn = async (who: keyof typeof STAFF) => {
    tick();
    const r = await call('POST', '/auth/login', undefined, {
      email: STAFF[who].email,
      password: PASS,
      otp: totpCode(secrets[who]!, totpStep(clock.t)),
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    tokens[who] = r.body as (typeof tokens)[string];
    return tokens[who]!.accessToken;
  };
  const tk = (who: keyof typeof STAFF) => tokens[who]!.accessToken;
  const move = (who: keyof typeof STAFF, versionId: string, body: Json) =>
    call('POST', `/admin/question-versions/${versionId}/transitions`, tk(who), body);
  const throughGates = async (versionId: string) => {
    assert.equal((await move('author', versionId, { action: 'submit', originalityDeclared: true })).status, 200);
    assert.equal((await move('reviewer', versionId, { action: 'approve', checklist: CHECKS })).body.workflowState, 'language_qa');
    assert.equal((await move('reviewer', versionId, { action: 'approve', checklist: CHECKS })).body.workflowState, 'approved');
  };
  let student = '';
  let activeId = '';

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const s of Object.values(STAFF)) {
      await store.setPassword(s.id, hashPassword(PASS), new Date(clock.t).toISOString());
      await store.markVerified(s.id, new Date(clock.t).toISOString());
    }
    activeId = (await store.activeBlueprint('PMP-ECO'))!.id;
  });
  after(async () => {
    await db.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('computes one-time codes exactly as RFC 6238 specifies', () => {
    const secret = Buffer.from('12345678901234567890');
    assert.equal(totpCode(secret, totpStep(59_000), 8), '94287082');
    assert.equal(totpCode(secret, totpStep(1_111_111_109_000), 8), '07081804');
    assert.equal(totpCode(secret, totpStep(1_234_567_890_000), 8), '89005924');
    const now = 1_234_567_890_000;
    const code = totpCode(secret, totpStep(now));
    assert.equal(verifyTotp(secret, code, now, 0), totpStep(now));
    assert.equal(verifyTotp(secret, code, now + 30_000, 0), totpStep(now)); // one step of drift accepted
    assert.equal(verifyTotp(secret, code, now + 90_000, 0), null); // too old
    assert.equal(verifyTotp(secret, code, now, totpStep(now)), null); // already used
    assert.equal(verifyTotp(secret, '12345', now, 0), null);
  });

  it('keeps students out and requires two-factor sign-in for staff', async () => {
    assert.equal((await call('POST', '/auth/register', undefined, { email: 'stu@example.test', password: 'student passphrase', acceptTerms: true })).status, 201);
    await call('POST', '/auth/verify-email', undefined, { token: outbox.at(-1)!.token });
    student = (await call('POST', '/auth/login', undefined, { email: 'stu@example.test', password: 'student passphrase' })).body.accessToken;
    const denied = await call('GET', '/admin/questions', student);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'forbidden');

    const plain = await call('POST', '/auth/login', undefined, { email: STAFF.author.email, password: PASS });
    assert.equal(plain.status, 200);
    const noMfa = await call('GET', '/admin/questions', plain.body.accessToken);
    assert.equal(noMfa.status, 403);
    assert.equal(noMfa.body.code, 'mfa_required');
  });

  it('enrols staff in two-factor sign-in and refuses replayed codes', async () => {
    for (const who of Object.keys(STAFF) as Array<keyof typeof STAFF>) {
      tick();
      const login = await call('POST', '/auth/login', undefined, { email: STAFF[who].email, password: PASS });
      const setup = await call('POST', '/auth/mfa/setup', login.body.accessToken);
      assert.equal(setup.status, 200);
      assert.match(setup.body.otpauthUri, /^otpauth:\/\/totp\/.+secret=[A-Z2-7]+/);
      secrets[who] = b32decode(setup.body.secret);
      assert.equal(secrets[who]!.length, 20);
      assert.equal((await call('POST', '/auth/mfa/enable', login.body.accessToken, { code: '000000' })).status, 422);
      const code = totpCode(secrets[who]!, totpStep(clock.t));
      const enabled = await call('POST', '/auth/mfa/enable', login.body.accessToken, { code });
      assert.equal(enabled.status, 200);
      assert.equal(enabled.body.recoveryCodes.length, 10);
      assert.ok(enabled.body.recoveryCodes.every((c: string) => /^[a-z2-7]{4}-[a-z2-7]{4}$/.test(c)));
      recovery[who] = enabled.body.recoveryCodes;
      const stored = store.query(`SELECT string_agg(code_hash, ',') FROM mfa_recovery_codes WHERE user_id = '${STAFF[who].id}';`);
      assert.ok(!recovery[who]!.some((c) => stored.includes(c)));
      assert.equal((await call('POST', '/auth/mfa/setup', login.body.accessToken)).status, 409);
      const sealed = store.query(`SELECT totp_secret_enc FROM users WHERE id = '${STAFF[who].id}';`);
      assert.ok(sealed.length > 40 && !sealed.includes(setup.body.secret));
    }

    tick();
    const missing = await call('POST', '/auth/login', undefined, { email: STAFF.author.email, password: PASS });
    assert.equal(missing.status, 401);
    assert.equal(missing.body.code, 'mfa_required');
    const wrong = await call('POST', '/auth/login', undefined, { email: STAFF.author.email, password: PASS, otp: '000000' });
    assert.equal(wrong.body.code, 'invalid_otp');
    const code = totpCode(secrets.author!, totpStep(clock.t));
    assert.equal((await call('POST', '/auth/login', undefined, { email: STAFF.author.email, password: PASS, otp: code })).status, 200);
    const replay = await call('POST', '/auth/login', undefined, { email: STAFF.author.email, password: PASS, otp: code });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.code, 'invalid_otp');

    for (const who of Object.keys(STAFF) as Array<keyof typeof STAFF>) await signIn(who);
    assert.equal((await call('GET', '/admin/questions?limit=2', tk('reviewer'))).status, 200);
  });

  it('accepts each recovery code once, and replaces them on request', async () => {
    tick();
    const code = recovery.reviewer![0]!;
    const r = await call('POST', '/auth/login', undefined, { email: STAFF.reviewer.email, password: PASS, otp: code.toUpperCase() });
    assert.equal(r.status, 200);
    assert.equal((await call('GET', '/admin/questions?limit=1', r.body.accessToken)).status, 200);
    const again = await call('POST', '/auth/login', undefined, { email: STAFF.reviewer.email, password: PASS, otp: code });
    assert.equal(again.body.code, 'invalid_otp');

    const fresh = await call('POST', '/auth/mfa/recovery-codes', r.body.accessToken);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.recoveryCodes.length, 10);
    const old = await call('POST', '/auth/login', undefined, { email: STAFF.reviewer.email, password: PASS, otp: recovery.reviewer![1] });
    assert.equal(old.body.code, 'invalid_otp');
    assert.equal((await call('POST', '/auth/mfa/recovery-codes', student)).status, 403);
    assert.equal(store.query(`SELECT count(*) FROM audit_logs WHERE action = 'user.mfa_recovery_code_used';`), '1');
  });

  it('keeps the two-factor flag across token refresh', async () => {
    const r = await call('POST', '/auth/refresh', undefined, { refreshToken: tokens.reviewer!.refreshToken });
    assert.equal(r.status, 200);
    tokens.reviewer = r.body as (typeof tokens)[string];
    assert.equal((await call('GET', '/admin/questions?limit=1', tk('reviewer'))).status, 200);
  });

  let qA = { id: '', questionId: '' };
  it('validates and creates drafts', async () => {
    const bad = await call('POST', '/admin/questions', tk('author'), draft({ options: draft().options.map((o: Json) => ({ ...o, isCorrect: true })) }));
    assert.equal(bad.status, 422);
    assert.ok(bad.body.errors.some((e: Json) => e.field === 'options'));
    const unknown = await call('POST', '/admin/questions', tk('author'), draft({ taskCode: 'PEOPLE-99', stem: 'short' }));
    assert.deepEqual(unknown.body.errors.map((e: Json) => e.field).sort(), ['stem', 'taskCode']);
    const caseQ = await call('POST', '/admin/questions', tk('author'), draft({ caseStudyId: '00000000-0000-4000-8000-000000000009' }));
    assert.equal(caseQ.status, 422);
    assert.equal(caseQ.body.code, 'unknown_case');
    assert.equal((await call('POST', '/admin/questions', tk('reviewer'), draft())).status, 403);

    const created = await call('POST', '/admin/questions', tk('author'), draft());
    assert.equal(created.status, 201);
    assert.match(created.body.publicCode, /^Q-\d{6}$/);
    assert.equal(created.body.workflowState, 'draft');
    assert.equal(created.body.versionNo, 1);
    assert.equal(created.body.authorId, STAFF.author.id);
    assert.equal(created.body.options[1].isCorrect, true);
    assert.equal(created.body.explanation.mindset, 'Facilitate first.');
    qA = { id: created.body.id, questionId: created.body.questionId };

    const edited = await call('PUT', `/admin/question-versions/${qA.id}`, tk('author'), draft({ difficulty: 'hard' }));
    assert.equal(edited.status, 200);
    assert.equal(edited.body.difficulty, 'hard');
    assert.equal((await call('PUT', `/admin/question-versions/${qA.id}`, tk('reviewer'), draft())).status, 403);
  });

  it('runs the review workflow and enforces who may do what', async () => {
    const noOriginality = await move('author', qA.id, { action: 'submit' });
    assert.equal(noOriginality.status, 422);
    assert.equal(noOriginality.body.code, 'originality');
    const bare = await call('POST', '/admin/questions', tk('author'), draft({ explanation: undefined, stem: 'A draft without any explanation written for it yet.' }));
    assert.equal((await move('author', bare.body.id, { action: 'submit', originalityDeclared: true })).body.code, 'explanation');

    const submitted = await move('author', qA.id, { action: 'submit', originalityDeclared: true });
    assert.equal(submitted.body.workflowState, 'expert_review');
    assert.equal((await call('PUT', `/admin/question-versions/${qA.id}`, tk('author'), draft())).body.code, 'state');
    assert.equal((await move('author', qA.id, { action: 'approve', checklist: CHECKS })).body.code, 'forbidden');

    const partial = await move('reviewer', qA.id, { action: 'approve', checklist: { ...CHECKS, ambiguity: false } });
    assert.equal(partial.body.code, 'checklist');
    assert.equal((await move('reviewer', qA.id, { action: 'return', comment: '  ' })).body.code, 'comment');
    const returned = await move('reviewer', qA.id, { action: 'return', comment: 'Option C is defensible too. Tighten it.' });
    assert.equal(returned.body.workflowState, 'draft');
    assert.equal(returned.body.lastReview.decision, 'returned');
    assert.equal(returned.body.lastReview.comment, 'Option C is defensible too. Tighten it.');

    await throughGates(qA.id);
    assert.equal((await move('reviewer', qA.id, { action: 'publish' })).body.code, 'forbidden');
    const published = await move('admin', qA.id, { action: 'publish' });
    assert.equal(published.status, 200);
    assert.equal(published.body.workflowState, 'published');
    assert.ok((await store.pool(activeId)).some((q) => q.versionId === qA.id));

    const actions = store.query(
      `SELECT string_agg(action, ',' ORDER BY id) FROM audit_logs WHERE entity_id = '${qA.id}';`,
    );
    assert.equal(actions, 'question.create,question.edit,question.submit,question.return,question.submit,question.approve,question.approve,question.publish');
  });

  it('blocks self-review even for an administrator', async () => {
    const own = await call('POST', '/admin/questions', tk('admin'), draft({ stem: 'An administrator writes this question and then tries to approve it.' }));
    await move('admin', own.body.id, { action: 'submit', originalityDeclared: true });
    const self = await move('admin', own.body.id, { action: 'approve', checklist: CHECKS });
    assert.equal(self.status, 403);
    assert.equal(self.body.code, 'self_review');
  });

  it('does not count approvals given before a return', async () => {
    const b = await call('POST', '/admin/questions', tk('author'), draft({ stem: 'This question is approved once, returned, and then forced to approved.' }));
    await move('author', b.body.id, { action: 'submit', originalityDeclared: true });
    await move('reviewer', b.body.id, { action: 'approve', checklist: CHECKS });
    await move('reviewer', b.body.id, { action: 'return', comment: 'Needs work at the language gate.' });
    store.query(`UPDATE question_versions SET workflow_state = 'approved', originality_declared_at = now() WHERE id = '${b.body.id}';`);
    const r = await move('admin', b.body.id, { action: 'publish' });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'gates');
  });

  it('versions a published question and retires the old version on publish', async () => {
    const v2 = await call('POST', `/admin/questions/${qA.questionId}/versions`, tk('author'));
    assert.equal(v2.status, 201);
    assert.equal(v2.body.versionNo, 2);
    assert.equal(v2.body.workflowState, 'draft');
    assert.equal(v2.body.publicCode, (await call('GET', `/admin/question-versions/${qA.id}`, tk('author'))).body.publicCode);
    assert.equal((await call('POST', `/admin/questions/${qA.questionId}/versions`, tk('author'))).body.code, 'open_version');

    const stem = 'Two senior developers disagree openly about a design during iteration planning. What should the project manager do first?';
    await call('PUT', `/admin/question-versions/${v2.body.id}`, tk('author'), draft({ stem }));
    await throughGates(v2.body.id);
    assert.equal((await move('admin', v2.body.id, { action: 'publish' })).body.workflowState, 'published');
    assert.equal((await call('GET', `/admin/question-versions/${qA.id}`, tk('admin'))).body.workflowState, 'withdrawn');
    const pool = await store.pool(activeId);
    assert.ok(pool.some((q) => q.versionId === v2.body.id && q.stem === stem));
    assert.ok(!pool.some((q) => q.versionId === qA.id));

    const withdrawn = await move('admin', v2.body.id, { action: 'withdraw' });
    assert.equal(withdrawn.body.workflowState, 'withdrawn');
    assert.ok(!(await store.pool(activeId)).some((q) => q.id === qA.questionId));
  });

  it('imports rows with a per-row report and stores only valid, unique rows', async () => {
    const before = store.query('SELECT count(*) FROM questions;');
    const existing = (await call('GET', `/admin/question-versions/${qA.id}`, tk('author'))).body.stem as string;
    const rows = [
      draft({ stem: 'Imported question one about stakeholder engagement in a hybrid project.' }),
      draft({ taskCode: 'NOPE' }),
      draft({ stem: existing.toUpperCase() }),
      draft({ stem: '  imported   QUESTION one about stakeholder engagement in a hybrid project. ' }),
      draft({ stem: 'Imported question two about risk responses on a predictive project.', taskCode: 'BUSINESS-5', approach: 'predictive' }),
    ];
    assert.equal((await call('POST', '/admin/imports', tk('reviewer'), { rows })).status, 403);

    const dry = await call('POST', '/admin/imports', tk('author'), { rows });
    assert.equal(dry.status, 200);
    assert.deepEqual(dry.body.summary, { rows: 5, valid: 2, invalid: 1, duplicates: 2, committed: 0 });
    assert.deepEqual(dry.body.rows.map((r: Json) => r.status), ['valid', 'invalid', 'duplicate', 'duplicate', 'valid']);
    assert.equal(dry.body.rows[1].errors[0].field, 'taskCode');
    assert.match(dry.body.rows[3].errors[0].message, /row 1/);
    assert.equal(store.query('SELECT count(*) FROM questions;'), before);

    const real = await call('POST', '/admin/imports', tk('author'), { rows, commit: true });
    assert.equal(real.body.summary.committed, 2);
    assert.deepEqual(real.body.committed.map((c: Json) => c.row), [1, 5]);
    assert.equal(Number(store.query('SELECT count(*) FROM questions;')), Number(before) + 2);
    const one = await call('GET', `/admin/question-versions/${real.body.committed[0].versionId}`, tk('author'));
    assert.equal(one.body.workflowState, 'draft');
    assert.equal(one.body.authorId, STAFF.author.id);
    assert.equal((await call('POST', '/admin/imports', tk('author'), { rows: [] })).status, 422);
  });

  it('turns an Excel file into rows for import, and explains files it cannot read', async () => {
    const { readFileSync } = await import('node:fs');
    const xlsx = readFileSync(new URL('./fixtures/questions.xlsx', import.meta.url)).toString('base64');
    const r = await call('POST', '/admin/imports/spreadsheet', tk('author'), { dataBase64: xlsx });
    assert.equal(r.status, 200);
    assert.equal(r.body.rows.length, 4);
    assert.equal(r.body.rows[3][4], 'سؤال تجريبي بالعربي لاختبار قراءة النص');
    const csv = await call('POST', '/admin/imports/spreadsheet', tk('author'), { dataBase64: Buffer.from('a,b\n1,2').toString('base64') });
    assert.equal(csv.status, 422);
    assert.match(csv.body.errors[0].message, /not an Excel/);
    assert.equal((await call('POST', '/admin/imports/spreadsheet', tk('author'), { dataBase64: 'not base64!' })).status, 422);
    assert.equal((await call('POST', '/admin/imports/spreadsheet', student, { dataBase64: xlsx })).status, 403);
  });

  it('lists the bank with filters and a cursor', async () => {
    const drafts = await call('GET', '/admin/questions?workflowState=draft&limit=100', tk('reviewer'));
    assert.ok(drafts.body.items.length >= 3);
    assert.ok(drafts.body.items.every((q: Json) => q.workflowState === 'draft'));
    const page1 = await call('GET', '/admin/questions?taskCode=PEOPLE-2&limit=10', tk('reviewer'));
    const page2 = await call('GET', `/admin/questions?taskCode=PEOPLE-2&limit=10&cursor=${page1.body.nextCursor}`, tk('reviewer'));
    assert.equal(page1.body.items.length, 10);
    assert.ok(page2.body.items[0].publicCode > page1.body.items[9].publicCode);
    assert.equal((await call('GET', '/admin/questions?workflowState=nope', tk('reviewer'))).status, 422);
  });

  it('lets administrators price plans, create access codes and grant passes', async () => {
    const plans = await call('GET', '/admin/plans', tk('admin'));
    assert.equal(plans.status, 200);
    assert.deepEqual(plans.body.items.map((p: Json) => p.code), ['free', 'pass30', 'pass90']);
    assert.equal((await call('GET', '/admin/plans', tk('reviewer'))).status, 403);

    const bad = await call('PUT', '/admin/plans/pass90/prices/EG', tk('admin'), { currency: 'egyptian', amountMinor: 1.5, storeProductId: 'has spaces' });
    assert.equal(bad.status, 422);
    assert.deepEqual(bad.body.errors.map((e: Json) => e.field).sort(), ['amountMinor', 'currency', 'storeProductId']);
    assert.equal((await call('PUT', '/admin/plans/pass90/prices/MARS', tk('admin'), { currency: 'EGP', amountMinor: 1 })).status, 404);
    assert.equal((await call('PUT', '/admin/plans/free/prices/EG', tk('admin'), { currency: 'EGP', amountMinor: 1 })).body.code, 'unknown_plan');
    const set = await call('PUT', '/admin/plans/pass90/prices/GULF', tk('admin'), { currency: 'sar', amountMinor: 14_900, storeProductId: 'sim.pass90.gulf' });
    assert.equal(set.status, 200);
    assert.deepEqual(set.body.items[2].prices, [{ region: 'GULF', currency: 'SAR', amountMinor: 14_900, storeProductId: 'sim.pass90.gulf' }]);
    const clash = await call('PUT', '/admin/plans/pass30/prices/GULF', tk('admin'), { currency: 'SAR', amountMinor: 9_900, storeProductId: 'sim.pass90.gulf' });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.code, 'product_in_use');
    assert.equal((await call('GET', '/plans?region=GULF')).body.items[2].price.amountMinor, 14_900);

    const codes = await call('POST', '/admin/access-codes', tk('admin'), { planCode: 'pass30', count: 5, days: 45, label: 'Cairo course Dec 2026' });
    assert.equal(codes.status, 201);
    assert.equal(codes.body.codes.length, 5);
    assert.equal(new Set(codes.body.codes).size, 5);
    assert.equal(store.query(`SELECT count(*) FROM access_codes WHERE batch_label = 'Cairo course Dec 2026' AND redeemed_by IS NULL;`), '5');
    const badBatch = await call('POST', '/admin/access-codes', tk('admin'), { planCode: 'pass30', count: 501, days: 0, label: 'x' });
    assert.deepEqual(badBatch.body.errors.map((e: Json) => e.field).sort(), ['count', 'days', 'label']);
    assert.equal((await call('POST', '/admin/access-codes', tk('author'), { planCode: 'pass30', count: 1, days: 1, label: 'abc' })).status, 403);

    const blocked = await call('POST', '/exams/attempts', student);
    assert.equal(blocked.status, 402);
    const stuId = (await store.userByEmail('stu@example.test'))!.id;
    const grant = await call('POST', `/admin/users/${stuId}/grant`, tk('admin'), { planCode: 'pass90', days: 90, note: 'Course partner account' });
    assert.equal(grant.status, 200);
    assert.equal(grant.body.entitled, true);
    assert.equal(Date.parse(grant.body.endsAt), clock.t + 90 * 86_400_000);
    assert.equal((await call('POST', `/admin/users/${stuId}/grant`, tk('admin'), { planCode: 'gold', days: 9 })).body.code, 'unknown_plan');
    assert.equal((await call('GET', '/me/access', student)).body.entitled, true);
    assert.equal(store.query(`SELECT count(*) FROM audit_logs WHERE action IN ('plan.price', 'access.codes_created', 'access.grant');`), '3');

    // Staff are always entitled, so they can check content.
    const staff = await call('GET', '/me/access', tk('reviewer'));
    assert.equal(staff.body.entitled, true);
    assert.equal(staff.body.practiceLeftToday, null);
  });

  it('imports, dry-runs and activates blueprint versions only when the bank can serve them', async () => {
    const doc = JSON.parse(readFileSync(new URL('../../exam-engine/data/blueprint-2026-07.json', import.meta.url), 'utf8')) as Json;
    assert.equal((await call('POST', '/admin/blueprints', tk('reviewer'), doc)).status, 403);
    const broken = structuredClone(doc);
    broken.version = 202799;
    broken.domains[0].weightPct = 30;
    assert.equal((await call('POST', '/admin/blueprints', tk('admin'), broken)).status, 422);
    assert.equal((await call('POST', '/admin/blueprints', tk('admin'), doc)).body.code, 'blueprint_version_exists');

    const next = { ...structuredClone(doc), version: 202701, effectiveFrom: '2027-01-01' };
    const created = await call('POST', '/admin/blueprints', tk('admin'), next);
    assert.equal(created.status, 201);
    const dry = await call('POST', `/admin/blueprints/${created.body.id}/dry-run?count=5`, tk('admin'));
    assert.deepEqual([dry.body.attempted, dry.body.valid], [5, 5]);

    const greedy = { ...structuredClone(doc), version: 202702 };
    greedy.sections = [
      { kind: 'case', questionCount: 95, breakAfterMinutes: 10 },
      { kind: 'independent', questionCount: 45, breakAfterMinutes: 10 },
      { kind: 'independent', questionCount: 40, breakAfterMinutes: 0 },
    ];
    const g = await call('POST', '/admin/blueprints', tk('admin'), greedy);
    const gDry = await call('POST', `/admin/blueprints/${g.body.id}/dry-run?count=3`, tk('admin'));
    assert.equal(gDry.body.valid, 0);
    assert.ok(gDry.body.violations.some((v: string) => v.includes('case sets')));
    const refused = await call('POST', `/admin/blueprints/${g.body.id}/activate`, tk('admin'));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'dry_run_failed');

    const activated = await call('POST', `/admin/blueprints/${created.body.id}/activate`, tk('admin'));
    assert.equal(activated.status, 200);
    assert.equal((await call('POST', `/admin/blueprints/${created.body.id}/activate`, tk('admin'))).body.code, 'state');
    assert.equal((await call('GET', '/blueprints/active', student)).body.version, 202701);
    // The bank written for the previous version serves the new one by task code.
    const mock = await call('POST', '/exams/attempts', student);
    assert.equal(mock.status, 201);
    assert.deepEqual(mock.body.sections.map((s: Json) => s.questionCount), [20, 80, 80]);
    assert.equal(store.query(`SELECT count(*) FROM audit_logs WHERE action = 'blueprint.activate';`), '2');
  });

  it('authors a case study, publishes it only when every question is published, and serves it in exams', async () => {
    const scenario =
      'A logistics company is moving its warehouse system to the cloud. Infrastructure work follows a fixed plan, ' +
      'while the new picking app is built in two-week iterations. The sponsor expects savings within a year.';
    assert.equal((await call('POST', '/admin/case-studies', tk('author'), { title: 'Cloud move', scenario: 'Too short.' })).status, 422);
    const cs = await call('POST', '/admin/case-studies', tk('author'), { title: 'Warehouse cloud move', scenario });
    assert.equal(cs.status, 201);
    assert.match(cs.body.publicCode, /^CS-\d{4}$/);
    assert.equal(cs.body.status, 'draft');
    assert.equal((await call('PUT', `/admin/case-studies/${cs.body.id}`, tk('reviewer'), { title: 'x', scenario })).status, 403);
    const renamed = await call('PUT', `/admin/case-studies/${cs.body.id}`, tk('author'), { title: 'Warehouse move to the cloud', scenario });
    assert.equal(renamed.body.title, 'Warehouse move to the cloud');
    const fetched = await call('GET', `/admin/case-studies/${cs.body.id}`, tk('reviewer'));
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.title, 'Warehouse move to the cloud');
    assert.equal((await call('GET', '/admin/case-studies/00000000-0000-4000-8000-00000000ffff', tk('reviewer'))).status, 404);

    const ids: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const q = await call('POST', '/admin/questions', tk('author'), draft({ caseStudyId: cs.body.id, stem: `Case question number ${i}: what should the project manager do first in this situation?` }));
      assert.equal(q.status, 201);
      assert.equal(q.body.caseOrdinal, i);
      ids.push(q.body.id);
    }
    const early = await call('POST', `/admin/case-studies/${cs.body.id}/publish`, tk('admin'));
    assert.equal(early.body.code, 'case_not_ready');
    for (const id of ids) {
      await throughGates(id);
      assert.equal((await move('admin', id, { action: 'publish' })).body.workflowState, 'published');
    }
    let pool = await store.pool(activeId);
    assert.ok(ids.every((id) => pool.find((q) => q.versionId === id)!.status === 'draft'));

    assert.equal((await call('POST', `/admin/case-studies/${cs.body.id}/publish`, tk('reviewer'))).status, 403);
    const published = await call('POST', `/admin/case-studies/${cs.body.id}/publish`, tk('admin'));
    assert.equal(published.body.status, 'published');
    assert.deepEqual(published.body.questions.map((q: Json) => q.caseOrdinal), [1, 2, 3]);
    pool = await store.pool(activeId);
    assert.ok(ids.every((id) => pool.find((q) => q.versionId === id)!.status === 'published'));
    assert.equal((await call('PUT', `/admin/case-studies/${cs.body.id}`, tk('author'), { title: 'Changed', scenario })).body.code, 'state');
    assert.equal((await call('POST', '/admin/questions', tk('author'), draft({ caseStudyId: cs.body.id }))).body.code, 'unknown_case');
    const list = await call('GET', '/admin/case-studies?status=published', tk('reviewer'));
    assert.ok(list.body.items.some((c: Json) => c.id === cs.body.id && c.questionCount === 3));

    const withdrawn = await call('POST', `/admin/case-studies/${cs.body.id}/withdraw`, tk('admin'));
    assert.equal(withdrawn.body.status, 'withdrawn');
    pool = await store.pool(activeId);
    assert.ok(ids.every((id) => pool.find((q) => q.versionId === id)!.status === 'draft'));

    const lonely = await call('POST', '/admin/case-studies', tk('author'), { title: 'One question only', scenario });
    const single = await call('POST', '/admin/questions', tk('author'), draft({ caseStudyId: lonely.body.id, stem: 'The only question of a case study that is too small to publish.' }));
    await throughGates(single.body.id);
    await move('admin', single.body.id, { action: 'publish' });
    assert.equal((await call('POST', `/admin/case-studies/${lonely.body.id}/publish`, tk('admin'))).body.code, 'case_size');
  });

  it('shows question reports to staff for triage', async () => {
    const s = await call('POST', '/practice/sessions', student, { mode: 'quick', questionCount: 1 });
    const item = (await store.practiceItem(s.body.id, (await store.userByEmail('stu@example.test'))!.id, 1))!;
    const answer = await call('POST', `/practice/sessions/${s.body.id}/questions/1/answer`, student, {
      selectedOptionIds: [item.question.options[0]!.id],
    });
    await call('POST', '/question-reports', student, { reportToken: answer.body.reportToken, reason: 'typo', comment: 'Spelling in option B' });
    const list = await call('GET', '/admin/question-reports', tk('reviewer'));
    assert.equal(list.status, 200);
    const mine = list.body.items.find((r: Json) => r.comment === 'Spelling in option B');
    assert.ok(mine);
    assert.equal(mine.reason, 'typo');
    assert.match(mine.publicCode, /^(SYN|Q)-/);
    assert.equal((await call('GET', '/admin/question-reports', student)).status, 403);
  });

  it('stores image and table exhibits, attaches them, and serves images only through signed addresses', async () => {
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const up = (body: Json) => call('POST', '/admin/exhibits', tk('author'), body);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
    assert.equal((await up({ kind: 'image', mimeType: 'image/png', dataBase64: svg, altText: 'A chart' })).body.errors[0].field, 'dataBase64');
    assert.equal((await up({ kind: 'image', mimeType: 'image/jpeg', dataBase64: PNG, altText: 'A chart' })).body.errors[0].field, 'mimeType');
    const big = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(1_100_000)]).toString('base64');
    assert.equal((await up({ kind: 'image', mimeType: 'image/png', dataBase64: big, altText: 'Too large' })).status, 422);
    assert.equal((await up({ kind: 'image', mimeType: 'image/png', dataBase64: PNG, altText: 'x' })).body.errors[0].field, 'altText');
    assert.equal((await up({ kind: 'table', altText: 'Ragged table', table: { header: ['A', 'B'], rows: [['1']] } })).status, 422);
    assert.equal((await call('POST', '/admin/exhibits', tk('reviewer'), { kind: 'table', altText: 'x x x', table: { header: ['A'], rows: [['1']] } })).status, 403);

    const img = await up({ kind: 'image', mimeType: 'image/png', dataBase64: PNG, altText: 'Burndown chart for iteration 4' });
    assert.equal(img.status, 201);
    const table = await up({ kind: 'table', altText: 'Earned value figures', table: { header: ['Measure', 'Value'], rows: [['PV', '200,000'], ['EV', '180,000'], ['AC', '225,000']] } });
    assert.equal(table.status, 201);

    // The signed address works without a token; anything else is not found.
    const pic = await fetch(base + img.body.url);
    assert.equal(pic.status, 200);
    assert.equal(pic.headers.get('content-type'), 'image/png');
    assert.equal(pic.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await pic.arrayBuffer()), Buffer.from(PNG, 'base64'));
    const u = new URL(base + img.body.url);
    assert.equal((await fetch(`${base}/api/v1/exhibits/${img.body.id}`)).status, 404);
    assert.equal((await fetch(`${base}${u.pathname}?exp=${u.searchParams.get('exp')}&sig=${'A'.repeat(43)}`)).status, 404);
    assert.equal((await fetch(`${base}${u.pathname}?exp=${Number(u.searchParams.get('exp')) + 60}&sig=${u.searchParams.get('sig')}`)).status, 404);

    const ids = [img.body.id, table.body.id];
    assert.equal((await call('POST', '/admin/questions', tk('author'), draft({ exhibitIds: ['00000000-0000-4000-8000-00000000abcd'] }))).body.code, 'unknown_exhibit');
    assert.equal((await call('POST', '/admin/questions', tk('author'), draft({ exhibitIds: [...ids, ids[0]] }))).status, 422);
    const stem = 'Review the burndown chart and the earned value table. What is the best description of the project status?';
    const q = await call('POST', '/admin/questions', tk('author'), draft({ taskCode: 'BUSINESS-8', graphic: true, exhibitIds: ids, stem }));
    assert.equal(q.status, 201);
    assert.deepEqual(q.body.exhibits.map((e: Json) => e.kind), ['image', 'table']);
    assert.match(q.body.exhibits[0].url, /^\/api\/v1\/exhibits\/.+\?exp=\d+&sig=/);
    assert.equal(q.body.exhibits[1].table.rows[2][1], '225,000');

    await throughGates(q.body.id);
    await move('admin', q.body.id, { action: 'publish' });
    assert.throws(() => store.query(`DELETE FROM question_exhibits WHERE question_version_id = '${q.body.id}';`));
    const v2 = await call('POST', `/admin/questions/${q.body.questionId}/versions`, tk('author'));
    assert.deepEqual(v2.body.exhibits.map((e: Json) => e.altText), ['Burndown chart for iteration 4', 'Earned value figures']);

    // Candidates get the table inline and the image as a signed address, never the exhibit id on its own.
    const session = await call('POST', '/practice/sessions', student, { mode: 'focused', questionCount: 100, taskCodes: ['BUSINESS-8'] });
    const studentId = (await store.userByEmail('stu@example.test'))!.id;
    let ordinal = 0;
    for (let i = 1; i <= session.body.questionCount && !ordinal; i++) {
      if ((await store.practiceItem(session.body.id, studentId, i))!.question.stem === stem) ordinal = i;
    }
    assert.ok(ordinal > 0);
    const view = await call('GET', `/practice/sessions/${session.body.id}/questions/${ordinal}`, student);
    assert.deepEqual(Object.keys(view.body.exhibits[0]).sort(), ['altText', 'kind', 'url']);
    assert.deepEqual(Object.keys(view.body.exhibits[1]).sort(), ['altText', 'kind', 'table']);
    assert.equal((await fetch(base + view.body.exhibits[0].url)).status, 200);
    clock.t += 5 * 3600 * 1000;
    assert.equal((await fetch(base + view.body.exhibits[0].url)).status, 404);
    for (const who of Object.keys(STAFF) as Array<keyof typeof STAFF>) await signIn(who);
    const login = await call('POST', '/auth/login', undefined, { email: 'stu@example.test', password: 'student passphrase' });
    student = login.body.accessToken;
  });

  it('shows administrators the audit trail, filtered and paged, and nobody else', async () => {
    const all = await call('GET', '/admin/audit?limit=5', tk('admin'));
    assert.equal(all.status, 200);
    assert.equal(all.body.items.length, 5);
    assert.ok(all.body.nextCursor);
    const ids = all.body.items.map((x: Json) => Number(x.id));
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a), 'newest first');
    const next = await call('GET', `/admin/audit?limit=5&cursor=${all.body.nextCursor}`, tk('admin'));
    assert.ok(Number(next.body.items[0].id) < ids[4]!);
    const prices = await call('GET', '/admin/audit?action=plan', tk('admin'));
    assert.ok(prices.body.items.length >= 1 && prices.body.items.every((x: Json) => x.action.startsWith('plan')));
    const mine = await call('GET', `/admin/audit?actor=${STAFF.author.email}`, tk('admin'));
    assert.ok(mine.body.items.length >= 1 && mine.body.items.every((x: Json) => x.actor === STAFF.author.email));
    assert.equal((await call('GET', '/admin/audit?action=DROP%20TABLE', tk('admin'))).status, 422);
    assert.equal((await call('GET', '/admin/audit', tk('reviewer'))).status, 403);
  });

  it('lets administrators change roles and reset two-factor sign-in, but not their own', async () => {
    assert.equal((await call('GET', '/admin/users?q=example', tk('reviewer'))).status, 403);
    const found = await call('GET', '/admin/users?q=example.test', tk('admin'));
    const byEmail = (e: string) => found.body.items.find((u: Json) => u.email === e);
    assert.equal(byEmail(STAFF.reviewer.email).mfaEnabled, true);
    const stu = byEmail('stu@example.test');
    assert.deepEqual(stu.roles, ['student']);

    assert.equal((await call('PUT', `/admin/users/${stu.id}/roles`, tk('admin'), { roles: ['student', 'boss'] })).status, 422);
    const promoted = await call('PUT', `/admin/users/${stu.id}/roles`, tk('admin'), { roles: ['student', 'content_reviewer'] });
    assert.equal(promoted.status, 200);
    assert.deepEqual(promoted.body.roles, ['student', 'content_reviewer']);
    assert.equal((await call('GET', '/me', student)).status, 401); // sessions ended by the role change
    const self = await call('PUT', `/admin/users/${STAFF.admin.id}/roles`, tk('admin'), { roles: ['content_reviewer'] });
    assert.equal(self.body.code, 'self_demote');

    assert.equal((await call('POST', `/admin/users/${STAFF.admin.id}/mfa-reset`, tk('admin'))).body.code, 'self_reset');
    assert.equal((await call('POST', `/admin/users/${STAFF.reviewer.id}/mfa-reset`, tk('admin'))).status, 204);
    assert.equal((await call('GET', '/admin/questions?limit=1', tk('reviewer'))).status, 401);
    tick();
    const plain = await call('POST', '/auth/login', undefined, { email: STAFF.reviewer.email, password: PASS });
    assert.equal(plain.status, 200);
    assert.equal((await call('GET', '/admin/questions?limit=1', plain.body.accessToken)).body.code, 'mfa_required');
    assert.equal(store.query(`SELECT count(*) FROM mfa_recovery_codes WHERE user_id = '${STAFF.reviewer.id}';`), '0');
    assert.equal(store.query(`SELECT count(*) FROM audit_logs WHERE action IN ('user.roles', 'user.mfa_reset');`), '2');
  });
});
