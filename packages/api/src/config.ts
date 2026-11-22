// Reads the server's settings from environment variables and checks them.
// In production (NODE_ENV=production) unsafe or missing settings stop the
// server at start-up with a list of what to fix, instead of running half
// configured. Every variable is documented in deploy/.env.example.

import type { AppConfig } from './app.ts';
import { DEFAULT_APP_CONFIG } from './app.ts';
import type { SmtpConfig } from './mailer.ts';

export interface ServerSettings {
  production: boolean;
  host: string;
  port: number;
  /** Public address of the site, such as https://exam.example.com. Used in email links. */
  publicUrl: string;
  /** Product name shown in the browser, on the home screen and in emails. */
  appName: string;
  shortName: string;
  android: { packageName: string; certSha256: string[] } | null;
  /** Path of the Google service-account key that verifies Google Play purchases; null keeps them off. */
  googleServiceAccountFile: string | null;
  /** 'smtp' sends email; 'log' prints links to the console (development only). */
  mailMode: 'smtp' | 'log';
  smtp: SmtpConfig | null;
  poolMax: number;
  app: AppConfig;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Configuration problems:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export function loadSettings(env: Record<string, string | undefined>): ServerSettings {
  const problems: string[] = [];
  const production = env.NODE_ENV === 'production';
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max}`);
      return fallback;
    }
    return n;
  };

  const tokenSecret = env.TOKEN_SECRET ?? '';
  if (tokenSecret.length < 32) problems.push('TOKEN_SECRET must be at least 32 characters (for example: openssl rand -hex 32)');
  if (production && /^(change|test|secret|example)/i.test(tokenSecret)) problems.push('TOKEN_SECRET looks like a placeholder; generate a random one');

  const publicUrl = (env.PUBLIC_URL ?? (production ? '' : `http://127.0.0.1:${env.PORT ?? 8080}`)).replace(/\/+$/, '');
  if (!publicUrl) problems.push('PUBLIC_URL is required, for example https://exam.example.com');
  else if (!/^https?:\/\/[^/\s]+$/.test(publicUrl)) problems.push('PUBLIC_URL must be a scheme and host only, such as https://exam.example.com');
  else if (production && !publicUrl.startsWith('https://')) problems.push('PUBLIC_URL must use https in production');

  if (!env.PGDATABASE) problems.push('PGDATABASE is required (and PGHOST, PGUSER, PGPASSWORD as your database needs)');
  if (production && env.PGHOST && !env.PGHOST.startsWith('/') && !['127.0.0.1', 'localhost', 'db'].includes(env.PGHOST) && !['require', 'verify-full'].includes(env.PGSSLMODE ?? '')) {
    problems.push('PGSSLMODE must be require or verify-full when the database is on another host');
  }

  const mailMode = (env.MAIL_MODE ?? (production ? 'smtp' : 'log')) as ServerSettings['mailMode'];
  if (!['smtp', 'log'].includes(mailMode)) problems.push('MAIL_MODE must be smtp or log');
  if (production && mailMode === 'log') problems.push('MAIL_MODE=log prints account links to the console; use smtp in production');
  let smtp: SmtpConfig | null = null;
  if (mailMode === 'smtp') {
    const from = env.MAIL_FROM ?? '';
    if (!env.SMTP_HOST) problems.push('SMTP_HOST is required when MAIL_MODE=smtp');
    if (!/^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(from.replace(/^.*<(.+)>$/, '$1'))) problems.push('MAIL_FROM must be an address, such as "Exam Simulator <no-reply@example.com>"');
    const security = (env.SMTP_SECURITY ?? 'starttls') as SmtpConfig['security'];
    if (!['starttls', 'tls', 'none'].includes(security)) problems.push('SMTP_SECURITY must be starttls, tls or none');
    if (production && security === 'none') problems.push('SMTP_SECURITY=none sends passwords and links unencrypted; use starttls or tls');
    smtp = {
      host: env.SMTP_HOST ?? '',
      port: int('SMTP_PORT', security === 'tls' ? 465 : 587, 1, 65535),
      security,
      user: env.SMTP_USER || undefined,
      password: env.SMTP_PASSWORD || undefined,
      from,
      heloName: env.SMTP_HELO ?? 'localhost',
      timeoutMs: int('SMTP_TIMEOUT_MS', 15_000, 1000, 120_000),
      rejectUnauthorized: env.SMTP_ALLOW_INVALID_CERT !== '1',
    };
  }

