// Makes the store screenshots (phone, 1080 x 1920, English and Arabic) and
// the Google Play feature graphic, from the real app.
//
//   eval "$(scripts/pg-temp.sh start)" && node scripts/store-screenshots.ts
//
// Works on a copy of the throwaway test database whose synthetic questions
// are replaced by the original samples in store/screenshot-data, so the
// pictures show realistic text. Needs Playwright and Chrome.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MockExamService } from '../packages/exam-store/src/service.ts';
import { PgPool, configFromEnv } from '../packages/exam-store/src/pg-wire.ts';
import { sampleContentSql } from './lib/sample-content.ts';
import { ApiStore } from '../packages/api/src/api-store.ts';
import { DEFAULT_APP_CONFIG, createApp } from '../packages/api/src/app.ts';
import { hashPassword } from '../packages/api/src/auth.ts';
import { buildWebFiles } from '../packages/api/src/web.ts';

const ROOT = new URL('../', import.meta.url);
const OUT = new URL('store/screenshots/', ROOT).pathname;
const DB = 'pmpsim_shots';
const source = process.env.PGDATABASE ?? 'pmpsim_test';
mkdirSync(OUT, { recursive: true });
const psql = (db: string, sql: string) => execFileSync('psql', ['-qAtX', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', sql], { encoding: 'utf8' }).trim();

// 1. A copy of the test database with realistic sample text.
psql('postgres', `DROP DATABASE IF EXISTS ${DB}`);
psql('postgres', `CREATE DATABASE ${DB} TEMPLATE ${source}`);
psql(DB, sampleContentSql(ROOT, 'SET session_replication_role = replica;'));

// 2. The app, on that database.
const db = new PgPool({ ...configFromEnv(), database: DB }, { max: 4 });
const store = new ApiStore(db);
const app = createApp({
  store, service: new MockExamService(store), now: () => Date.now(), mailer: () => {},
  config: { ...DEFAULT_APP_CONFIG, tokenSecret: 'store-screenshots-secret-not-for-production', authRateLimit: 1000 },
  candidatePage: readFileSync(new URL('packages/candidate-web/index.html', ROOT), 'utf8'),
  webFiles: buildWebFiles(new URL('packages/candidate-web/', ROOT), { appName: 'Exam Simulator', shortName: 'Exam Sim', publicUrl: 'https://exam.example.com', site: { termsUrl: '', privacyUrl: '', supportEmail: '' }, android: null }),
});
const server = createServer(app).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const api = async (method: string, path: string, token?: string, body?: unknown) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : {};
};

// 3. A candidate with some history: practice, one finished mock exam, a pass.
const EMAIL = 'layla@example.com';
const PASS = 'sample passphrase 2026';
const userId = await store.createUser(EMAIL, hashPassword(PASS), 'en');
await store.markVerified(userId, new Date().toISOString());
await store.grantEntitlement(userId, 'pass90', 'admin_grant', null, 90, new Date().toISOString(), null, 'screenshots');
let { accessToken: tk } = await api('POST', '/auth/login', undefined, { email: EMAIL, password: PASS });
await api('PATCH', '/me', tk, { examTargetDate: new Date(Date.now() + 41 * 86_400_000).toISOString().slice(0, 10), weeklyStudyHours: 8 });
const session = await api('POST', '/practice/sessions', tk, { mode: 'quick', questionCount: 40 });
for (let i = 1; i <= 40; i++) {
  const q = await api('GET', `/practice/sessions/${session.id}/questions/${i}`, tk);
  const pick = i % 4 === 0 ? q.options[0].id : null; // about three in four answered well
  const key = (await store.practiceItem(session.id, userId, i))!.question.options.filter((o) => o.isCorrect).map((o) => o.id);
  await api('POST', `/practice/sessions/${session.id}/questions/${i}/answer`, tk, { selectedOptionIds: pick ? [pick] : key, timeSpentMs: 60_000 });
}
const attempt = await api('POST', '/exams/attempts', tk);
for (let s = 0; s < 3; s++) {
  const qs = await api('GET', `/exams/attempts/${attempt.id}/sections/${s}/questions`, tk);
  let seq = 1;
  for (const q of qs.questions) {
    if (q.ordinal % 5 !== 0) {
      // A spread of answers; one in five left blank.
      await api('PUT', `/exams/attempts/${attempt.id}/answers/${q.ordinal}`, tk, { selectedOptionIds: [q.options[q.ordinal % 3 === 0 ? 0 : 1].id], clientSeq: seq++ });
    }
  }
  if (s < 2) { await api('POST', `/exams/attempts/${attempt.id}/sections/${s}/close`, tk); await api('POST', `/exams/attempts/${attempt.id}/resume`, tk); }
  ({ accessToken: tk } = await api('POST', '/auth/login', undefined, { email: EMAIL, password: PASS }));
}
await api('POST', `/exams/attempts/${attempt.id}/submit`, tk);
await api('POST', '/exams/attempts', tk); // an exam in progress for the exam screenshot

// 4. Screenshots.
const pw = await import(process.env.PLAYWRIGHT_MODULE ?? '/opt/npm-tools/node_modules/playwright/index.js');
const browser = await (pw.chromium ?? pw.default.chromium).launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', headless: true });
for (const lang of ['en', 'ar'] as const) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: lang === 'ar' ? 'ar-EG' : 'en-GB' });
  const page = await ctx.newPage();
  await page.goto(`${base}/app`);
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASS);
  await page.click('button[type=submit]');
  await page.waitForSelector('nav.tabs');
  if (lang === 'ar') { await page.click('[data-act=lang]'); await page.waitForSelector('nav a:has-text("الرئيسية")'); }
  const shot = async (name: string) => { await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(300); await page.screenshot({ path: `${OUT}${lang}-${name}.png` }); };
  await page.goto(`${base}/app#home`); await page.waitForSelector('.tiles'); await shot('1-home');
  await page.goto(`${base}/app#practice`); await page.waitForSelector('#setup'); await page.selectOption('#count', '10'); await page.click('#setup button[type=submit]');
  await page.waitForSelector('.opt[data-opt]'); await shot('2-practice-question');
  await page.click('.opt[data-opt] >> nth=1'); await page.click('#check'); await page.waitForSelector('.verdict');
  await page.evaluate(() => window.scrollTo(0, 0)); await shot('3-explanation');
  await page.goto(`${base}/app#mock`); await page.waitForSelector('#resume'); await page.click('#resume'); await page.waitForSelector('.opt[data-opt]');
  // Show a single-choice case question: its options belong to the scenario on screen.
  for (let i = 0; i < 8 && /Choose 2|اختر 2/.test(await page.textContent('main')); i++) { await page.click('#next'); await page.waitForTimeout(200); }
  await page.click('.opt[data-opt] >> nth=0'); await page.waitForSelector('#saving'); await shot('4-mock-exam');
  await page.goto(`${base}/app#stats`); await page.waitForSelector('.bar'); await shot('5-results');
  await page.goto(`${base}/app#plan`); await page.waitForSelector('#status'); await shot('6-plan');
  // Undo the language choice for the next run.
  if (lang === 'ar') await api('PATCH', '/me', tk, { language: 'en' });
  await ctx.close();
}

