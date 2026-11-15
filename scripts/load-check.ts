// Rough load check of the API on the connection pool: many signed-in
// candidates loading their dashboard and a practice question at once.
//   eval "$(scripts/pg-temp.sh start)" && node scripts/load-check.ts [users] [rounds]
// Not a capacity test: one laptop-sized machine, database on the same host.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MockExamService } from '../packages/exam-store/src/service.ts';
import { PgPool } from '../packages/exam-store/src/pg-wire.ts';
import { ApiStore } from '../packages/api/src/api-store.ts';
import { DEFAULT_APP_CONFIG, createApp } from '../packages/api/src/app.ts';
import { hashPassword } from '../packages/api/src/auth.ts';

const users = Number(process.argv[2] ?? 50);
const rounds = Number(process.argv[3] ?? 10);
const db = new PgPool(undefined, { max: Number(process.env.PGPOOL_MAX ?? 10) });
// LOAD_PSQL=1 runs the same check on the old psql adapter, for comparison.
const store = process.env.LOAD_PSQL ? new ApiStore() : new ApiStore(db);
const app = createApp({
  store, service: new MockExamService(store), now: () => Date.now(), mailer: () => {},
  config: { ...DEFAULT_APP_CONFIG, tokenSecret: 'load-check-secret-not-for-production-use', authRateLimit: 1_000_000 },
});
const server = createServer(app).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json() as Promise<any>;
};

const hash = hashPassword('load check passphrase');
const tokens: string[] = [];
for (let i = 0; i < users; i++) {
  const email = `load${i}-${Date.now()}@example.test`;
  const id = await store.createUser(email, hash, 'en');
  await store.markVerified(id, new Date().toISOString());
  tokens.push((await call('POST', '/auth/login', undefined, { email, password: 'load check passphrase' })).accessToken);
}
const latencies: number[] = [];
const started = Date.now();
await Promise.all(tokens.map(async (tk) => {
  const s = await call('POST', '/practice/sessions', tk, { mode: 'quick', questionCount: rounds });
  for (let i = 1; i <= rounds; i++) {
    const t0 = performance.now();
    await call('GET', '/me/dashboard', tk);
    await call('GET', `/practice/sessions/${s.id}/questions/${i}`, tk);
    latencies.push(performance.now() - t0);
  }
}));
const seconds = (Date.now() - started) / 1000;
latencies.sort((a, b) => a - b);
const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]!.toFixed(0);
const requests = users * (rounds * 2 + 1);
console.log(`${users} candidates at once, ${requests} requests in ${seconds.toFixed(1)} s = ${(requests / seconds).toFixed(0)} requests/s`);
console.log(`dashboard + question, per pair: median ${pct(50)} ms, 95th percentile ${pct(95)} ms, worst ${pct(100)} ms; pool ${JSON.stringify(db.stats())}`);
server.close();
await db.close();
