// Runs a complete demo on your own computer with one command, so you can
// see the candidate app and the admin panel working, including full mock
// exams. Works on Windows, macOS and Linux; needs Node.js 22.18+ and a
// local PostgreSQL 16 you can sign in to.
//
//   node scripts/demo.ts
//
// Connection: the usual PG* variables (PGHOST, PGPORT, PGUSER, PGPASSWORD).
// It creates its own database (default exam_demo, or DEMO_DATABASE), fills
// it with a SYNTHETIC question bank whose text repeats a handful of sample
// questions, creates two demo accounts, and starts the server on
// http://127.0.0.1:8080 (or PORT). Account emails are printed here instead
// of sent.
//
// DEMO ONLY. The demo bank is not exam content, and the demo passwords are
// public. Never run this against a production database; it refuses when
// NODE_ENV=production. To start again from nothing: node scripts/demo.ts --reset

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PgPool, configFromEnv } from '../packages/exam-store/src/pg-wire.ts';
import { lit } from '../packages/exam-store/src/psql-store.ts';
import { ApiStore } from '../packages/api/src/api-store.ts';
import { hashPassword } from '../packages/api/src/auth.ts';
import { sampleContentSql } from './lib/sample-content.ts';

const ROOT = new URL('../', import.meta.url);
const DB = process.env.DEMO_DATABASE ?? 'exam_demo';
const PORT = process.env.PORT ?? '8080';
const CANDIDATE = { email: 'student@demo.local', password: 'demo student 2026' };
const ADMIN = { email: 'admin@demo.local', password: 'demo admin 2026' };
const say = (m: string) => console.log(m);
const fail = (m: string): never => { console.error(m); process.exit(1); };

if (process.env.NODE_ENV === 'production') fail('The demo must not run with NODE_ENV=production.');
if (!/^[a-z][a-z0-9_]{0,40}$/.test(DB)) fail('DEMO_DATABASE must be a simple lower-case name.');
const base = configFromEnv({ PGHOST: '127.0.0.1', ...process.env });

// 1. The demo database.
const adminDb = new PgPool({ ...base, database: process.env.PGDATABASE ?? 'postgres', statementTimeoutMs: 0 }, { max: 1 });
try {
  if (process.argv.includes('--reset')) { await adminDb.run(`DROP DATABASE IF EXISTS ${DB};`); say(`removed database ${DB}`); }
  if ((await adminDb.run(`SELECT 1 FROM pg_database WHERE datname = ${lit.text(DB)};`)) !== '1') {
    await adminDb.run(`CREATE DATABASE ${DB};`);
    say(`created database ${DB}`);
  }
} catch (e) {
  fail(`Could not reach PostgreSQL (${e instanceof Error ? e.message : e}).\nSet PGHOST, PGPORT, PGUSER and PGPASSWORD for a local PostgreSQL 16 and try again.`);
} finally {
  await adminDb.close();
}
const env = { ...process.env, PGHOST: base.host, PGPORT: String(base.port), PGUSER: base.user, PGDATABASE: DB };

// 2. Schema and blueprint: the same command production uses.
await new Promise<void>((resolve) => {
  spawn(process.execPath, [fileURLToPath(new URL('scripts/migrate.ts', ROOT))], { env, stdio: 'inherit' })
    .on('exit', (code) => (code === 0 ? resolve() : fail('Migration failed.')));
});

// 3. Demo content and accounts, once.
const db = new PgPool({ ...base, database: DB, statementTimeoutMs: 0 }, { max: 2 });
const store = new ApiStore(db);
if ((await db.run('SELECT count(*) FROM questions;')) === '0') {
  say('loading the synthetic demo question bank (about a minute)…');
  await db.run(readFileSync(new URL('db/seed/synthetic_bank.sql', ROOT), 'utf8'));
  try {
    await db.run(sampleContentSql(ROOT, 'SET LOCAL session_replication_role = replica;'));
  } catch {
    say('note: the database user is not a superuser, so demo questions keep their placeholder text ("Synthetic item …").');
  }
}
const now = new Date().toISOString();
if (!(await store.userByEmail(CANDIDATE.email))) {
  const id = await store.createUser(CANDIDATE.email, hashPassword(CANDIDATE.password), 'ar');
  await store.markVerified(id, now);
  await store.grantEntitlement(id, 'pass90', 'admin_grant', null, 90, now, null, 'demo');
}
if (!(await store.userByEmail(ADMIN.email))) {
  const id = await store.createUser(ADMIN.email, hashPassword(ADMIN.password), 'en');
  await store.markVerified(id, now);
  await db.run(`INSERT INTO user_roles (user_id, role_id) SELECT ${lit.uuid(id)}, id FROM roles WHERE code IN ('administrator', 'content_author') ON CONFLICT DO NOTHING;`);
}
await db.close();

// 4. The server, in development mode. The secret is kept so sign-ins survive a restart.
const secretFile = new URL('.demo-secret', ROOT);
if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString('hex'), { mode: 0o600 });
say(`
────────────────────────────────────────────────────────────
 DEMO (synthetic questions, public demo passwords)
 Site:        http://127.0.0.1:${PORT}/
 Student app: http://127.0.0.1:${PORT}/app     ${CANDIDATE.email} / ${CANDIDATE.password}
 Admin panel: http://127.0.0.1:${PORT}/admin   ${ADMIN.email} / ${ADMIN.password}
              (the admin sets up two-factor sign-in with an authenticator app at first sign-in)
 Stop with Ctrl+C.
────────────────────────────────────────────────────────────`);
const server = spawn(process.execPath, [fileURLToPath(new URL('packages/api/src/server.ts', ROOT))], {
  env: { ...env, NODE_ENV: 'development', PORT, MAIL_MODE: 'log', TOKEN_SECRET: readFileSync(secretFile, 'utf8').trim(), APP_NAME: process.env.APP_NAME ?? 'Exam Simulator (demo)' },
  stdio: 'inherit',
});
process.on('SIGINT', () => server.kill('SIGINT'));
process.on('SIGTERM', () => server.kill('SIGTERM'));
server.on('exit', (code) => process.exit(code ?? 0));