  const app: AppConfig = {
    ...DEFAULT_APP_CONFIG,
    tokenSecret,
    accessTtlSeconds: int('ACCESS_TTL_SECONDS', DEFAULT_APP_CONFIG.accessTtlSeconds, 60, 3600),
    refreshTtlDays: int('REFRESH_TTL_DAYS', DEFAULT_APP_CONFIG.refreshTtlDays, 1, 90),
    authRateLimit: int('AUTH_RATE_LIMIT', DEFAULT_APP_CONFIG.authRateLimit, 1, 1000),
    freeDailyPractice: int('FREE_DAILY_PRACTICE', DEFAULT_APP_CONFIG.freeDailyPractice, 0, 1000),
    mfaIssuer: env.MFA_ISSUER ?? DEFAULT_APP_CONFIG.mfaIssuer,
    trustProxyHops: int('TRUST_PROXY_HOPS', 0, 0, 5),
    hsts: publicUrl.startsWith('https://'),
  };

  const url = (name: string): string => {
    const v = (env[name] ?? '').trim();
    if (v && !/^https:\/\/\S+$/.test(v) && !(v.startsWith('http://') && !production)) problems.push(`${name} must be an https address`);
    return v;
  };
  app.site = { termsUrl: url('TERMS_URL'), privacyUrl: url('PRIVACY_URL'), supportEmail: (env.SUPPORT_EMAIL ?? '').trim() };
  // Protected course videos (optional): Bunny Stream library and its token authentication key.
  const bunnyLib = (env.BUNNY_LIBRARY_ID ?? '').trim(), bunnyKey = (env.BUNNY_TOKEN_KEY ?? '').trim();
  if ((bunnyLib === '') !== (bunnyKey === '')) problems.push('BUNNY_LIBRARY_ID and BUNNY_TOKEN_KEY go together');
  if (bunnyLib) app.bunny = { libraryId: bunnyLib, tokenKey: bunnyKey };
  app.publicUrl = publicUrl;
  if (production && (!app.site.termsUrl || !app.site.privacyUrl)) problems.push('TERMS_URL and PRIVACY_URL are required in production: candidates must be able to read what they accept');

  const appName = (env.APP_NAME ?? 'Exam Simulator').trim();
  const shortName = (env.APP_SHORT_NAME ?? appName).trim().slice(0, 12);
  if (/\bPMI\b|\bPMP\b/i.test(appName)) problems.push('APP_NAME must not contain PMI or PMP: those are PMI trademarks and the stores reject such names without permission');
  let android: ServerSettings['android'] = null;
  if (env.ANDROID_PACKAGE) {
    const certs = (env.ANDROID_CERT_SHA256 ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(env.ANDROID_PACKAGE)) problems.push('ANDROID_PACKAGE must look like com.example.app');
    if (!certs.length || !certs.every((c) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(c))) problems.push('ANDROID_CERT_SHA256 must list SHA-256 fingerprints such as AB:CD:...');
    android = { packageName: env.ANDROID_PACKAGE, certSha256: certs };
  }
  app.mfaIssuer = env.MFA_ISSUER ?? appName;
  const googleServiceAccountFile = env.GOOGLE_SERVICE_ACCOUNT_FILE?.trim() || null;
  if (googleServiceAccountFile && !android) problems.push('GOOGLE_SERVICE_ACCOUNT_FILE needs ANDROID_PACKAGE (the app whose purchases it checks)');

  if (problems.length) throw new ConfigError(problems);
  return {
    production,
    appName,
    shortName,
    android,
    googleServiceAccountFile,
    host: env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1'),
    port: int('PORT', 8080, 1, 65535),
    publicUrl,
    mailMode,
    smtp,
    poolMax: int('PGPOOL_MAX', 10, 1, 200),
    app,
  };
}
