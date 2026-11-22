// Full journey: a brand-new database, the real question bank from
// content/pmp-question-bank-complete.xlsx, the first administrator, and one
// candidate who uses every feature of the app. Checks every response against
// api/openapi.yaml where a schema exists.
//   eval "$(scripts/pg-temp.sh start)" && (cd packages/api && node --test test/journey.test.ts)

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

const configured = Boolean(process.env.PGDATABASE);
const ROOT = new URL('../../../', import.meta.url).pathname;
const DB = 'pmpsim_journey';
if (configured) {
  execFileSync('psql', ['-qAtX', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB}`, '-c', `CREATE DATABASE ${DB}`], { env: process.env });
  process.env.PGDATABASE = DB;
  execFileSync('node', [`${ROOT}scripts/migrate.ts`], { env: process.env, encoding: 'utf8' });
  execFileSync('node', [`${ROOT}scripts/create-admin.ts`, '--email', 'owner@example.test'], { env: { ...process.env, ADMIN_PASSWORD: 'owner passphrase 2026' }, encoding: 'utf8' });
}

const { MockExamService } = await import('../../exam-store/src/service.ts');
const { ApiStore } = await import('../src/api-store.ts');
const { PgPool } = await import('../../exam-store/src/pg-wire.ts');
const { DEFAULT_APP_CONFIG, createApp } = await import('../src/app.ts');
const { totpCode, totpStep } = await import('../src/auth.ts');
const { readXlsx, readXlsxSheets } = await import('../src/xlsx.ts');
const { correctAnswer } = await import('../../exam-engine/src/index.ts');
type Mail = import('../src/app.ts').Mail;
type Json = Record<string, any>;

const MIN = 60_000;
const contract = configured
  ? (JSON.parse(execFileSync('python3', ['-c', 'import yaml,json,sys;print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', `${ROOT}api/openapi.yaml`], { encoding: 'utf8' })) as Json)
  : {};
function check(schema: Json, value: unknown, path: string): void {
  if (schema.$ref) return check(contract.components.schemas[schema.$ref.split('/').pop()], value, path);
  if (schema.oneOf || schema.allOf) return;
  const types: string[] = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (value === null) return assert.ok(types.includes('null') || types.length === 0, `${path} must not be null`);
  if (types.includes('array')) { assert.ok(Array.isArray(value), `${path} must be an array`); (value as unknown[]).forEach((v, i) => schema.items && check(schema.items, v, `${path}[${i}]`)); return; }
  if (types.includes('object')) {
    assert.equal(typeof value, 'object', `${path} must be an object`);
    for (const key of schema.required ?? []) assert.ok(key in (value as Json), `${path}.${key} is required`);
    for (const [key, v] of Object.entries(value as Json)) {
      if (schema.properties?.[key]) check(schema.properties[key], v, `${path}.${key}`);
      else if (schema.additionalProperties === false) assert.fail(`${path}.${key} is not in the contract`);
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
const b32decode = (s: string): Buffer => {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0; let v = 0; const out: number[] = [];
  for (const ch of s) { v = ((v << 5) | a.indexOf(ch)) & 0xffff; bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
};

describe('full journey on a new database with the real question bank', { skip: configured ? false : 'PGDATABASE is not set; see scripts/pg-temp.sh' }, () => {
  const db = new PgPool(undefined, { max: 4 });
  const store = new ApiStore(db);
  const clock = { t: Date.now() };
  const outbox: Mail[] = [];
  const server = createServer(createApp({ store, service: new MockExamService(store), now: () => clock.t, mailer: (m) => outbox.push(m),
    config: { ...DEFAULT_APP_CONFIG, tokenSecret: 'journey-secret-not-for-production-0123456789', authRateLimit: 500 } }));
  let base = '';
  const call = async (method: string, path: string, token?: string, body?: unknown, lang?: string): Promise<{ status: number; body: Json; text: string }> => {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (lang) headers['accept-language'] = lang;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(`${base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let parsed: Json = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
    return { status: r.status, body: parsed, text };
  };
  const ok = (r: { status: number; body: Json }, status = 200, what = '') => assert.equal(r.status, status, `${what} ${JSON.stringify(r.body).slice(0, 400)}`);
  const sql = (q: string) => execFileSync('psql', ['-qAtX', '-d', DB, '-c', q], { env: process.env, encoding: 'utf8' }).trim();

  let admin = '';
  let stu = { accessToken: '', refreshToken: '' };
  let stuId = '';
  const report: string[] = [];
  const note = (s: string) => { report.push(s); console.log('JOURNEY ' + s); };

  before(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await db.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('starts empty: health, site, tips, plans, active blueprint, landing pages', async () => {
    const h = await call('GET', '/health'); ok(h); assert.equal(h.body.database, 'ok');
    ok(await call('GET', '/site'));
    const tips = await call('GET', '/tips'); ok(tips); assert.ok(tips.body.items.length >= 20, 'tips are seeded');
    const plans = await call('GET', '/plans'); ok(plans); assert.ok(plans.body.items.length >= 1);
    assert.equal(sql('SELECT count(*) FROM questions'), '0');
    note(`empty start ok: ${tips.body.items.length} tips, ${plans.body.items.length} plans, 26 tasks`);
  });

  it('lets the first administrator in with two-factor sign-in', async () => {
    const login = await call('POST', '/auth/login', undefined, { email: 'owner@example.test', password: 'owner passphrase 2026' });
    ok(login);
    assert.equal((await call('GET', '/admin/questions', login.body.accessToken)).body.code, 'mfa_required');
    const setup = await call('POST', '/auth/mfa/setup', login.body.accessToken); ok(setup);
    const secret = b32decode(setup.body.secret);
    ok(await call('POST', '/auth/mfa/enable', login.body.accessToken, { code: totpCode(secret, totpStep(clock.t)) }));
    clock.t += 31_000;
    const again = await call('POST', '/auth/login', undefined, { email: 'owner@example.test', password: 'owner passphrase 2026', otp: totpCode(secret, totpStep(clock.t)) });
    ok(again);
    admin = again.body.accessToken;
    ok(await call('GET', '/admin/questions', admin));
  });

  it('imports and publishes the whole bank file through the admin import', async () => {
    const html = readFileSync(`${ROOT}packages/admin-web/index.html`, 'utf8');
    const gridToDrafts = new Function(html.slice(html.indexOf('function gridToDrafts'), html.indexOf('/** Case studies from a sheet')) + '; return gridToDrafts;')();
    const gridToCases = new Function(html.slice(html.indexOf('function gridToCases'), html.indexOf('function importView')) + '; return gridToCases;')();
    const sheets = readXlsxSheets(readFileSync(`${ROOT}content/pmp-question-bank-complete.xlsx`));
    const all = gridToDrafts(sheets[0]!.rows);
    const cases = gridToCases(sheets.find((x) => /case/i.test(x.name))!.rows) as Array<Record<string, string>>;
    assert.equal(all.length, 671);
    assert.equal(cases.length, 10);
    // As the admin panel does: create the case studies the rows use, then attach the rows.
    const ids: Record<string, string> = {};
    for (const c of cases) {
      const r = await call('POST', '/admin/case-studies', admin, { title: c.title, scenario: c.scenario, titleAr: c.titleAr, scenarioAr: c.scenarioAr });
      ok(r, 201, `case ${c.key}`); ids[c.key!] = r.body.id;
    }
    const rows = all.map(({ caseKey, ...d }: Json) => (caseKey ? { ...d, caseStudyId: ids[caseKey] } : d));
    assert.equal(rows.filter((r: Json) => r.caseStudyId).length, 38);
    for (let i = 0; i < rows.length; i += 300) {
      const dry = await call('POST', '/admin/imports', admin, { rows: rows.slice(i, i + 300) });
      ok(dry); assert.equal(dry.body.summary.invalid, 0, JSON.stringify(dry.body).slice(0, 500));
    }
    let published = 0; let committed = 0;
    for (let i = 0; i < rows.length; i += 100) {
      const r = await call('POST', '/admin/imports', admin, { rows: rows.slice(i, i + 100), commit: true, publishNow: true, reviewedConfirmed: true, originalityDeclared: true });
      ok(r, 200, `chunk ${i}`);
      published += r.body.summary.published; committed += r.body.summary.committed;
      assert.equal(r.body.summary.publishFailed, 0);
    }
    let casesPublished = 0;
    for (const id of Object.values(ids)) { ok(await call('POST', `/admin/case-studies/${id}/publish`, admin), 200, 'case publish'); casesPublished++; }
    const cs = await call('GET', `/admin/case-studies/${ids.WATER}`, admin);
    assert.equal(cs.body.questions.length, 5); assert.ok(cs.body.scenarioAr.length > 100);
    note(`case studies: ${casesPublished} published with their questions`);
    const byType = sql(`SELECT string_agg(type_code || '=' || n, ' ' ORDER BY type_code) FROM (SELECT v.type_code, count(*) n FROM questions q JOIN question_versions v ON v.id = q.current_version_id WHERE q.status = 'published' GROUP BY 1) x`);
    const ar = sql(`SELECT count(*) FROM questions q JOIN question_versions v ON v.id = q.current_version_id WHERE q.status = 'published' AND v.stem_ar IS NOT NULL`);
    note(`import: ${rows.length} rows, ${committed} new, ${published} published; by type: ${byType}; with Arabic stem: ${ar}`);
    assert.ok(Number(sql(`SELECT count(*) FROM questions WHERE status = 'published'`)) >= 600);
    // A second import of the same file changes nothing new (duplicates are recognised).
    const before = sql(`SELECT count(*) FROM questions`);
    const re = await call('POST', '/admin/imports', admin, { rows: rows.slice(0, 50), commit: true });
    ok(re); assert.equal(sql(`SELECT count(*) FROM questions`), before, 'a second import of the same rows adds no copies');
  });

  it('runs the admin tools: export, tips, blueprints, users, reports, difficulty, audit, case studies, plans, access codes', async () => {
    const ex = await call('GET', '/admin/exports/questions', admin); ok(ex);
    assert.ok(ex.body.count >= 600);
    // The export is a full copy: questions with their case keys, and the case studies sheet.
    const exSheets = readXlsxSheets(Buffer.from(ex.body.dataBase64, 'base64'));
    assert.deepEqual(exSheets.map((x) => x.name), ['Questions', 'Case studies', 'Summary']);
    assert.equal(exSheets[1]!.rows.length - 1, 10);
    const ck = exSheets[0]!.rows[0]!.indexOf('caseKey');
    assert.equal(exSheets[0]!.rows.slice(1).filter((r) => r[ck]).length, 38);
    const tips = await call('GET', '/admin/tips', admin); ok(tips);
    const items = tips.body.items as Json[];
    const edited = items.map((t, i) => (i === 0 ? { ...t, items: [{ en: 'Tip edited in the journey test', ar: 'نصيحة معدلة في الاختبار' }, ...t.items] } : t));
    ok(await call('PUT', '/admin/tips', admin, { sections: edited }), 200, 'tips save');
    assert.match((await call('GET', '/tips')).text, /edited in the journey test/);
    ok(await call('PUT', '/admin/tips', admin, { sections: items }), 200, 'tips restore');
    const bps = await call('GET', '/admin/blueprints', admin); ok(bps);
    const active = (bps.body.items as Json[]).find((b) => b.status === 'active');
    const dry = await call('POST', `/admin/blueprints/${active!.id}/dry-run`, admin, {}); ok(dry, 200, 'dry run');
    assert.equal(dry.body.valid, dry.body.attempted, 'every trial mock exam can be built from the bank');
    note(`blueprint dry run: ${JSON.stringify(dry.body).slice(0, 300)}`);
    for (const p of ['/admin/users', '/admin/question-reports', '/admin/question-difficulty', '/admin/audit', '/admin/case-studies', '/admin/plans', '/admin/certificates', '/admin/questions?state=published']) {
      ok(await call('GET', p, admin), 200, p);
    }
    const codes = await call('POST', '/admin/access-codes', admin, { planCode: 'pass30', count: 2, days: 30, label: 'Journey test' }); ok(codes, 201);
    process.env.JOURNEY_CODE = codes.body.codes[0];
  });

  it('lets the administrator create a ready-to-use test account and confirm an email', async () => {
    const r = await call('POST', '/admin/users', admin, { email: 'tester@example.test', language: 'ar', days: 7 });
    ok(r, 201, 'create test account');
    assert.match(r.body.temporaryPassword, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
    assert.equal(r.body.access.entitled, true);
    assert.equal((await call('POST', '/admin/users', admin, { email: 'tester@example.test' })).status, 409, 'no duplicates');
    const login = await call('POST', '/auth/login', undefined, { email: 'tester@example.test', password: r.body.temporaryPassword }); ok(login, 200, 'tester signs in');
    assert.equal((await call('GET', '/me', login.body.accessToken)).body.language, 'ar');
    // The tester changes the temporary password; the old one stops working.
    assert.equal((await call('POST', '/me/password', login.body.accessToken, { currentPassword: 'wrong one 123', newPassword: 'tester new pass 2026' })).status, 403);
    const ch = await call('POST', '/me/password', login.body.accessToken, { currentPassword: r.body.temporaryPassword, newPassword: 'tester new pass 2026' }); ok(ch, 200, 'change password');
    ok(await call('GET', '/me', ch.body.accessToken), 200, 'new tokens work');
    assert.equal((await call('GET', '/me', login.body.accessToken)).status, 401, 'old session signed out');
    assert.equal((await call('POST', '/auth/login', undefined, { email: 'tester@example.test', password: r.body.temporaryPassword })).status, 401);
    // Someone who registered but got no email can be confirmed by the administrator.
    ok(await call('POST', '/auth/register', undefined, { email: 'noemail@example.test', password: 'no email pass 2026', acceptTerms: true }), 201);
    assert.equal((await call('POST', '/auth/login', undefined, { email: 'noemail@example.test', password: 'no email pass 2026' })).body.code, 'email_not_verified');
    const found = await call('GET', '/admin/users?q=noemail', admin);
    assert.equal(found.body.items[0].emailVerified, false);
    ok(await call('POST', `/admin/users/${found.body.items[0].id}/verify-email`, admin), 204, 'confirm email');
    ok(await call('POST', '/auth/login', undefined, { email: 'noemail@example.test', password: 'no email pass 2026' }), 200, 'confirmed user signs in');
    assert.ok(sql(`SELECT count(*) FROM audit_logs WHERE action IN ('user.create_by_admin', 'user.verify_by_admin')`) === '2');
  });

  it('signs a candidate up in Arabic, on the free plan', async () => {
    ok(await call('POST', '/auth/register', undefined, { email: 'sara@example.test', password: 'sara passphrase 2026', language: 'ar', acceptTerms: true }), 201);
    ok(await call('POST', '/auth/verify-email', undefined, { token: outbox.findLast((m) => m.to === 'sara@example.test')!.token }), 204);
    const login = await call('POST', '/auth/login', undefined, { email: 'sara@example.test', password: 'sara passphrase 2026' }); ok(login);
    stu = login.body as typeof stu;
    const me = await call('GET', '/me', stu.accessToken); ok(me); assert.equal(me.body.language, 'ar'); stuId = me.body.id;
    ok(await call('PATCH', '/me', stu.accessToken, { examTargetDate: new Date(clock.t + 30 * 86_400_000).toISOString().slice(0, 10) }), 200, 'exam date');
    const bp = await call('GET', '/blueprints/active', stu.accessToken); ok(bp, 200, 'blueprint');
    assert.equal(bp.body.domains.reduce((n: number, d: Json) => n + d.tasks.length, 0), 26);
    const acc = await call('GET', '/me/access', stu.accessToken); ok(acc);
    assert.equal(acc.body.entitled, false);
    note(`free plan: ${acc.body.practiceLeftToday} practice questions a day`);
    assert.equal((await call('POST', '/exams/attempts', stu.accessToken)).status, 402, 'mock exams are locked on the free plan');
    const ref = await call('POST', '/auth/refresh', undefined, { refreshToken: stu.refreshToken }); ok(ref);
    stu = ref.body as typeof stu;
  });

  it('unlocks full access with an access code', async () => {
    const coupon = await call('POST', '/me/coupon', stu.accessToken, { code: 'NOPE' });
    note(`unknown coupon: ${coupon.status} ${JSON.stringify(coupon.body)}`);
    const r = await call('POST', '/me/redeem', stu.accessToken, { code: process.env.JOURNEY_CODE }); ok(r);
    assert.equal((await call('GET', '/me/access', stu.accessToken)).body.entitled, true);
  });

  it('runs the recorded course: admin builds it, free and paid lessons, progress, certificate, products', async () => {
    const t = stu.accessToken;
    // The simulator pass from the access code does not include the course.
    assert.equal((await call('GET', '/me/access', t)).body.course, false);
    const plans = await call('GET', '/plans?region=EG', t);
    assert.deepEqual(plans.body.items.filter((p: Json) => p.code === 'bundle90')[0].includes, ['simulator', 'course']);
    // Admin builds a module with three lessons.
    const m = await call('POST', '/admin/course/modules', admin, { title: 'Module 1: People', titleAr: 'الوحدة 1: الأفراد', ordinal: 1, status: 'published' }); ok(m, 201, 'module');
    const bad = await call('POST', '/admin/course/lessons', admin, { moduleId: m.body.id, title: 'Bad', videoProvider: 'youtube', videoRef: 'not a link', durationSeconds: 5 });
    assert.equal(bad.status, 422);
    const free = await call('POST', '/admin/course/lessons', admin, { moduleId: m.body.id, title: 'Welcome', titleAr: 'مقدمة', videoProvider: 'youtube', videoRef: 'https://youtu.be/dQw4w9WgXcQ?t=3', durationSeconds: 120, isFree: true, ordinal: 1, status: 'published', taskCodes: ['PEOPLE-1'] }); ok(free, 201, 'free lesson');
    const paid = await call('POST', '/admin/course/lessons', admin, { moduleId: m.body.id, title: 'Conflict', videoProvider: 'url', videoRef: 'https://cdn.example.test/v/conflict.mp4', durationSeconds: 600, ordinal: 2, status: 'published', taskCodes: ['PEOPLE-2'] }); ok(paid, 201, 'paid lesson');
    const read = await call('POST', '/admin/course/lessons', admin, { moduleId: m.body.id, title: 'Reading', videoProvider: 'none', ordinal: 3, status: 'published' }); ok(read, 201, 'reading lesson');
    const pdf = Buffer.from('%PDF-1.4\n%journey\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    assert.equal((await call('PUT', `/admin/course/lessons/${paid.body.id}/slides`, admin, { filename: 'x.pdf', dataBase64: Buffer.from('not a pdf').toString('base64') })).status, 422);
    ok(await call('PUT', `/admin/course/lessons/${paid.body.id}/slides`, admin, { filename: 'conflict.pdf', dataBase64: pdf.toString('base64') }), 204, 'slides');
    const ac = await call('GET', '/admin/course', admin); ok(ac);
    assert.equal(ac.body.modules[0].lessons.length, 3);
    assert.equal(ac.body.modules[0].lessons[0].videoRef, 'dQw4w9WgXcQ');
    assert.equal(ac.body.modules[0].lessons[1].slides.filename, 'conflict.pdf');
    // The learner without the course: outline with locks; free lesson plays; paid lesson refused.
    const o = await call('GET', '/course', t); ok(o);
    assert.equal(o.body.access, false);
    assert.deepEqual(o.body.modules[0].lessons.map((l: Json) => l.locked), [false, true, true]);
    const fl = await call('GET', `/course/lessons/${free.body.id}`, t); ok(fl);
    assert.equal(fl.body.playback.kind, 'youtube');
    assert.match(fl.body.playback.embedUrl, /^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/);
    assert.equal(fl.body.next.id, paid.body.id);
    assert.equal((await call('GET', `/course/lessons/${paid.body.id}`, t)).status, 402);
    assert.equal((await fetch(`${base}/api/v1/course/lessons/${paid.body.id}/slides`, { headers: { authorization: `Bearer ${t}` } })).status, 402);
    // Watched time counts only what the clock allows: a burst of saves cannot finish a lesson.
    const p1 = await call('PUT', `/course/lessons/${free.body.id}/progress`, t, { positionSeconds: 100, addSeconds: 100 }); ok(p1);
    assert.ok(p1.body.watchedSeconds <= 10, 'cannot claim more than the elapsed time');
    sql(`UPDATE lesson_progress SET updated_at = now() - interval '2 minutes' WHERE lesson_id = '${free.body.id}'`);
    const p2 = await call('PUT', `/course/lessons/${free.body.id}/progress`, t, { positionSeconds: 118, addSeconds: 110 }); ok(p2);
    assert.equal(p2.body.completed, true, '80% watched completes the lesson');
    // The course is bought (granted here): everything opens, separately from the simulator pass.
    const sim = (await call('GET', '/me/access', t)).body.endsAt;
    const who = (await call('GET', '/admin/users?q=sara@', admin)).body.items[0].id;
    ok(await call('POST', `/admin/users/${who}/grant`, admin, { planCode: 'course90', days: 90 }), 200, 'grant course');
    const acc = (await call('GET', '/me/access', t)).body;
    assert.equal(acc.course, true);
    assert.equal(acc.endsAt, sim, 'the course pass does not move the simulator pass');
    assert.ok(Date.parse(acc.courseEndsAt) - clock.t < 91 * 86_400_000, 'the course pass starts now, not after the simulator pass');
    const pl = await call('GET', `/course/lessons/${paid.body.id}`, t); ok(pl);
    assert.deepEqual(pl.body.playback, { kind: 'file', src: 'https://cdn.example.test/v/conflict.mp4' });
    const sl = await fetch(`${base}/api/v1/course/lessons/${paid.body.id}/slides`, { headers: { authorization: `Bearer ${t}` } });
    assert.equal(sl.status, 200); assert.equal(sl.headers.get('content-type'), 'application/pdf');
    assert.equal(Buffer.from(await sl.arrayBuffer()).toString('latin1').slice(0, 5), '%PDF-');
    // Not finished yet: no certificate.
    assert.equal((await call('POST', '/course/certificate', t, { fullName: 'Sara Ahmed' })).status, 409);
    sql(`UPDATE lesson_progress SET updated_at = now() - interval '20 minutes' WHERE user_id = '${stuId}'`);
    sql(`INSERT INTO lesson_progress (user_id, lesson_id, updated_at) VALUES ('${stuId}', '${paid.body.id}', now() - interval '20 minutes') ON CONFLICT DO NOTHING`);
    for (let k = 0; k < 6; k++) {
      sql(`UPDATE lesson_progress SET updated_at = now() - interval '3 minutes' WHERE user_id = '${stuId}' AND lesson_id = '${paid.body.id}'`);
      await call('PUT', `/course/lessons/${paid.body.id}/progress`, t, { positionSeconds: 100 * (k + 1), addSeconds: 120 });
    }
    assert.equal((await call('PUT', `/course/lessons/${read.body.id}/progress`, t, { complete: true })).body.completed, true);
    const o2 = (await call('GET', '/course', t)).body;
    assert.deepEqual([o2.completed, o2.lessons], [3, 3]);
    const cert = await call('POST', '/course/certificate', t, { fullName: 'Sara Ahmed' }); ok(cert, 201, 'certificate');
    assert.equal(cert.body.lessons, 3);
    assert.ok(Number(cert.body.hours) > 0 && Number(cert.body.hours) <= 0.2);
    const again = await call('POST', '/course/certificate', t, { fullName: 'Someone Else' });
    assert.equal(again.body.token, cert.body.token, 'one certificate per learner');
    const pub = await call('GET', `/course-certificates/${cert.body.token}`); ok(pub, 200, 'public verify');
    assert.equal(pub.body.fullName, 'Sara Ahmed');
    // A lesson with progress can still be deleted by the admin; a module with lessons cannot.
    assert.equal((await call('DELETE', `/admin/course/modules/${m.body.id}`, admin)).status, 409);
    note(`course: 1 module, 3 lessons (YouTube free, file paid with PDF, reading), progress, certificate ${cert.body.hours} h`);
  });

  // Answers one practice question, right or wrong, in the format of its type.
  const answer = async (sessionId: string, ordinal: number, right: boolean) => {
    const q = await call('GET', `/practice/sessions/${sessionId}/questions/${ordinal}`, stu.accessToken); ok(q);
    conforms('CandidateQuestion', q.body);
    assert.ok(!/isCorrect|rationale|explanation/i.test(q.text), 'no key before the answer');
    const item = (await store.practiceItem(sessionId, stuId, ordinal))!;
    const key = correctAnswer(item.question);
    let sel = key;
    if (!right) {
      const t = item.question.type;
      if (t === 'numeric') sel = ['987654321'];
      else if (t === 'ordering') sel = [...key].reverse();
      else if (t === 'matching') { const ids = key.map((k) => k.split(':')[1]); sel = key.map((k, i) => `${k.split(':')[0]}:${ids[(i + 1) % ids.length]}`); }
      else { const wrong = item.question.options.find((o) => !o.isCorrect)!.id; sel = t === 'multiple' ? [wrong, ...key.slice(1)] : [wrong]; }
    }
    const fb = await call('POST', `/practice/sessions/${sessionId}/questions/${ordinal}/answer`, stu.accessToken, { selectedOptionIds: sel, timeSpentMs: 40_000 }, 'ar');
    ok(fb, 200, `answer ${item.question.type}`);
    conforms('AnswerFeedback', fb.body);
    assert.equal(fb.body.correct, right, `${item.question.type} graded ${right ? 'right' : 'wrong'}`);
    assert.deepEqual(fb.body.correctAnswer, key);
    if (!right) assert.equal(typeof fb.body.errorType, 'string');
    return { q: q.body, fb: fb.body, type: item.question.type as string };
  };

  it('practises every question type, right and wrong, with explanations and error analysis', async () => {
    const seen: string[] = [];
    for (const type of ['single', 'multiple', 'matching', 'ordering', 'numeric', 'hotspot']) {
      const s = await call('POST', '/practice/sessions', stu.accessToken, { mode: 'focused', questionCount: 2, types: [type] });
      ok(s, 201, type); conforms('PracticeSession', s.body);
      const a = await answer(s.body.id, 1, true);
      const b = await answer(s.body.id, 2, false);
      if (type === 'hotspot') assert.ok(a.q.exhibits.length > 0 && a.q.options.every((o: Json) => Array.isArray(o.cell)), 'hotspot has a table and cells');
      if (type === 'matching') assert.ok(a.q.targets.length === a.q.options.length);
      if (type === 'numeric') assert.equal(a.q.options.length, 0, 'no hint of the number');
      assert.ok(a.fb.explanation.whyCorrect.length > 0);
      seen.push(`${type}: ok (error type on wrong: ${b.fb.errorType})`);
      const sum = await call('GET', `/practice/sessions/${s.body.id}/summary`, stu.accessToken); ok(sum);
      assert.deepEqual([sum.body.overall.total, sum.body.overall.correct], [2, 1]);
    }
    note('question types: ' + seen.join('; '));
    // Table-based single questions show the table.
    const g = sql(`SELECT count(*) FROM question_versions v JOIN questions q ON q.current_version_id = v.id WHERE v.is_graphic AND v.type_code = 'single' AND q.status = 'published'`);
    assert.ok(Number(g) >= 8);
  });

  it('serves every practice mode', async () => {
    const res: string[] = [];
    // Some history first, so weak areas, wrong-only and adaptive have data.
    const warm = await call('POST', '/practice/sessions', stu.accessToken, { mode: 'quick', questionCount: 30 }); ok(warm, 201);
    for (let i = 1; i <= warm.body.questionCount; i++) await answer(warm.body.id, i, i % 3 !== 0);
    for (const mode of ['quick', 'focused', 'weak_areas', 'timed', 'incorrect_only', 'adaptive']) {
      const body: Json = { mode, questionCount: 10 };
      if (mode === 'focused') { body.domainCodes = ['PEOPLE']; body.approaches = ['agile']; }
      const s = await call('POST', '/practice/sessions', stu.accessToken, body);
      res.push(`${mode}=${s.status}${s.status === 201 ? `(${s.body.questionCount})` : `:${s.body.code}`}`);
      if (mode === 'timed') assert.equal(s.body.timeLimitSeconds, s.body.questionCount * 80);
      if (mode !== 'weak_areas') ok(s, 201, mode);
    }
    assert.equal((await call('POST', '/practice/sessions', stu.accessToken, { mode: 'spaced_review', questionCount: 10 })).status, 409, 'nothing due yet');
    sql(`UPDATE spaced_state SET next_review_at = now() - interval '1 minute' WHERE user_id = '${stuId}' AND repetition = 0`);
    const rev = await call('POST', '/practice/sessions', stu.accessToken, { mode: 'spaced_review', questionCount: 10 }); ok(rev, 201, 'spaced review');
    res.push(`spaced_review=${rev.status}(${rev.body.questionCount})`);
    note('practice modes: ' + res.join(' '));
  });

  it('gives hints, bookmarks, notes and question reports', async () => {
    const qid = sql(`SELECT pi.question_id FROM practice_items pi JOIN practice_sessions ps ON ps.id = pi.session_id WHERE ps.user_id = '${stuId}' AND pi.answered_at IS NOT NULL LIMIT 1`);
    for (const hintType of ['general', 'approach', 'eliminate']) {
      const h = await call('POST', '/coach/hint', stu.accessToken, { questionId: qid, hintType }); ok(h, 200, hintType);
      assert.ok(String(h.body.hint).length > 10);
    }
    ok(await call('POST', `/me/bookmarks/${qid}`, stu.accessToken), 200, 'bookmark');
    assert.equal((await call('GET', '/me/bookmarks', stu.accessToken)).body.items.length, 1);
    ok(await call('PUT', `/me/notes/${qid}`, stu.accessToken, { content: 'ملاحظة للمراجعة' }), 200, 'note');
    assert.match((await call('GET', `/me/notes/${qid}`, stu.accessToken)).text, /ملاحظة/);
    const s = await call('POST', '/practice/sessions', stu.accessToken, { mode: 'quick', questionCount: 1 });
    const a = await answer(s.body.id, 1, true);
    ok(await call('POST', '/question-reports', stu.accessToken, { reportToken: a.fb.reportToken, reason: 'typo', comment: 'Journey test report' }), 202);
    assert.equal((await call('GET', '/admin/question-reports', admin)).body.items.length >= 1, true);
  });

  let attemptId = '';
  it('builds a full 180-question mock exam from the bank, with sections and breaks, and scores it', async () => {
    const start = await call('POST', '/exams/attempts', stu.accessToken);
    if (start.status !== 201) { note(`MOCK EXAM COULD NOT START: ${start.status} ${JSON.stringify(start.body)}`); }
    ok(start, 201, 'mock start');
    conforms('AttemptStatus', start.body);
    attemptId = start.body.id;
    const loaded = (await store.loadAttempt(attemptId, stuId))!;
    const byOrdinal = (o: number) => loaded.pool.find((q) => q.id === loaded.form.items[o - 1]!.questionId)!;
    const types: Record<string, number> = {};
    let ordinal = 0; let cases = 0;
    for (let sec = 0; sec < start.body.sections.length; sec++) {
      const qs = await call('GET', `/exams/attempts/${attemptId}/sections/${sec}/questions`, stu.accessToken); ok(qs, 200, `section ${sec}`);
      conforms('SectionQuestions', qs.body);
      cases += Object.keys(qs.body.caseStudies ?? {}).length;
      for (const q of qs.body.questions as Json[]) {
        ordinal = q.ordinal;
        const full = byOrdinal(ordinal);
        types[full.type] = (types[full.type] ?? 0) + 1;
        // Every question is answered correctly except every tenth.
        const key = correctAnswer(full);
        const sel = ordinal % 10 === 0 ? (full.type === 'numeric' ? ['987654321'] : full.type === 'ordering' ? [...key].reverse() : full.type === 'matching' ? key.map((k, i) => `${k.split(':')[0]}:${key[(i + 1) % key.length]!.split(':')[1]}`) : [full.options.find((o) => !o.isCorrect)!.id]) : key;
        const put = await call('PUT', `/exams/attempts/${attemptId}/answers/${ordinal}`, stu.accessToken, { selectedOptionIds: sel, clientSeq: 1, flagged: ordinal % 25 === 0 });
        ok(put, 200, `answer ${ordinal} (${full.type})`);
      }
      ok(await call('GET', `/exams/attempts/${attemptId}/sections/${sec}/review`, stu.accessToken), 200, 'section review');
      if (sec < start.body.sections.length - 1) {
        const closed = await call('POST', `/exams/attempts/${attemptId}/sections/${sec}/close`, stu.accessToken); ok(closed);
        if (closed.body.status === 'on_break') { clock.t += 2 * MIN; ok(await call('POST', `/exams/attempts/${attemptId}/resume`, stu.accessToken)); }
      }
      ok(await call('POST', `/exams/attempts/${attemptId}/heartbeat`, stu.accessToken, {}), 204, 'heartbeat');
    }
    const result = await call('POST', `/exams/attempts/${attemptId}/submit`, stu.accessToken); ok(result);
    conforms('AttemptResult', result.body);
    const o = result.body.overall;
    note(`mock exam: ${o.total} questions, ${o.answered} answered, ${o.correct} correct; ${cases} case studies; types ${JSON.stringify(types)}; band ${result.body.band ?? result.body.overallBand ?? ''}`);
    assert.equal(o.total, 180);
    assert.equal(o.answered, 180);
    assert.equal(o.correct, 180 - 18, 'every tenth answer was wrong, the rest right, for every question type');
    const review = await call('GET', `/exams/attempts/${attemptId}/review?filter=incorrect&limit=100`, stu.accessToken); ok(review);
    assert.equal(review.body.items.length, 18);
    const certs = await call('GET', '/me/certificates', stu.accessToken); ok(certs);
    note(`certificates: ${certs.body.items?.length ?? 0}`);
    if (certs.body.items?.length) {
      const token = certs.body.items[0].verifyToken ?? certs.body.items[0].token;
      if (token) ok(await call('GET', `/verify/${token}`), 200, 'certificate verify');
    }
    assert.equal(Number(sql(`SELECT count(*) FROM attempt_learning WHERE attempt_id = '${attemptId}'`)), 1, 'the mock exam was learned from');
  });

  it('shows learning: dashboard, readiness, mastery, errors, profile, plan, analytics, streak, snapshots', async () => {
    const t = stu.accessToken;
    const d = await call('GET', '/me/dashboard', t); ok(d); conforms('Dashboard', d.body);
    const r = await call('GET', '/me/readiness', t); ok(r);
    const m = await call('GET', '/me/mastery', t); ok(m);
    const e = await call('GET', '/me/errors', t); ok(e);
    const p = await call('GET', '/me/profile', t); ok(p);
    const plan = await call('POST', '/me/study-plan/refresh', t); ok(plan);
    assert.equal(plan.body.days.length, 7);
    for (const dim of ['domain', 'task', 'approach', 'difficulty']) ok(await call('GET', `/me/analytics?dimension=${dim}`, t), 200, dim);
    const dom = await call('GET', '/me/analytics/domains', t); ok(dom);
    assert.ok(dom.body.items.every((x: Json) => x.answered > 0), 'every domain counts its answers');
    ok(await call('GET', '/me/analytics/difficulty', t));
    for (const p2 of ['/me/streak', '/me/weekly-snapshots', '/me/notifications', '/me/referral', '/me/spaced-reviews/due', '/exams/attempts', '/case-studies']) ok(await call('GET', p2, t), 200, p2);
    ok(await call('POST', '/me/weekly-snapshots/refresh', t), 200, 'snapshot');
    ok(await call('POST', '/me/notifications/read-all', t), 204, 'notifications');
    assert.ok(Number(r.body.score) > 50, 'readiness rose after a strong mock exam');
    assert.equal(m.body.items.length, 26, 'mastery on all 26 tasks');
    note(`learning: readiness ${r.body.score}, ${m.body.items.length} tasks with mastery, errors ${e.body.items.map((x: Json) => `${x.errorType}=${x.count}`).join(', ')}, weakest ${p.body.weakestTask?.code}, plan focus ${plan.body.focusAreas.map((f: Json) => f.taskCode).join(',')}`);
    const cs = await call('GET', '/case-studies', t);
    if (cs.body.items?.length) ok(await call('GET', `/case-studies/${cs.body.items[0].id}`, t), 200, 'case study');
    note(`case studies for practice: ${cs.body.items?.length ?? 0}`);
  });

  it('exports the candidate data, resets the password, and deletes the account', async () => {
    const ex = await fetch(`${base}/api/v1/me/export`, { headers: { authorization: `Bearer ${stu.accessToken}` } });
    assert.equal(ex.status, 200);
    const data = JSON.parse(await ex.text()) as Json;
    assert.ok(data.practiceAnswers.length > 30 && data.mockExams.length === 1);
    ok(await call('POST', '/auth/password/reset-request', undefined, { email: 'sara@example.test' }), 202);
    const tok = outbox.findLast((x) => x.to === 'sara@example.test' && x.purpose === 'reset')!.token;
    ok(await call('POST', '/auth/password/reset', undefined, { token: tok, newPassword: 'a new passphrase 2026' }), 204);
    const login = await call('POST', '/auth/login', undefined, { email: 'sara@example.test', password: 'a new passphrase 2026' }); ok(login);
    ok(await call('POST', '/auth/logout', login.body.accessToken, { refreshToken: login.body.refreshToken }), 204);
    assert.equal((await call('GET', '/me', login.body.accessToken)).status, 401, 'signed out');
    const again = await call('POST', '/auth/login', undefined, { email: 'sara@example.test', password: 'a new passphrase 2026' }); ok(again);
    const del = await call('DELETE', '/me', again.body.accessToken, { password: 'a new passphrase 2026' });
    note(`account deletion: ${del.status}`);
    assert.ok([200, 202, 204].includes(del.status));
    assert.notEqual((await call('POST', '/auth/login', undefined, { email: 'sara@example.test', password: 'a new passphrase 2026' })).status, 200, 'a deleted account cannot sign in');
    note('SUMMARY\n' + report.join('\n'));
  });
});
