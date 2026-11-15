// Brings a database up to date: applies pending migrations in order, then
// makes sure an exam blueprint is active.
//
//   node scripts/migrate.ts            apply pending migrations, import the blueprint if none is active
//   node scripts/migrate.ts --status   list migrations and whether each is applied; change nothing
//   node scripts/migrate.ts --no-blueprint
//
// Connection settings: the PG* variables. Safe to run on every deployment:
// applied migrations are skipped, each new one runs in its own transaction,
// an advisory lock stops two deployments migrating at once, and a migration
// file that changed after it was applied stops the run (never edit an
// applied migration; add a new one). Never loads test data.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { PgPool, configFromEnv } from '../packages/exam-store/src/pg-wire.ts';
import { lit } from '../packages/exam-store/src/psql-store.ts';

const ROOT = new URL('../', import.meta.url);
const DIR = new URL('db/migrations/', ROOT);
const BLUEPRINT = new URL('packages/exam-engine/data/blueprint-2026-07.json', ROOT);
const LOCK_ID = 727_001; // any constant shared by every copy of this script

const args = new Set(process.argv.slice(2));
const statusOnly = args.has('--status');
const say = (m: string) => console.log(m);

const files = readdirSync(DIR).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const pool = new PgPool({ ...configFromEnv(), statementTimeoutMs: 0, applicationName: 'exam-simulator-migrate' }, { max: 1 });
let code = 0;
try {
  await pool.transaction(async (tx) => {
    // Transaction-level lock: held until this run commits or rolls back.
    await tx.run(`SELECT pg_advisory_xact_lock(${LOCK_ID});`);
    await tx.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());`);
    const appliedRows = await tx.run(`SELECT name || ' ' || sha256 FROM schema_migrations ORDER BY name;`);
    const applied = new Map(appliedRows ? appliedRows.split('\n').map((l) => l.split(' ') as [string, string]) : []);

    for (const name of applied.keys()) if (!files.includes(name)) throw new Error(`${name} is recorded as applied but its file is missing`);
    const pending: string[] = [];
    for (const f of files) {
      const text = readFileSync(new URL(f, DIR), 'utf8');
      const recorded = applied.get(f);
      if (recorded && recorded !== sha(text)) throw new Error(`${f} changed after it was applied. Restore it and add a new migration instead.`);
      if (statusOnly) say(`${recorded ? 'applied ' : 'pending '} ${f}`);
      if (!recorded) pending.push(f);
    }
    if (statusOnly) return;

    for (const f of pending) {
      const text = readFileSync(new URL(f, DIR), 'utf8');
      const started = Date.now();
      // The whole run is one transaction: if any migration fails, none of this run is kept.
      await tx.run(`SAVEPOINT m;`);
      try {
        await tx.run(text);
      } catch (e) {
        throw new Error(`${f} failed: ${e instanceof Error ? e.message : e}`);
      }
      await tx.run(`INSERT INTO schema_migrations (name, sha256) VALUES (${lit.text(f)}, ${lit.text(sha(text))}); RELEASE SAVEPOINT m;`);
      say(`applied  ${f} (${Date.now() - started} ms)`);
    }
    if (pending.length === 0) say('database schema is up to date');

    if (!args.has('--no-blueprint')) {
      const doc = readFileSync(BLUEPRINT, 'utf8');
      const code = JSON.parse(doc).code as string;
      const active = await tx.run(`SELECT active_blueprint(${lit.text(code)}) IS NOT NULL;`);
      if (active === 't') say(`blueprint ${code} is active`);
      else {
        await tx.run(`SELECT activate_blueprint(import_blueprint(${lit.json(JSON.parse(doc))}), NULL);`);
        say(`imported and activated blueprint ${code} from ${BLUEPRINT.pathname.split('/').pop()}`);
      }
    }
  });
} catch (e) {
  console.error(`migration stopped, nothing was changed: ${e instanceof Error ? e.message : e}`);
  code = 1;
} finally {
  await pool.close();
}
process.exit(code);
