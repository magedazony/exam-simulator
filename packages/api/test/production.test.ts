// Production rehearsal: on a brand-new empty database, run the same commands
// an operator runs (migrate, create-admin), start the real server process in
// production mode with SMTP, and go through sign-up by email, sign-in, the
// health check and the admin's first sign-in. Needs the throwaway cluster
// from scripts/pg-temp.sh (it creates its own database inside it).

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { startFakeSmtp } from './fake-smtp.ts';
import type { FakeSmtp } from './fake-smtp.ts';

const configured = Boolean(process.env.PGDATABASE);
const ROOT = new URL('../../../', import.meta.url).pathname;
const DB = 'pmpsim_rehearsal';
const PORT = 18_000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const pgEnv = { ...process.env, PGDATABASE: DB };
const run = (script: string, args: string[] = [], extra: Record<string, string> = {}) =>
  execFileSync('node', [`${ROOT}scripts/${script}`, ...args], { env: { ...pgEnv, ...extra }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const psql = (sql: string) => execFileSync('psql', ['-qAtX', '-d', DB, '-c', sql], { env: pgEnv, encoding: 'utf8' }).trim();

describe('production rehearsal on an empty database', { skip: configured ? false : 'PGDATABASE is not set; see scripts/pg-temp.sh' }, () => {
  let smtp: FakeSmtp;
  let server: ChildProcess | null = null;
  const out: string[] = [];
  const err: string[] = [];
  const prodEnv = () => ({
    ...pgEnv,
    NODE_ENV: 'production',
    PORT: String(PORT),
    HOST: '127.0.0.1',
    PUBLIC_URL: 'https://exam.example.test',
    TOKEN_SECRET: 'f3a9c1d27be84e0fa6c5d1b2e9f04a7c3d8b6e1f2a9c7d4e',
    TRUST_PROXY_HOPS: '1',
    MAIL_FROM: 'Exam Simulator <no-reply@example.test>',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_USER: 'mailer',
    SMTP_PASSWORD: 'smtp secret',
    SMTP_SECURITY: 'starttls',
    SMTP_ALLOW_INVALID_CERT: '1', // the fake server's certificate is self-signed
    TERMS_URL: 'https://exam.example.test/terms',
    PRIVACY_URL: 'https://exam.example.test/privacy',
    SUPPORT_EMAIL: 'help@example.test',
    ANDROID_PACKAGE: 'com.example.exam',
    ANDROID_CERT_SHA256: Array.from({ length: 32 }, () => 'AB').join(':'),
  });

  before(async () => {
    smtp = await startFakeSmtp({ user: 'mailer', password: 'smtp secret' });
    execFileSync('psql', ['-qAtX', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${DB}`, '-c', `CREATE DATABASE ${DB}`], { env: process.env });
  });
  after(async () => {
    server?.kill('SIGTERM');
    await smtp.close();
  });

  it('refuses to start before the database is migrated', () => {
    const r = (() => { try { execFileSync('node', [`${ROOT}packages/api/src/server.ts`], { env: prodEnv(), encoding: 'utf8', stdio: 'pipe', timeout: 20_000 }); return ''; } catch (e) { return String((e as { stderr?: string }).stderr); } })();
    assert.match(r, /database not ready.*run: node scripts\/migrate\.ts/);
  });

  it('migrates an empty database, activates the blueprint, and is idempotent', () => {
    const first = run('migrate.ts');
    assert.match(first, /applied {2}001_core\.sql/);
    assert.match(first, /applied {2}007_access\.sql/);
    assert.match(first, /imported and activated blueprint PMP-ECO/);
    const second = run('migrate.ts');
    assert.match(second, /database schema is up to date/);
    assert.match(second, /blueprint PMP-ECO is active/);
    // No test data: an empty bank, no users.
    assert.equal(psql('SELECT count(*) FROM questions'), '0');
    assert.equal(psql('SELECT count(*) FROM users'), '0');
  });

  it('stops, changing nothing, if an applied migration file was edited', () => {
    const file = `${ROOT}db/migrations/007_access.sql`;
    const backup = `/tmp/007_access.sql.bak`;
    copyFileSync(file, backup);
    try {
      appendFileSync(file, '\n-- edited after it was applied\n');
      const r = (() => { try { run('migrate.ts'); return ''; } catch (e) { return String((e as { stderr?: string }).stderr); } })();
      assert.match(r, /007_access\.sql changed after it was applied/);
    } finally {
      copyFileSync(backup, file);
      rmSync(backup);
    }
    // A new migration that fails is rolled back completely.
    const bad = `${ROOT}db/migrations/998_rehearsal_failure.sql`;
    writeFileSync(bad, 'CREATE TABLE rehearsal_probe (id int);\nSELECT no_such_function();\n');
    try {
      const r = (() => { try { run('migrate.ts'); return ''; } catch (e) { return String((e as { stderr?: string }).stderr); } })();
      assert.match(r, /998_rehearsal_failure\.sql failed/);
      assert.equal(psql(`SELECT to_regclass('rehearsal_probe') IS NULL`), 't');
      assert.equal(psql(`SELECT count(*) FROM schema_migrations WHERE name LIKE '998%'`), '0');
    } finally {
      rmSync(bad);
    }
  });

  it('creates the first administrator from the command line', () => {
    const weak = (() => { try { run('create-admin.ts', ['--email', 'owner@example.test'], { ADMIN_PASSWORD: 'short' }); return ''; } catch (e) { return String((e as { stderr?: string }).stderr); } })();
    assert.match(weak, /at least 10 characters/);
    assert.match(run('create-admin.ts', ['--email', 'Owner@Example.test'], { ADMIN_PASSWORD: 'owner passphrase 2026' }), /Done\. Sign in at \/admin/);
    assert.equal(psql(`SELECT string_agg(r.code, ',' ORDER BY r.code) FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.email = 'owner@example.test'`), 'administrator,student');
    assert.match(run('create-admin.ts', ['--email', 'owner@example.test']), /exists; giving it the administrator role/);
  });

  it('refuses unsafe production settings with a list of what to fix', () => {
    const r = (() => {
      try {
        execFileSync('node', [`${ROOT}packages/api/src/server.ts`], {
          env: { ...prodEnv(), TOKEN_SECRET: 'changeme', PUBLIC_URL: 'http://exam.example.test', MAIL_MODE: 'log', TERMS_URL: '' },
          encoding: 'utf8', stdio: 'pipe', timeout: 20_000,
        });
        return '';
      } catch (e) { return String((e as { stderr?: string }).stderr); }
    })();
    assert.match(r, /TOKEN_SECRET must be at least 32 characters/);
    assert.match(r, /PUBLIC_URL must use https in production/);
    assert.match(r, /MAIL_MODE=log prints account links/);
    assert.match(r, /TERMS_URL and PRIVACY_URL are required in production/);
  });

  it('starts in production mode and serves the apps with security headers', async () => {
    server = spawn('node', [`${ROOT}packages/api/src/server.ts`], { env: prodEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout!.on('data', (d: Buffer) => out.push(...d.toString().split('\n').filter(Boolean)));
    server.stderr!.on('data', (d: Buffer) => err.push(d.toString()));
    for (let i = 0; i < 100 && !out.some((l) => l.includes('listening')); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(out.some((l) => l.includes('"mode":"production"')), `server did not start: ${err.join('')}`);

    const health = await fetch(`${BASE}/api/v1/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
    assert.ok(health.headers.get('x-request-id'));
    const root = await fetch(`${BASE}/`, { redirect: 'manual' });
    assert.equal(root.status, 200);
    assert.match(await root.text(), /href="\/app#register"/); // landing page links into the app
    const manifest = (await (await fetch(`${BASE}/app/manifest.webmanifest`)).json()) as { name: string };
    assert.equal(manifest.name, 'Exam Simulator');
    assert.equal((await fetch(`${BASE}/sw.js`)).status, 200);
    const links = (await (await fetch(`${BASE}/.well-known/assetlinks.json`)).json()) as Array<{ target: { package_name: string } }>;
    assert.equal(links[0]!.target.package_name, 'com.example.exam');
    const site = (await (await fetch(`${BASE}/api/v1/site`)).json()) as Record<string, string>;
    assert.deepEqual(site, { termsUrl: 'https://exam.example.test/terms', privacyUrl: 'https://exam.example.test/privacy', supportEmail: 'help@example.test' });
    const page = await fetch(`${BASE}/app`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  });

  it('signs a candidate up through a real email, then signs in', async () => {
    const api = (path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) =>
      fetch(`${BASE}/api/v1${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const reg = await api('/auth/register', { email: 'sara@example.test', password: 'sara passphrase 2026', language: 'ar', acceptTerms: true });
    assert.equal(reg.status, 201, await reg.clone().text());
    for (let i = 0; i < 50 && smtp.messages.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    const mail = smtp.messages.at(-1)!;
    assert.equal(mail.to, 'sara@example.test');
    assert.equal(mail.encrypted, true);
    const token = decodeURIComponent(/#verify\?token=([^\s]+)/.exec(mail.text)![1]!);
    assert.ok(mail.text.includes('https://exam.example.test/app#verify?token='));

    assert.equal((await api('/auth/verify-email', { token })).status, 204);
    const login = await api('/auth/login', { email: 'sara@example.test', password: 'sara passphrase 2026' });
    assert.equal(login.status, 200);
    const { accessToken } = (await login.json()) as { accessToken: string };
    assert.equal(((await (await api('/me', undefined, accessToken)).json()) as { language: string }).language, 'ar');

    // With an empty bank a full mock exam cannot be built yet; the server says so plainly.
    const mock = await api('/exams/attempts', {}, accessToken);
    assert.equal(mock.status, 402); // a free account is asked to unlock first

    // Rate limiting counts the client address from X-Forwarded-For (one trusted proxy).
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const r = await api('/auth/login', { email: 'nobody@example.test', password: 'wrong password 1' }, undefined, { 'x-forwarded-for': '203.0.113.9' });
      if (r.status === 429) limited++;
    }
    assert.ok(limited >= 1, 'the repeated client is limited');
    const other = await api('/auth/login', { email: 'nobody@example.test', password: 'wrong password 1' }, undefined, { 'x-forwarded-for': '198.51.100.7' });
    assert.equal(other.status, 401, 'another client is not affected');
  });

  it('lets the first administrator in only after setting up two-factor sign-in', async () => {
    const login = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.test', password: 'owner passphrase 2026' }) });
    assert.equal(login.status, 200);
    const { accessToken } = (await login.json()) as { accessToken: string };
    const staff = await fetch(`${BASE}/api/v1/admin/questions`, { headers: { authorization: `Bearer ${accessToken}` } });
    assert.equal(staff.status, 403);
    assert.equal(((await staff.json()) as { code: string }).code, 'mfa_required');
  });

  it('writes one JSON log line per request with no tokens or query strings, and stops cleanly', async () => {
    await fetch(`${BASE}/api/v1/exhibits/00000000-0000-4000-8000-000000000000?exp=1&sig=secret-signature`);
    await new Promise((r) => setTimeout(r, 200));
    const lines = out.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.requestId);
    assert.ok(lines.length >= 10);
    assert.ok(lines.some((l) => l.path === '/api/v1/auth/login' && l.status === 200 && l.ip === '127.0.0.1'));
    const all = out.join('\n');
    assert.doesNotMatch(all, /secret-signature|passphrase|Bearer/);
    const exited = new Promise<number | null>((r) => server!.once('exit', (c) => r(c)));
    server!.kill('SIGTERM');
    assert.equal(await exited, 0);
    server = null;
    assert.equal(err.join(''), '', 'no errors were logged');
    assert.ok(readFileSync(`${ROOT}db/migrations/007_access.sql`, 'utf8').endsWith('$$;\n'), 'the migration file was restored');
  });
});
