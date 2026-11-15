// Creates the first administrator, or gives an existing account the role.
// The person signs in at /admin and is made to set up two-factor sign-in
// before any staff tool opens.
//
//   ADMIN_PASSWORD='a long passphrase' node scripts/create-admin.ts --email you@example.com
//   node scripts/create-admin.ts --email you@example.com      (asks for the password)
//
// Connection settings: the PG* variables.

import { createInterface } from 'node:readline';
import { PgPool, configFromEnv } from '../packages/exam-store/src/pg-wire.ts';
import { ApiStore } from '../packages/api/src/api-store.ts';
import { hashPassword, passwordProblem } from '../packages/api/src/auth.ts';
import { lit } from '../packages/exam-store/src/psql-store.ts';

const argv = process.argv.slice(2);
const email = (argv[argv.indexOf('--email') + 1] ?? '').trim().toLowerCase();
if (argv.indexOf('--email') < 0 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('usage: node scripts/create-admin.ts --email you@example.com');
  process.exit(2);
}

async function askPassword(): Promise<string> {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const out = rl as unknown as { _writeToOutput?: (s: string) => void; output: NodeJS.WriteStream };
  process.stdout.write('Password for the administrator (at least 10 characters): ');
  if (process.stdin.isTTY) out._writeToOutput = () => {}; // do not echo
  const answer = await new Promise<string>((resolve) => rl.question('', resolve));
  rl.close();
  process.stdout.write('\n');
  return answer;
}

const pool = new PgPool(configFromEnv(), { max: 1 });
const store = new ApiStore(pool);
let code = 0;
try {
  const existing = await store.userByEmail(email);
  let id: string;
  if (existing) {
    id = existing.id;
    console.log(`An account for ${email} exists; giving it the administrator role.`);
  } else {
    const password = await askPassword();
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
    id = await store.createUser(email, hashPassword(password), 'en');
    await store.markVerified(id, new Date().toISOString());
  }
  await pool.run(`INSERT INTO user_roles (user_id, role_id) SELECT ${lit.uuid(id)}, id FROM roles WHERE code = 'administrator' ON CONFLICT DO NOTHING;
                  INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, after)
                  VALUES (${lit.uuid(id)}, 'user.roles', 'user', ${lit.text(id)}, jsonb_build_object('granted', 'administrator', 'by', 'create-admin script'));`);
  console.log(`Done. Sign in at /admin as ${email}; you will be asked to set up two-factor sign-in first.`);
} catch (e) {
  console.error(`Could not create the administrator: ${e instanceof Error ? e.message : e}`);
  code = 1;
} finally {
  await pool.close();
}
process.exit(code);
