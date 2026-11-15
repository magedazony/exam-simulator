// Tests of the PostgreSQL protocol client and pool, against the throwaway
// database from scripts/pg-temp.sh (which also opens loopback TCP with TLS
// and password sign-in for these tests).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, describe, it } from 'node:test';
import { PgConnectionError, PgError, PgPool, configFromEnv } from '../src/pg-wire.ts';
import type { PgConfig } from '../src/pg-wire.ts';

const configured = Boolean(process.env.PGDATABASE);
const base = (): PgConfig => configFromEnv();
const tcp = (over: Partial<PgConfig>): PgConfig => ({ ...base(), host: '127.0.0.1', ...over });

describe('PostgreSQL protocol client', { skip: configured ? false : 'PGDATABASE is not set; see scripts/pg-temp.sh' }, () => {
  const pool = new PgPool(base(), { max: 3, acquireTimeoutMs: 2000 });
  after(() => pool.close());

  it('returns rows the way psql -At prints them: NULL empty, booleans t/f, rows by newline', async () => {
    assert.equal(await pool.run(`SELECT 1, NULL, 'x', true; SELECT 'second';`), '1||x|t\nsecond');
    assert.equal(await pool.run(`SELECT 'ü مرحبا ✓'`), 'ü مرحبا ✓');
    assert.equal(await pool.run(`SELECT '{"a":1}'::jsonb`), '{"a": 1}');
    assert.equal(await pool.run(`SELECT 1 WHERE false`), '');
    // Sessions run in UTC whatever the server's own setting.
    assert.equal(await pool.run(`SHOW TimeZone`), 'UTC');
  });

  it('reports server errors with code, constraint and psql-style text, and the connection stays usable', async () => {
    await assert.rejects(pool.run(`SELECT grant_entitlement(gen_random_uuid(), 'nope', 'web', NULL, 1, now(), NULL, NULL)`), (e: unknown) => {
      assert.ok(e instanceof PgError);
      assert.equal(e.code, 'P0001');
      assert.match(e.stderr, /^ERROR: {2}E_UNKNOWN_PLAN/);
      return true;
    });
    await assert.rejects(pool.run(`INSERT INTO roles (id, code) VALUES (1, 'student')`), (e: unknown) => {
      assert.ok(e instanceof PgError);
      assert.equal(e.code, '23505');
      assert.equal(e.constraint, 'roles_pkey');
      return true;
    });
    assert.equal(await pool.run(`SELECT 42`), '42');
  });

  it('runs a multi-statement call as one transaction: a failure undoes the earlier statements', async () => {
    await pool.run(`CREATE TABLE IF NOT EXISTS wire_probe (v int)`);
    await assert.rejects(pool.run(`INSERT INTO wire_probe VALUES (1); SELECT 1/0;`));
    assert.equal(await pool.run(`SELECT count(*) FROM wire_probe`), '0');
  });

  it('commits or rolls back an explicit transaction on one connection', async () => {
    await pool.transaction(async (tx) => {
      await tx.run(`INSERT INTO wire_probe VALUES (2)`);
      await tx.run(`INSERT INTO wire_probe VALUES (3)`);
    });
    await assert.rejects(
      pool.transaction(async (tx) => {
        await tx.run(`INSERT INTO wire_probe VALUES (4)`);
        throw new Error('changed my mind');
      }),
      /changed my mind/,
    );
    assert.equal(await pool.run(`SELECT string_agg(v::text, ',' ORDER BY v) FROM wire_probe`), '2,3');
    await pool.run(`DROP TABLE wire_probe`);
  });

  it('never opens more than its limit, queues the rest, and serves them all', async () => {
    const started = Date.now();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => pool.run(`SELECT ${i} FROM pg_sleep(0.05)`)));
    assert.deepEqual(results, Array.from({ length: 12 }, (_, i) => String(i)));
    assert.ok(pool.stats().open <= 3);
    // 12 queries of 50 ms on 3 connections take at least 4 rounds.
    assert.ok(Date.now() - started >= 190);
  });

  it('times out a request that waits too long for a free connection', async () => {
    const small = new PgPool(base(), { max: 1, acquireTimeoutMs: 100 });
    const slow = small.run(`SELECT pg_sleep(0.4)`);
    await assert.rejects(small.run(`SELECT 1`), /no database connection became free/);
    await slow;
    await small.close();
  });

  it('replaces a connection the server closed, without failing later requests', async () => {
    const small = new PgPool(base(), { max: 1 });
    const pid = await small.run(`SELECT pg_backend_pid()`);
    await pool.run(`SELECT pg_terminate_backend(${Number(pid)})`);
    await new Promise((r) => setTimeout(r, 100));
    // The request that meets the dead connection fails cleanly...
    const first = await small.run(`SELECT 1`).catch((e: Error) => e);
    if (first instanceof Error) assert.ok(first instanceof PgConnectionError || first instanceof PgError);
    // ...and the next one gets a fresh connection.
    assert.notEqual(await small.run(`SELECT pg_backend_pid()`), pid);
    await small.close();
  });

  it('applies the statement time limit', async () => {
    const strict = new PgPool({ ...base(), statementTimeoutMs: 100 }, { max: 1 });
    await assert.rejects(strict.run(`SELECT pg_sleep(1)`), (e: unknown) => e instanceof PgError && e.code === '57014');
    assert.equal(await strict.run(`SELECT 'still fine'`), 'still fine');
    await strict.close();
  });

  it('signs in with SCRAM-SHA-256 over TLS, checking the server certificate', async () => {
    const ca = readFileSync('/tmp/pmp-sim-pg-ca.crt', 'utf8');
    const p = new PgPool(tcp({ user: 'scram_user', password: 'scram pass ü', sslmode: 'verify-full', sslRootCert: ca, host: 'localhost' }), { max: 1 });
    assert.equal(await p.run(`SELECT current_user, ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()`), 'scram_user|t');
    await p.close();
  });

  it('refuses a server certificate it cannot verify, and a wrong SCRAM password', async () => {
    const p = new PgPool(tcp({ user: 'scram_user', password: 'scram pass ü', sslmode: 'verify-full' }), { max: 1 });
    await assert.rejects(p.run('SELECT 1'), /encrypted connection failed/);
    await p.close();
    const wrong = new PgPool(tcp({ user: 'scram_user', password: 'not it', sslmode: 'require' }), { max: 1 });
    await assert.rejects(wrong.run('SELECT 1'), (e: unknown) => e instanceof PgError && e.code === '28P01');
    await wrong.close();
  });

  it('signs in with MD5 and plain passwords, and explains a missing password', async () => {
    const md5 = new PgPool(tcp({ user: 'md5_user', password: 'md5 pass' }), { max: 1 });
    assert.equal(await md5.run('SELECT current_user'), 'md5_user');
    await md5.close();
    const plain = new PgPool(tcp({ user: 'plain_user', password: 'plain pass', sslmode: 'require' }), { max: 1 });
    assert.equal(await plain.run('SELECT current_user'), 'plain_user');
    await plain.close();
    const none = new PgPool(tcp({ user: 'md5_user', password: undefined }), { max: 1 });
    await assert.rejects(none.run('SELECT 1'), /set PGPASSWORD/);
    await none.close();
  });

  it('reports a server that cannot be reached', async () => {
    const p = new PgPool(tcp({ port: 1, connectTimeoutMs: 1000 }), { max: 1 });
    await assert.rejects(p.run('SELECT 1'), (e: unknown) => e instanceof PgConnectionError && /could not connect/.test(e.message));
    await p.close();
  });
});
