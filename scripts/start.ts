// Container entry point: brings the database up to date, then starts the
// server. Hosts without a shell or a separate migration step (for example
// free web-service plans) need nothing else.
//
// Optional, for a first deployment or a trial site:
//   ADMIN_EMAIL + ADMIN_PASSWORD   create the first administrator (or give an existing account the role)
//   DEMO_CONTENT=1                 load the SYNTHETIC demo question bank and a demo student
//                                  (student@demo.local / demo student 2026). Refused when NODE_ENV=production.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PgPool, configFromEnv } from '../packages/exam-store/src/pg-wire.ts';
import { ApiStore } from '../packages/api/src/api-store.ts';
import { hashPassword } from '../packages/api/src/auth.ts';

const ROOT = new URL('../', import.meta.url);
const script = (p: string) => fileURLToPath(new URL(p, ROOT));
const run = (p: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env) => {
  const r = spawnSync(process.execPath, [script(p), ...args], { env, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run('scripts/migrate.ts');

if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  run('scripts/create-admin.ts', ['--email', process.env.ADMIN_EMAIL]);
}

if (process.env.DEMO_CONTENT === '1') {
  if (process.env.NODE_ENV === 'production') {
    console.error('DEMO_CONTENT=1 is refused with NODE_ENV=production: the demo bank is not exam content.');
    process.exit(1);
  }
  const db = new PgPool({ ...configFromEnv(), statementTimeoutMs: 0 }, { max: 1 });
  const store = new ApiStore(db);
  if ((await db.run('SELECT count(*) FROM questions;')) === '0') {
    console.log('loading the synthetic demo question bank…');
    await db.run(readFileSync(new URL('db/seed/synthetic_bank.sql', ROOT), 'utf8'));
  }
  if (!(await store.userByEmail('student@demo.local'))) {
    const now = new Date().toISOString();
    const id = await store.createUser('student@demo.local', hashPassword('demo student 2026'), 'ar');
    await store.markVerified(id, now);
    await store.grantEntitlement(id, 'pass90', 'admin_grant', null, 90, now, null, 'demo');
    console.log('demo student: student@demo.local / demo student 2026');
  }
  await db.close();
}

const server = spawn(process.execPath, [script('packages/api/src/server.ts')], { stdio: 'inherit' });
process.on('SIGTERM', () => server.kill('SIGTERM'));
process.on('SIGINT', () => server.kill('SIGINT'));
server.on('exit', (code) => process.exit(code ?? 0));
