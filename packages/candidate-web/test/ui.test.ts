// Browser test of the candidate app: a real Chrome drives the page against
// the real API and database, from registration to a submitted mock exam.
//
//   eval "$(scripts/pg-temp.sh start)" && (cd packages/candidate-web && npm test)
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
import type { Mail } from '../../api/src/app.ts';
import { buildWebFiles } from '../../api/src/web.ts';
import type { StoreVerifier } from '../../api/src/billing.ts';

const configured = Boolean(process.env.PGDATABASE);
const EMAIL = 'nour@example.test';
const PASS = 'a long candidate passphrase';
const SHOTS = process.env.UI_SCREENSHOT_DIR ?? '/tmp';

/** Stands in for Google Play on the server: accepts tokens that start with "play-ok-". */
const completed: string[] = [];
const playVerifier: StoreVerifier = {
  async verify(platform, productId, token) {
    return platform === 'google' && token.startsWith('play-ok-') ? { transactionId: `GPA.${token}`, productId } : null;
  },
  async complete(_p, productId, token) { completed.push(`${productId} ${token}`); },
};

describe('candidate app in a browser', { skip: configured ? false : 'PGDATABASE is not set; see scripts/pg-temp.sh' }, () => {
  // Application calls use the production connection pool; test assertions use store.query (psql).
  const db = new PgPool(undefined, { max: 4 });
  const store = new ApiStore(db);
  const outbox: Mail[] = [];
  const server = createServer(
    createApp({
      store,
      service: new MockExamService(store),
      now: () => Date.now(),
      mailer: (m) => outbox.push(m),
      config: { ...DEFAULT_APP_CONFIG, tokenSecret: 'candidate-ui-test-secret-not-for-production', authRateLimit: 500, site: { termsUrl: 'https://example.test/terms', privacyUrl: 'https://example.test/privacy', supportEmail: 'help@example.test' } },
      candidatePage: readFileSync(new URL('../index.html', import.meta.url), 'utf8'),
      webFiles: buildWebFiles(new URL('../', import.meta.url), {
        appName: 'Exam Simulator', shortName: 'Exam Sim', publicUrl: 'https://exam.example.test',
        site: { termsUrl: 'https://example.test/terms', privacyUrl: 'https://example.test/privacy', supportEmail: 'help@example.test' },
        android: { packageName: 'com.example.exam', certSha256: ['AB:'.repeat(31) + 'AB'] },
      }),
      billingVerifier: playVerifier,
    }),
  );
  let base = '';
  let browser: any;
  let page: any;
  const consoleErrors: string[] = [];

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pw = await import(process.env.PLAYWRIGHT_MODULE ?? '/opt/npm-tools/node_modules/playwright/index.js');
    browser = await (pw.chromium ?? pw.default.chromium).launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', headless: true });
    page = await browser.newPage({ viewport: { width: 900, height: 1000 }, locale: 'en-GB' });
    page.on('console', (m: any) => m.type() === 'error' && consoleErrors.push(m.text()));
    page.on('pageerror', (e: Error) => consoleErrors.push(e.message));
  });
  after(async () => {
    await db.close();
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const signIn = async () => {
    await page.fill('#email', EMAIL);
    await page.fill('#password', PASS);
    await page.click('button[type=submit]');
  };
  const pickFirstOption = async () => {
    await page.click('.opt[data-opt] >> nth=0');
  };

  it('registers, confirms the email from the link, and sets up a study plan', async () => {
    await page.goto(`${base}/app#register`);
    await page.fill('#email', EMAIL);
    await page.fill('#password', PASS);
    await page.click('button[type=submit]');
    await page.waitForSelector('.msg.err');
    assert.equal(await page.getAttribute('#terms-link', 'href'), 'https://example.test/terms');
    assert.equal(await page.getAttribute('#privacy-link', 'href'), 'https://example.test/privacy');
    await page.check('#terms');
    await page.click('button[type=submit]');
    await page.waitForSelector('text=Check your email');
    const mail = outbox.find((m) => m.to === EMAIL && m.purpose === 'verify')!;
    assert.ok(mail);

    await page.goto(`${base}/app#signin`);
    await signIn();
    await page.waitForSelector('text=Verify your email address before signing in');

    await page.goto(`${base}/app#verify?token=${mail.token}`);
    await page.waitForSelector('text=Your email is confirmed');
    await signIn();
    await page.waitForSelector('text=Set up your study plan');
    await page.fill('#date', '2027-01-20');
    await page.fill('#hours', '9');
    await page.click('button[type=submit]');
    await page.waitForSelector('text=Start with 10 practice questions');
    assert.equal(store.query(`SELECT exam_target_date || ' ' || weekly_study_hours FROM users WHERE email = '${EMAIL}';`), '2027-01-20 9');
  });

  it('practises ten questions with explanations, and reports one question', async () => {
    await page.click('#go');
    await page.waitForSelector('text=Question 1 of 10');
    assert.equal(await page.isDisabled('#check'), true);
    await pickFirstOption();
    await page.click('#check');
    await page.waitForSelector('.verdict');
    await page.waitForSelector('h2:has-text("Why")');
    await page.click('summary:has-text("Report a problem")');
    await page.selectOption('.rep-reason', 'ambiguous');
    await page.fill('.rep-comment', 'Options A and C both look right to me.');
    await page.click('.rep-send');
    await page.waitForSelector('text=Our content team will review it');
    for (let i = 2; i <= 10; i++) {
      await page.click('#next');
      await page.waitForSelector(`text=Question ${i} of 10`);
      await pickFirstOption();
      await page.click('#check');
      await page.waitForSelector('.verdict');
    }
    await page.click('#next');
    await page.waitForSelector('h1:has-text("Session summary")');
    assert.match(await page.textContent('.big'), /\/ 10/);
    assert.equal(store.query(`SELECT count(*) FROM question_reports WHERE comment LIKE 'Options A and C%';`), '1');
  });

  it('switches to Arabic with a right-to-left layout while question text stays left to right', async () => {
    await page.click('[data-act=lang]');
    await page.waitForSelector('nav a:has-text("الرئيسية")');
    assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
    await page.click('nav a[href="#practice"]');
    await page.click('button[type=submit]');
    await page.waitForSelector('.content');
    assert.equal(await page.$eval('.content', (el: Element) => getComputedStyle(el).direction), 'ltr');
    await page.click('nav a[href="#home"]');
    await page.waitForSelector('text=المقترح اليوم');
    await page.screenshot({ path: `${SHOTS}/candidate-home-ar.png` });
    assert.equal(store.query(`SELECT language FROM users WHERE email = '${EMAIL}';`), 'ar');
    await page.click('[data-act=lang]');
    await page.waitForSelector('nav a:has-text("Home")');
  });

  it('switches each translated question between English and Arabic with one button', async () => {
    store.query(`ALTER TABLE question_versions DISABLE TRIGGER USER;
      UPDATE question_versions SET stem_ar = 'نص عربي: ' || left(stem, 20) WHERE workflow_state = 'published';
      ALTER TABLE question_versions ENABLE TRIGGER USER;
      UPDATE options SET text_ar = 'خيار عربي ' || ordinal WHERE question_version_id IN (SELECT id FROM question_versions WHERE workflow_state = 'published');`);
    await page.click('nav a[href="#practice"]');
    await page.click('button[type=submit]');
    await page.waitForSelector('[data-act=qlang]');
    const visibleStem = () => page.$eval('.qwrap .stem', (el: Element) => [...el.children].filter((c) => getComputedStyle(c).display !== 'none').map((c) => c.textContent).join(''));
    assert.doesNotMatch(await visibleStem(), /نص عربي/);
    await page.click('[data-act=qlang]');
    assert.match(await visibleStem(), /^نص عربي/);
    assert.equal(await page.isVisible('text=خيار عربي 1'), true);
    await page.click('[data-act=qlang]');
    assert.doesNotMatch(await visibleStem(), /نص عربي/);
    store.query(`ALTER TABLE question_versions DISABLE TRIGGER USER; UPDATE question_versions SET stem_ar = NULL; ALTER TABLE question_versions ENABLE TRIGGER USER; UPDATE options SET text_ar = NULL;`);
    await page.click('nav a[href="#home"]');
  });

  it('on the free plan shows the daily allowance and locks mock exams until an access code is redeemed', async () => {
    await page.click('nav a[href="#practice"]');
    await page.waitForSelector('#allowance');
    assert.match(await page.textContent('#allowance'), /5 of 15 free practice questions left today/);
    await page.click('nav a[href="#mock"]');
    await page.waitForSelector('#locked');
    assert.equal(await page.$('#begin'), null);
    await page.click('a:has-text("See plans")');
    await page.waitForSelector('h1:has-text("Your plan")');
    assert.match(await page.textContent('#status'), /Free plan/);
    assert.match(await page.textContent('[data-plan=pass30]'), /Not on sale in this region yet/);

    const { hashToken, newAccessCodes, normalizeAccessCode } = await import('../../api/src/auth.ts');
    const [code] = newAccessCodes(1);
    await store.createAccessCodes('00000000-0000-4000-8000-000000000003', 'pass30', 30, [hashToken(normalizeAccessCode(code!))], 'UI test batch', null);
    await store.setPlanPrice('00000000-0000-4000-8000-000000000003', 'pass30', 'EG', 'EGP', 49_900, null);
    await page.selectOption('#region', 'EG');
    await page.waitForSelector('[data-plan=pass30] .price');
    assert.match(await page.textContent('[data-plan=pass30] .price'), /499/);

    await page.fill('#code', 'AAAA-BBBB-CCCC');
    await page.click('#redeem button[type=submit]');
    await page.waitForSelector('#rmsg .msg.err:has-text("not valid")');
    await page.fill('#code', code!.toLowerCase());
    await page.click('#redeem button[type=submit]');
    await page.waitForSelector('text=Code accepted');
    assert.match(await page.textContent('#status'), /Full access/);
    assert.match(await page.textContent('#status'), /Until/);
  });

  let attemptId = '';
  it('takes a mock exam through all three sections, two breaks and submission', async () => {
    await page.click('nav a[href="#mock"]');
    await page.click('#begin');
    await page.waitForSelector('text=/Section 1 · Case studies · Question 1 of 180/');
    attemptId = store.query(`SELECT ea.id FROM exam_attempts ea JOIN users u ON u.id = ea.user_id WHERE u.email = '${EMAIL}' AND ea.result IS NULL;`);
    // The case-study scenario opens with the first question of its set.
    assert.match(await page.textContent('details.case[open]'), /Synthetic scenario/);
    await pickFirstOption();
    await page.waitForSelector('#saving:has-text("Saved")');
    await page.click('#flag');
    assert.equal(await page.getAttribute('#flag', 'aria-pressed'), 'true');
    await page.screenshot({ path: `${SHOTS}/candidate-exam.png` });

    const toLastAndReview = async (count: number) => {
      await page.click('#navb');
      const cells = await page.$$('.cell');
      assert.equal(cells.length, count);
      await cells[count - 1].click();
      await page.click('#next');
      await page.waitForSelector('text=Review this section');
    };
    await page.click('#navb');
    assert.equal(await page.$eval('.cell[aria-label="1"]', (el: Element) => el.className), 'cell done flag current');
    await page.click('#back');
    await toLastAndReview(20);
    assert.equal(await page.textContent('.tiles .card:first-child .big'), '19');
    await page.click('#close');
    await page.waitForSelector('h1:has-text("Break")');
    await page.click('#resume');
    await page.waitForSelector('text=/Section 2 · Questions · Question 21 of 180/');
    await pickFirstOption();
    await page.waitForSelector('#saving:has-text("Saved")');

    await toLastAndReview(80);
    await page.click('#close');
    await page.waitForSelector('h1:has-text("Break")');
    await page.click('#resume');
    await page.waitForSelector('text=/Section 3 · Questions · Question 101 of 180/');
    await toLastAndReview(80);
    assert.match(await page.textContent('#close'), /Submit exam/);
    await page.click('#close');
    await page.waitForSelector('h1:has-text("Result")');
    assert.match(await page.textContent('.big'), /\/ 180/);
    assert.match(await page.textContent('main'), /not a prediction or guarantee/);
    assert.equal(store.query(`SELECT state FROM exam_attempts WHERE id = '${attemptId}';`), 'submitted');
    assert.equal(store.query(`SELECT count(*) FROM answers a JOIN attempt_questions aq ON aq.id = a.attempt_question_id WHERE aq.attempt_id = '${attemptId}';`), '2');
  });

  it('reviews the answers with keys and explanations after the exam', async () => {
    await page.click('text=Review answers');
    await page.waitForSelector('.card .verdict');
    await page.click('a:has-text("Flagged")');
    await page.waitForSelector('a.primary:has-text("Flagged")');
    await page.waitForSelector('text=Question 1 of 180 · ⚑');
    assert.equal(await page.$$eval('main > .card', (els: Element[]) => els.length), 1);
  });

  it('resumes an unfinished exam after the page is reloaded, with the saved answer still selected', async () => {
    await page.click('nav a[href="#mock"]');
    await page.click('#begin');
    await page.waitForSelector('text=Question 1 of 180');
    await page.click('.opt[data-opt] >> nth=1');
    await page.waitForSelector('#saving:has-text("Saved")');
    await page.reload();
    await page.waitForSelector('#email'); // tokens live in memory only
    await signIn();
    await page.waitForSelector('nav a[href="#mock"]');
    await page.click('nav a[href="#mock"]');
    await page.click('#resume');
    await page.waitForSelector('text=Question 1 of 180');
    assert.equal(await page.getAttribute('.opt[data-opt] >> nth=1', 'aria-checked'), 'true');
  });

  it('fits a phone screen: no sideways scrolling on the main screens or in the exam', async () => {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ar-EG' });
    const p = await phone.newPage();
    p.on('pageerror', (e: Error) => consoleErrors.push(e.message));
    await p.goto(`${base}/app`);
    await p.fill('#email', EMAIL);
    await p.fill('#password', PASS);
    await p.click('button[type=submit]');
    await p.waitForSelector('nav.tabs');
    const fits = async (where: string) => {
      const [scroll, width] = await p.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      assert.ok(scroll <= width, `${where}: page is ${scroll}px wide on a ${width}px screen`);
    };
    await fits('home');
    for (const route of ['practice', 'mock', 'stats', 'settings', 'plan']) {
      await p.goto(`${base}/app#${route}`);
      await p.waitForSelector('main h1, main h2');
      await fits(route);
    }
    await p.goto(`${base}/app#plan`);
    await p.waitForSelector('#status');
    await p.screenshot({ path: `${SHOTS}/candidate-plan-phone.png` });
    await p.goto(`${base}/app#mock`);
    await p.click('#resume');
    await p.waitForSelector('.opt[data-opt]');
    await fits('exam question');
    const target = await p.$eval('.opt[data-opt]', (el: Element) => el.getBoundingClientRect().height);
    assert.ok(target >= 44, 'answer options are at least 44px tall for touch');
    await p.screenshot({ path: `${SHOTS}/candidate-exam-phone.png` });
    await phone.close();
  });

  it('shows the exam tips in English and in Arabic', async () => {
    await page.goto(`${base}/app`);
    await signIn();
    await page.waitForSelector('nav a[href="#tips"]');
    await page.click('nav a[href="#tips"]');
    await page.waitForSelector('details.tips');
    assert.ok((await page.locator('details.tips').count()) >= 6);
    assert.match(await page.locator('details.tips[open] li').first().innerText(), /project manager/);
    const startLang = await page.evaluate(() => document.documentElement.lang);
    await page.click('[data-act="lang"]');
    await page.waitForFunction((l) => document.documentElement.lang !== l, startLang);
    const other = await page.locator('main h1').innerText();
    assert.ok(['Exam tips', 'نصائح الامتحان'].includes(other));
    await page.click('[data-act="lang"]');
    await page.waitForFunction((l) => document.documentElement.lang === l, startLang);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  });

  it('downloads the candidate\'s own data from Settings', async () => {
    await page.goto(`${base}/app`);
    await signIn();
    await page.waitForSelector('nav a[href="#settings"]');
    await page.click('nav a[href="#settings"]');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
    assert.equal(download.suggestedFilename(), 'my-exam-simulator-data.json');
    const { readFileSync } = await import('node:fs');
    const data = JSON.parse(readFileSync(await download.path(), 'utf8'));
    assert.equal(data.profile.email, EMAIL);
    assert.ok(data.mockExams.length >= 1);
  });

  it('is an installable web app: landing page, manifest, icons, service worker, and opens offline', async () => {
    const landing = await page.goto(`${base}/`);
    assert.equal(landing.status(), 200);
    assert.match(await page.textContent('h1:visible'), /PMP/);
    assert.equal(await page.getAttribute('footer a[href="https://example.test/terms"]', 'href'), 'https://example.test/terms');
    const manifest = await (await fetch(`${base}/app/manifest.webmanifest`)).json();
    assert.equal(manifest.start_url, '/app');
    assert.equal(manifest.display, 'standalone');
    assert.ok(manifest.icons.some((i: any) => i.sizes === '512x512' && i.purpose === 'maskable'));
    for (const icon of manifest.icons) assert.equal((await fetch(base + icon.src)).headers.get('content-type'), 'image/png');
    assert.match(await (await fetch(`${base}/robots.txt`)).text(), /Disallow: \/admin/);
    const links = await (await fetch(`${base}/.well-known/assetlinks.json`)).json();
    assert.equal(links[0].target.package_name, 'com.example.exam');

    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await ctx.newPage();
    await p.goto(`${base}/app`);
    await p.waitForSelector('#email');
    await p.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await p.waitForFunction(() => caches.keys().then((k) => k.some((n) => n.startsWith('shell-'))));
    await ctx.setOffline(true);
    await p.reload();
    await p.waitForSelector('#email'); // the app shell comes from the cache
    await p.waitForSelector('#netbar:not([hidden])');
    assert.match(await p.textContent('#netbar'), /offline|غير متصل/);
    await ctx.close();
  });

  it('inside the Android app, buys a pass through Google Play and the server completes it', async () => {
    await store.setPlanPrice('00000000-0000-4000-8000-000000000003', 'pass90', 'GULF', 'SAR', 14_900, 'sim.pass90');
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-GB' });
    // What Chrome provides inside a Trusted Web Activity installed from Google Play.
    await ctx.addInitScript(() => {
      (window as any).getDigitalGoodsService = async (id: string) => {
        if (id !== 'https://play.google.com/billing') throw new Error('unsupported');
        return {
          getDetails: async (ids: string[]) => ids.map((itemId) => ({ itemId, title: itemId, price: { currency: 'EGP', value: '749.00' } })),
          listPurchases: async () => [],
        };
      };
      (window as any).PaymentRequest = class {
        methods: any;
        constructor(methods: any) { this.methods = methods; }
        async show() {
          const sku = this.methods[0].data.sku;
          (window as any).__lastPlayPurchase = { sku, done: null };
          return { details: { purchaseToken: 'play-ok-' + sku }, complete: async (r: string) => { (window as any).__lastPlayPurchase.done = r; } };
        }
      };
    });
    const p = await ctx.newPage();
    await p.goto(`${base}/app`);
    await p.fill('#email', EMAIL);
    await p.fill('#password', PASS);
    await p.click('button[type=submit]');
    await p.waitForSelector('nav.tabs');
    await p.goto(`${base}/app#plan`);
    await p.waitForSelector('[data-plan=pass90] [data-buy]');
    assert.equal(await p.$('#region'), null, 'no web prices inside the Play app');
    assert.match(await p.textContent('[data-plan=pass90] .price'), /749/);
    assert.match(await p.textContent('main'), /Payment is handled by Google Play/);
    await p.click('[data-plan=pass90] [data-buy]');
    await p.waitForSelector('text=Your pass is active');
    assert.deepEqual(await p.evaluate(() => (window as any).__lastPlayPurchase), { sku: 'sim.pass90', done: 'success' });
    assert.ok(completed.includes('sim.pass90 play-ok-sim.pass90'));
    assert.equal(store.query(`SELECT count(*) FROM entitlements e JOIN users u ON u.id = e.user_id WHERE u.email = '${EMAIL}' AND e.source = 'store_google' AND e.external_ref = 'GPA.play-ok-sim.pass90';`), '1');
    await ctx.close();
  });

  it('shows results by domain and approach, and reports no script errors', async () => {
    await page.goto(`${base}/app`);
    await signIn();
    await page.waitForSelector('nav a[href="#stats"]');
    await page.click('nav a[href="#stats"]');
    await page.waitForSelector('h2:has-text("By domain")');
    assert.ok((await page.$$('.bar')).length >= 3);
    const unexpected = consoleErrors.filter((e) => !/status of (401|403|409|422)/.test(e));
    assert.deepEqual(unexpected, []);
  });
});
