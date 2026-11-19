// Browser audit of every candidate screen with the real bank (run after journey.test.ts,
// which leaves the bank in the pmpsim_journey database). Not part of npm test.
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
process.env.PGDATABASE = 'pmpsim_journey';
const { MockExamService } = await import('../../exam-store/src/service.ts');
const { ApiStore } = await import('../../api/src/api-store.ts');
const { PgPool } = await import('../../exam-store/src/pg-wire.ts');
const { DEFAULT_APP_CONFIG, createApp } = await import('../../api/src/app.ts');
const { buildWebFiles } = await import('../../api/src/web.ts');
type Mail = import('../../api/src/app.ts').Mail;

const db = new PgPool(undefined, { max: 4 });
const store = new ApiStore(db);
const outbox: Mail[] = [];
const site = { termsUrl: 'https://example.test/terms', privacyUrl: 'https://example.test/privacy', supportEmail: 'help@example.test' };
const server = createServer(createApp({ store, service: new MockExamService(store), now: () => Date.now(), mailer: (m) => outbox.push(m),
  config: { ...DEFAULT_APP_CONFIG, tokenSecret: 'screens-audit-secret-not-for-production-0123', authRateLimit: 500, site },
  candidatePage: readFileSync(new URL('../index.html', import.meta.url), 'utf8'),
  webFiles: buildWebFiles(new URL('../', import.meta.url), { appName: 'Exam Simulator', shortName: 'Exam Sim', publicUrl: 'https://exam.example.test', site, android: { packageName: 'com.example.exam', certSha256: ['AB:'.repeat(31) + 'AB'] } }) }));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const api = async (m: string, p: string, body?: unknown, tok?: string) => {
  const r = await fetch(base + '/api/v1' + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) as any };
};
const email = `audit${Date.now()}@example.test`, pass = 'audit passphrase 2026';
await api('POST', '/auth/register', { email, password: pass, acceptTerms: true });
await api('POST', '/auth/verify-email', { token: outbox.at(-1)!.token });
const uid = (await store.userByEmail(email))!.id;
await store.grantEntitlement(uid, 'pass30', 'admin_grant', null, 30, new Date().toISOString(), null, 'audit');

const pw = await import('/opt/npm-tools/node_modules/playwright/index.js');
const browser = await (pw.chromium ?? (pw as any).default.chromium).launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const results: string[] = [];
const issues: string[] = [];
for (const [lang, w] of [['en', 900], ['ar', 390]] as const) {
  {
    const tok = (await api('POST', '/auth/login', { email, password: pass })).body.accessToken;
    await api('PATCH', '/me', { language: lang }, tok);
  }
  const page = await browser.newPage({ viewport: { width: w, height: 900 }, locale: lang === 'ar' ? 'ar-EG' : 'en-GB' });
  const errs: string[] = [];
  page.on('console', (m: any) => m.type() === 'error' && errs.push(m.text()));
  page.on('pageerror', (e: Error) => errs.push(e.message));
  await page.goto(base + '/app#signin');
  await page.fill('#email', email); await page.fill('#password', pass); await page.click('button[type=submit]');
  await page.waitForTimeout(1500);
  const shot = async (name: string) => { await page.screenshot({ path: `/tmp/gen/ui/${lang}-${name}.png`, fullPage: false }); };
  const visit = async (hash: string, name: string, wait = 1500) => {
    errs.length = 0;
    await page.goto(base + '/app' + hash); await page.waitForTimeout(wait);
    const text: string = await page.evaluate(() => document.body.innerText);
    const bad = /undefined|NaN|\[object Object\]|null%|Request failed|خطأ غير متوقع/.exec(text);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
    await shot(name);
    const line = `${lang} ${name}: ${errs.length ? 'JS ERRORS ' + errs.join(' | ') : 'ok'}${bad ? ' TEXT:' + bad[0] : ''}${overflow ? ' HORIZONTAL-SCROLL' : ''}`;
    results.push(line); if (errs.length || bad || overflow) issues.push(line);
    return text;
  };
  await visit('#home', 'home');
  await visit('#practice', 'practice-setup');
  // Practise one question of each type through the UI.
  for (const type of ['single', 'multiple', 'matching', 'ordering', 'numeric', 'hotspot']) {
    const r = await page.evaluate(`startPractice({ mode: 'focused', questionCount: 1, types: ['${type}'] }).then(() => true)`).catch((e: Error) => e.message);
    await page.waitForTimeout(1500);
    errs.length = 0;
    // Answer: click / fill something valid for the type.
    if (type === 'numeric') await page.fill('#numans', '42').catch(() => {});
    else if (type === 'matching') { const sels = await page.$$('select'); for (const s of sels) { const opts = await s.$$eval('option', (o: any[]) => o.map((x) => x.value).filter(Boolean)); if (opts[0]) await s.selectOption(opts[0]); } }
    else if (type === 'ordering') { await page.click('button[data-move="1"] >> nth=0').catch(() => {}); }
    else await page.click('.opt[data-opt] >> nth=0').catch(() => {});
    await page.waitForTimeout(600);
    await page.click('#check').catch((e: Error) => issues.push(`${lang} ${type}: check button ${e.message.slice(0, 80)}`));
    await page.waitForTimeout(1200);
    const text: string = await page.evaluate(() => document.body.innerText);
    await shot('type-' + type);
    const fbShown = /(Correct|Incorrect|صح|خطأ|إجابة صحيحة|إجابة خاطئة|Why|ليه|لماذا|الشرح)/i.test(text);
    const line = `${lang} type ${type}: ${errs.length ? 'JS ERRORS ' + errs.join(' | ') : 'ok'}${fbShown ? '' : ' NO-FEEDBACK-SEEN'}${r === true ? '' : ' start:' + r}`;
    results.push(line); if (errs.length || !fbShown || r !== true) issues.push(line);
  }
  for (const [h, n] of [['#study-plan', 'study-plan'], ['#analytics', 'analytics'], ['#stats', 'stats'], ['#tips', 'tips'], ['#case-studies', 'case-studies'], ['#mock', 'mock-home'], ['#plan', 'plan'], ['#bookmarks', 'bookmarks'], ['#settings', 'settings'], ['#notifications', 'notifications'], ['#certificates', 'certificates']] as const) await visit(h, n);
  // Start a mock exam and look at a case question and the navigator.
  if (lang === 'en') {
    await page.goto(base + '/app#mock'); await page.waitForTimeout(1200);
    const startBtn = await page.$('#begin');
    if (startBtn) { await startBtn.click(); await page.waitForTimeout(2500); }
    await shot('mock-question');
    const t: string = await page.evaluate(() => document.body.innerText);
    results.push(`${lang} mock: ${/Scenario|السيناريو/.test(t) ? 'case scenario shown' : 'NO SCENARIO SEEN'}`);
  }
  await page.close();
}
writeFileSync('/tmp/gen/ui/report.txt', results.join('\n') + '\n\nISSUES\n' + issues.join('\n'));
console.log(results.join('\n')); console.log('ISSUES', issues.length); console.log(issues.join('\n'));
await browser.close(); await db.close(); server.close();