// 5. Feature graphic, 1024 x 500.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="500" viewBox="0 0 1024 500">
  <rect width="1024" height="500" fill="#1b4a78"/>
  <g transform="translate(120 130) scale(0.47)">
    <circle cx="256" cy="256" r="150" fill="none" stroke="#86b8ea" stroke-width="28" stroke-linecap="round" stroke-dasharray="700 300" transform="rotate(-90 256 256)"/>
    <path d="M188 262 l46 46 l92 -104" fill="none" stroke="#fff" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <text x="400" y="200" fill="#fff" font-family="IBM Plex Sans, Segoe UI, DejaVu Sans, sans-serif" font-size="52" font-weight="700">Exam Simulator</text>
  <text x="400" y="258" fill="#d7e6f5" font-family="IBM Plex Sans, Segoe UI, DejaVu Sans, sans-serif" font-size="28">PMP practice and full mock exams</text>
  <text x="400" y="312" fill="#d7e6f5" font-family="Noto Sans Arabic, DejaVu Sans, sans-serif" font-size="28">تدريب واختبارات تجريبية كاملة لـ PMP</text>
  <text x="400" y="380" fill="#86b8ea" font-family="IBM Plex Sans, Segoe UI, DejaVu Sans, sans-serif" font-size="20">Arabic · English · July 2026 exam outline</text>
</svg>`;
writeFileSync(`${OUT}feature-graphic.svg`, svg);
execFileSync('rsvg-convert', ['-w', '1024', '-h', '500', `${OUT}feature-graphic.svg`, '-o', `${OUT}feature-graphic.png`]);
execFileSync('cp', [new URL('packages/candidate-web/assets/icon-maskable-512.png', ROOT).pathname, `${OUT}app-icon-512.png`]);

await browser.close();
server.close();
await db.close();
psql('postgres', `DROP DATABASE IF EXISTS ${DB}`);
console.log(`store images written to ${OUT}`);
