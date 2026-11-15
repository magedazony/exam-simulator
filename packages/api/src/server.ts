// Starts the API, the candidate app (/app) and the admin panel (/admin).
//
//   Development:  eval "$(scripts/pg-temp.sh start)"
//                 TOKEN_SECRET="$(openssl rand -hex 32)" node packages/api/src/server.ts
//   Production:   NODE_ENV=production with the variables in deploy/.env.example.
//                 Run `node scripts/migrate.ts` first. See DEPLOY.md.
//
// Logs are JSON lines on standard output (requests) and standard error
// (problems), for the host's log collector.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { MockExamService } from '../../exam-store/src/service.ts';
import { PgPool, configFromEnv } from '../../exam-store/src/pg-wire.ts';
import { ApiStore } from './api-store.ts';
import { createApp } from './app.ts';
import type { Mail } from './app.ts';
import { ConfigError, loadSettings } from './config.ts';
import { smtpMailer } from './mailer.ts';
import { buildWebFiles } from './web.ts';
import { verifierFor } from './billing.ts';
import { GooglePlayVerifier, serviceAccountFromJson } from './billing-google.ts';

let settings;
try {
  settings = loadSettings(process.env);
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
const { app: config, publicUrl } = settings;
const line = (stream: NodeJS.WriteStream, entry: Record<string, unknown>) => stream.write(JSON.stringify(entry) + '\n');
const logError = (message: string) => line(process.stderr, { at: new Date().toISOString(), level: 'error', message });

const db = new PgPool(configFromEnv(), { max: settings.poolMax });
const store = new ApiStore(db);

const mailer =
  settings.mailMode === 'smtp'
    ? smtpMailer(settings.smtp!, publicUrl, config.mfaIssuer)
    : (mail: Mail) => {
        // Development only: loadSettings refuses this mode in production.
        console.log(`[dev mail] to=${mail.to}: ${publicUrl}/app#${mail.purpose === 'verify' ? 'verify' : 'reset'}?token=${mail.token}`);
      };

let billingVerifier;
if (settings.googleServiceAccountFile) {
  try {
    const key = serviceAccountFromJson(readFileSync(settings.googleServiceAccountFile, 'utf8'), settings.android!.packageName);
    billingVerifier = verifierFor({ google: new GooglePlayVerifier(key) });
  } catch (e) {
    console.error(`GOOGLE_SERVICE_ACCOUNT_FILE could not be used: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

const app = createApp({
  billingVerifier,
  store,
  service: new MockExamService(store),
  now: () => Date.now(),
  mailer,
  config,
  log: (entry) => line(process.stdout, { level: 'info', ...entry }),
  logError,
  webFiles: buildWebFiles(new URL('../../candidate-web/', import.meta.url), {
    appName: settings.appName, shortName: settings.shortName, publicUrl, site: config.site, android: settings.android,
  }),
  adminPage: readFileSync(new URL('../../admin-web/index.html', import.meta.url), 'utf8'),
  candidatePage: readFileSync(new URL('../../candidate-web/index.html', import.meta.url), 'utf8'),
});

const server = createServer(app);
// Slow clients cannot hold connections open for ever.
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;

// Refuse to start against a database that has not been migrated.
try {
  const applied = await db.run(`SELECT count(*) FROM schema_migrations;`);
  if (Number(applied) === 0) throw new Error('no migrations recorded');
} catch (e) {
  logError(`database not ready (${e instanceof Error ? e.message : 'unknown'}); run: node scripts/migrate.ts`);
  await db.close();
  process.exit(1);
}

server.listen(settings.port, settings.host, () => {
  line(process.stdout, {
    at: new Date().toISOString(),
    level: 'info',
    message: `listening on ${settings.host}:${settings.port}`,
    mode: settings.production ? 'production' : 'development',
    publicUrl,
    mail: settings.mailMode,
  });
});

// On a stop signal, finish requests in flight, then close database connections.
const stop = (signal: string) => {
  line(process.stdout, { at: new Date().toISOString(), level: 'info', message: `${signal}: finishing open requests` });
  server.close(() => db.close().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 15_000).unref();
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
process.on('unhandledRejection', (e) => logError(`unhandled rejection: ${e instanceof Error ? e.message.slice(0, 300) : 'unknown'}`));
