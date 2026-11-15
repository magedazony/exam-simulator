// Browser test of the admin panel: a real Chrome drives the page against the
// real API and database. Covers enrolment, authoring, both review gates,
// publishing, case studies and import.
//
//   eval "$(scripts/pg-temp.sh start)" && (cd packages/admin-web && npm test)
//
// Needs Playwright and Chrome. PLAYWRIGHT_MODULE and CHROME_PATH override
// where they are found.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { MockExamService } from '../../exam-store/src/service.ts';
import { ApiStore } from '../../api/src/api-store.ts';
import { PgPool } from '../../exam-store/src/pg-wire.ts';
import { DEFAULT_APP_CONFIG, createApp } from '../../api/src/app.ts';
import { hashPassword, totpCode, totpStep } from '../../api/src/auth.ts';

const configured = Boolean(process.env.PGDATABASE);
const PASS = 'staff passphrase for the ui test';
const STAFF = {
  author: { id: '00000000-0000-4000-8000-000000000001', email: 'author@example.test' },
  reviewer: { id: '00000000-0000-4000-8000-000000000002', email: 'reviewer@example.test' },
  admin: { id: '00000000-0000-4000-8000-000000000003', email: 'admin@example.test' },
};
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

describe('admin panel in a browser', { skip: configured ? false : 'PGDATABASE is not set; see scripts/pg-temp.sh' }, () => {
  // Application calls use the production connection pool; test assertions use store.query (psql).
  const db = new PgPool(undefined, { max: 4 });
  const store = new ApiStore(db);
  const server = createServer(
    createApp({
      store,
      service: new MockExamService(store),
      now: () => Date.now(),
      mailer: () => {},
      config: { ...DEFAULT_APP_CONFIG, tokenSecret: 'ui-test-secret-not-for-production-use', authRateLimit: 500 },
      adminPage: readFileSync(new URL('../index.html', import.meta.url), 'utf8'),
    }),
  );
  let base = '';
  let browser: any;
  let page: any;
  const consoleErrors: string[] = [];
  const recovery: Record<string, string[]> = {};

  before(async () => {
    for (const s of Object.values(STAFF)) {
      await store.setPassword(s.id, hashPassword(PASS), new Date().toISOString());
      await store.markVerified(s.id, new Date().toISOString());
    }
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pw = await import(process.env.PLAYWRIGHT_MODULE ?? '/opt/npm-tools/node_modules/playwright/index.js');
    browser = await (pw.chromium ?? pw.default.chromium).launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', headless: true });
    page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    page.on('console', (m: any) => m.type() === 'error' && consoleErrors.push(m.text()));
    page.on('pageerror', (e: Error) => consoleErrors.push(e.message));
  });
  after(async () => {
    await db.close();
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const signIn = async (email: string, otp?: string) => {
    await page.goto(`${base}/admin`);
    await page.fill('#email', email);
    await page.fill('#password', PASS);
    if (otp) await page.fill('#otp', otp);
    await page.click('button[type=submit]');
  };
  const signOut = async () => {
    await page.click('a[href="#signout"]');
    await page.waitForSelector('#login');
  };
  /** First sign-in of a staff member: enrol, keep the recovery codes, sign in with one of them. */
  const enrolAndSignIn = async (who: keyof typeof STAFF) => {
    await signIn(STAFF[who].email);
    await page.waitForSelector('text=Set up two-factor sign-in');
    await page.waitForSelector('#secret-key');
    const secret = (await page.textContent('#secret-key')).trim();
    await page.fill('#mfa-code', totpCode(b32decode(secret), totpStep(Date.now())));
    await page.click('#enable');
    await page.waitForSelector('text=Save your recovery codes');
    recovery[who] = await page.$$eval('.codes span', (els: Element[]) => els.map((e) => e.textContent!));
    assert.equal(recovery[who]!.length, 10);
    await page.click('#again');
    await signIn(STAFF[who].email, recovery[who]![0]);
    await page.waitForSelector('h1:has-text("Work queue")');
  };

  it('serves the panel with a strict content security policy', async () => {
    const r = await fetch(`${base}/admin`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'self'.*frame-ancestors 'none'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
  });

  it('refuses a wrong password and explains why', async () => {
    await page.goto(`${base}/admin`);
    await page.fill('#email', STAFF.author.email);
    await page.fill('#password', 'wrong password here');
    await page.click('button[type=submit]');
    await page.waitForSelector('.msg.err');
    assert.match(await page.textContent('.msg.err'), /Email or password is incorrect/);
  });

  let questionUrl = '';
  it('author: enrols, writes a draft, and submits it with the originality declaration', async () => {
    await enrolAndSignIn('author');
    await page.click('a[href="#new"]');
    await page.waitForSelector('#stem');
    await page.selectOption('#taskCode', 'BUSINESS-5');
    await page.selectOption('#approach', 'hybrid');
    await page.fill('#stem', 'A vendor warns that a key component may arrive late on a hybrid project with a fixed launch date. What should the project manager do first?');
    const texts = [
      'Add the risk to the risk register, assign an owner and analyze it with the team',
      'Move the launch date in the schedule baseline',
      'Ask the sponsor for extra contingency budget',
      'Replace the vendor with a faster one',
    ];
    const rows = await page.$$('.opt-row');
    for (let i = 0; i < 4; i++) await (await rows[i].$('.o-text')).fill(texts[i]);
    await page.fill('#why', 'A newly identified risk is recorded, owned and analyzed before any response is chosen.');
    // Exhibits: one table and one image, both shown in the candidate preview.
    await page.click('#exhibits summary');
    await page.fill('#exhibits .ex-alt', 'Risk register extract');
    await page.fill('#exhibits .ex-table', 'Risk | Owner\nLate component | Vendor manager');
    await page.click('#exhibits .ex-add');
    await page.waitForSelector('#preview .exhibit table');
    await page.click('#exhibits summary');
    await page.fill('#exhibits .ex-alt', 'Delivery timeline chart');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    await page.setInputFiles('#exhibits .ex-file', { name: 'timeline.png', mimeType: 'image/png', buffer: png });
    await page.click('#exhibits .ex-add');
    await page.waitForSelector('#preview .exhibit img');
    await page.waitForFunction(() => (document.querySelector('#preview .exhibit img') as HTMLImageElement).naturalWidth > 0);
    // The preview updates as the author types; the first option is marked correct by default.
    assert.match(await page.textContent('#preview li.key'), /risk register/);
    await page.click('button[type=submit]');
    await page.waitForSelector('text=/Draft Q-\\d{6} created/');
    questionUrl = page.url();

    await page.click('button[data-act=submit]');
    await page.waitForSelector('.msg.err');
    assert.match(await page.textContent('.msg.err'), /original/);
    await page.check('#orig');
    await page.click('button[data-act=submit]');
    await page.waitForSelector('text=Now Expert review.');
    assert.equal(await page.isDisabled('#stem'), true);
    assert.match(await page.textContent('main'), /Waiting for another reviewer/);
    await signOut();
  });

  it('reviewer: finds it in the queue, cannot approve with a failed check, then approves both gates', async () => {
    await enrolAndSignIn('reviewer');
    await page.waitForSelector('h2:has-text("Waiting for expert review")');
    await page.click('tr.click:has-text("vendor warns")');
    await page.waitForSelector('button[data-act=approve]');
    const boxes = await page.$$('.chk');
    for (const b of boxes.slice(0, 7)) await b.check();
    await page.click('button[data-act=approve]');
    await page.waitForSelector('.msg.err');
    assert.match(await page.textContent('.msg.err'), /eight review checks/);

    for (const b of await page.$$('.chk')) await b.check();
    await page.click('button[data-act=approve]');
    await page.waitForSelector('text=Now Language and QA.');
    for (const b of await page.$$('.chk')) await b.check();
    await page.click('button[data-act=approve]');
    await page.waitForSelector('text=Now Approved.');
    assert.equal(await page.$('button[data-act=publish]'), null);
    await signOut();
  });

  it('admin: publishes it from the queue', async () => {
    await enrolAndSignIn('admin');
    await page.waitForSelector('h2:has-text("Approved, waiting to be published")');
    await page.click('tr.click:has-text("vendor warns")');
    await page.click('button[data-act=publish]');
    await page.waitForSelector('text=Now Published.');
    assert.equal(page.url(), questionUrl);
    const pool = await store.pool((await store.activeBlueprint('PMP-ECO'))!.id);
    assert.ok(pool.some((q) => q.stem.startsWith('A vendor warns') && q.status === 'published'));
  });

  it('admin: checks and imports a CSV file, storing only valid rows', async () => {
    await page.click('a[href="#import"]');
    const csv = [
      'taskCode,approach,difficulty,type,stem,optionA,optionB,optionC,optionD,correct,whyCorrect',
      'PEOPLE-4,agile,easy,single,"A new stakeholder joins mid-project and feels left out of decisions. What should the project manager do first?",Meet the stakeholder to understand their interests,Ignore it,Escalate,Send the charter,A,Engagement starts by understanding the stakeholder.',
      'NOPE-1,agile,easy,single,"An invalid row with an unknown task code that should be reported clearly.",A,B,C,D,A,Because.',
    ].join('\n');
    await page.setInputFiles('#file', { name: 'questions.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.waitForSelector('text=2 rows read');
    await page.click('#check');
    await page.waitForSelector('text=/Check result: 1 valid, 1 invalid/');
    await page.click('#commit');
    await page.waitForSelector('text=/1 stored as drafts/');
  });

  it('admin: creates a case study and opens a question inside it', async () => {
    await page.click('a[href="#cases"]');
    await page.fill('#c-title', 'Hospital records migration');
    await page.fill(
      '#c-scenario',
      'A hospital group is moving patient records to a new platform. Data migration follows a fixed plan while the clinician app is built in iterations. Regulators require an audit before go-live.',
    );
    await page.click('#new-case button[type=submit]');
    await page.waitForSelector('h1:has-text("Hospital records migration")');
    await page.click('text=Add a question');
    await page.waitForSelector('h1:has-text("New case-study question")');
  });

  it('admin: resets a staff member’s two-factor sign-in from the Users screen', async () => {
    await page.click('a[href="#users"]');
    await page.fill('#uq', 'reviewer@');
    await page.click('#user-search button[type=submit]');
    await page.waitForSelector(`[data-reset="${STAFF.reviewer.id}"]`);
    await page.click(`[data-reset="${STAFF.reviewer.id}"]`);
    await page.waitForSelector('text=Two-factor sign-in reset');
    assert.equal((await store.totpState(STAFF.reviewer.id)).enabled, false);
    // An administrator cannot reset their own two-factor sign-in from here.
    await page.fill('#uq', 'admin@');
    await page.click('#user-search button[type=submit]');
    await page.waitForSelector('text=admin@example.test');
    assert.equal(await page.$(`[data-reset="${STAFF.admin.id}"]`), null);
  });

  it('admin: sets a price, creates access codes and gives a pass from Plans and access', async () => {
    await page.click('a[href="#access"]');
    await page.waitForSelector('h2:has-text("Prices")');
    await page.selectOption('#pr-plan', 'pass90');
    await page.selectOption('#pr-region', 'EG');
    await page.fill('#pr-cur', 'egp');
    await page.fill('#pr-amount', '1,199.50');
    await page.click('#price button[type=submit]');
    await page.waitForSelector('text=Price saved.');
    assert.equal(store.query(`SELECT currency || ' ' || amount_minor FROM plan_prices WHERE plan_code = 'pass90' AND region = 'EG';`), 'EGP 119950');
    assert.match(await page.textContent('table'), /EGP\s?1,199\.50/);

    await page.fill('#ac-count', '3');
    await page.fill('#ac-label', 'Alexandria course, Jan 2027');
    await page.click('#codes-form button[type=submit]');
    await page.waitForSelector('#ac-codes');
    const codes = (await page.inputValue('#ac-codes')).split('\n');
    assert.equal(codes.length, 3);
    assert.ok(codes.every((c: string) => /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/.test(c)));
    assert.equal(store.query(`SELECT count(*) FROM access_codes WHERE batch_label = 'Alexandria course, Jan 2027';`), '3');

    await page.fill('#gr-email', 'nobody@example.test');
    await page.click('#grant button[type=submit]');
    await page.waitForSelector('#gr-out .msg.err:has-text("No account")');
    await page.fill('#gr-email', STAFF.author.email);
    await page.fill('#gr-note', 'Partner account');
    await page.click('#grant button[type=submit]');
    await page.waitForSelector('#gr-out .msg.ok:has-text("has access until")');
    assert.equal(store.query(`SELECT count(*) FROM entitlements WHERE user_id = '${STAFF.author.id}' AND source = 'admin_grant';`), '1');
  });

  it('admin: imports an Excel file through the server-side reader', async () => {
    await page.click('a[href="#import"]');
    await page.setInputFiles('#file', new URL('../../api/test/fixtures/questions.xlsx', import.meta.url).pathname);
    await page.waitForSelector('text=3 rows read from questions.xlsx');
    await page.click('#check');
    await page.waitForSelector('text=/Check result: \\d+ valid, \\d+ invalid, 1 duplicates/');
    // The first row repeats the stem imported from CSV earlier.
    assert.match(await page.textContent('#report tbody tr:first-child'), /same stem already exists/);
    await page.setInputFiles('#file', { name: 'broken.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('not a workbook') });
    await page.waitForSelector('#report .msg.err:has-text("not an Excel")');
  });

  it('admin: reads the audit trail and filters it to price changes', async () => {
    await page.click('a[href="#audit"]');
    await page.waitForSelector('h1:has-text("Audit log")');
    await page.selectOption('#a-action', 'plan');
    await page.click('#audit-filter button[type=submit]');
    // Wait until the filtered page has replaced the unfiltered one.
    await page.waitForFunction(() => {
      const cells = [...document.querySelectorAll('tbody td:nth-child(3)')];
      return cells.length > 0 && cells.every((c) => (c.textContent ?? '').startsWith('plan'));
    });
    const actions = await page.$$eval('tbody td:nth-child(3)', (els: Element[]) => els.map((e) => e.textContent));
    assert.ok(actions.length >= 1 && actions.every((a: string | null) => a?.startsWith('plan')));
  });

  it('admin: imports the 52 starter drafts from Excel, marked as drafted with AI help', async () => {
    await page.click('a[href="#import"]');
    await page.setInputFiles('#file', new URL('../../../content/starter-drafts.xlsx', import.meta.url).pathname);
    await page.waitForSelector('text=52 rows read from starter-drafts.xlsx');
    await page.click('#check');
    await page.waitForSelector('text=/Check result: 52 valid, 0 invalid, 0 duplicates/');
    await page.click('#commit');
    await page.waitForSelector('text=/52 stored as drafts/');
    assert.equal(store.query(`SELECT count(*) FROM question_versions WHERE workflow_state = 'draft' AND ai_assisted AND stem LIKE 'A newly formed agile team%';`), '1');
    assert.equal(store.query(`SELECT count(*) FROM question_versions qv WHERE ai_assisted AND workflow_state = 'draft' AND created_at > now() - interval '5 minutes';`), '52');
  });

  it('admin: imports the second batch with its Case studies sheet, creating six case-study drafts', async () => {
    await page.click('a[href="#queue"]');
    await page.click('a[href="#import"]');
    await page.setInputFiles('#file', new URL('../../../content/starter-drafts-2.xlsx', import.meta.url).pathname);
    await page.waitForSelector('text=70 rows read from starter-drafts-2.xlsx. 6 case studies.');
    await page.click('#check');
    await page.waitForSelector('text=/Check result: 70 valid, 0 invalid, 0 duplicates/');
    await page.click('#commit');
    await page.waitForSelector('text=/70 stored as drafts/');
    const cases = store.query(`SELECT string_agg(c.title || ':' || (SELECT count(*) FROM question_versions qv WHERE qv.case_study_id = c.id), ',' ORDER BY c.title)
      FROM case_studies c WHERE c.status = 'draft' AND c.title IN ('Hospital medication system', 'Desert solar farm', 'Mobile banking app', 'New school building', 'Retail inventory rollout', 'Logistics platform');`);
    assert.equal(cases, 'Desert solar farm:3,Hospital medication system:3,Logistics platform:3,Mobile banking app:3,New school building:3,Retail inventory rollout:3');
    // A file whose questions name a case that is not in the file is stopped before checking.
    const { execFileSync } = await import('node:child_process');
    const bad = '/tmp/bad-case.xlsx';
    execFileSync('python3', ['-c', `import openpyxl
wb = openpyxl.Workbook(); ws = wb.active
ws.append(['taskCode','approach','difficulty','type','stem','optionA','optionB','optionC','optionD','correct','whyCorrect','caseKey'])
ws.append(['PEOPLE-1','agile','easy','single','A question that names a case study missing from the file.','A','B','C','D','A','Because.','NOPE'])
wb.save('${bad}')`]);
    await page.setInputFiles('#file', bad);
    await page.waitForSelector('text=Unknown case keys: NOPE');
    assert.equal(await page.isDisabled('#check'), true);
  });

  it('admin: the whole panel works in Arabic, right to left, with every label translated', async () => {
    await page.click('[data-lang]');
    await page.waitForSelector('nav a:has-text("قائمة العمل")');
    assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
    assert.equal(store.query(`SELECT language FROM users WHERE id = '${STAFF.admin.id}';`), 'ar');
    for (const route of ['queue', 'questions', 'new', 'cases', 'import', 'blueprints', 'reports', 'users', 'access', 'audit', 'security']) {
      await page.click(`nav a[href="#${route}"]`);
      await page.waitForSelector('main h1');
      const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      assert.ok(scroll <= width + 1, `${route} scrolls sideways in Arabic`);
    }
    await page.goto(questionUrl);
    await page.waitForSelector('#preview');
    // Question text written in English keeps its own direction inside the Arabic panel.
    assert.equal(await page.$eval('#stem', (el: Element) => getComputedStyle(el).direction), 'ltr');
    await page.screenshot({ path: '/tmp/admin-panel-ar.png' });
    const cases = await page.$$('nav a[href="#cases"]');
    await cases[0].click();
    await page.click('tr.click >> nth=0');
    await page.waitForSelector('text=تحتاج من 2 إلى 10 أسئلة');
    const missing = await page.evaluate(() => [...(window as any).__missingAr]);
    assert.deepEqual(missing, [], 'every interface string has an Arabic translation');
    await page.click('[data-lang]');
    await page.waitForSelector('nav a:has-text("Work queue")');
    assert.equal(await page.getAttribute('html', 'dir'), 'ltr');
  });

  it('reports no script errors in the browser', async () => {
    await page.click('a[href="#queue"]');
    await page.waitForSelector('h1:has-text("Work queue")');
    await page.goto(questionUrl);
    await page.waitForSelector('#preview');
    await page.screenshot({ path: process.env.UI_SCREENSHOT ?? '/tmp/admin-panel.png', fullPage: false });
    // The only console errors allowed are the browser's own logs of refused requests the tests caused on purpose.
    const unexpected = consoleErrors.filter((e) => !/status of (401|403|409|422)/.test(e));
    assert.deepEqual(unexpected, []);
  });
});
