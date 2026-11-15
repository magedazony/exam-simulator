// A small PostgreSQL client and connection pool, written against the
// frontend/backend protocol version 3 with Node's own modules only.
//
// Why not a published driver: this project runs without third-party runtime
// packages. The client covers exactly what the stores need: start-up, the
// authentication methods PostgreSQL offers (trust, password, MD5 and
// SCRAM-SHA-256), TLS, and the simple query protocol returning text values.
// Every SQL string it runs is built by the stores from validated or
// dollar-quoted literals (see `lit` in psql-store.ts).

import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP, connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

/** Runs SQL and returns its rows as psql -At prints them: rows by newline, columns by '|', NULL as ''. */
export interface SqlRunner {
  run(sql: string): Promise<string>;
  close?(): Promise<void>;
}

export interface PgConfig {
  host: string;
  port: number;
  user: string;
  database: string;
  password?: string;
  /** 'disable' | 'require' (encrypt, no certificate check) | 'verify-full' (encrypt and check the certificate and host name). */
  sslmode: 'disable' | 'require' | 'verify-full';
  /** PEM bundle used with verify-full, for a private certificate authority. */
  sslRootCert?: string;
  applicationName: string;
  /** Milliseconds to wait for a connection to open and authenticate. */
  connectTimeoutMs: number;
  /** Server-side limit for one statement, in milliseconds; 0 means no limit. */
  statementTimeoutMs: number;
}

/** Settings from the standard libpq variables (PGHOST, PGPORT, PGUSER, PGDATABASE, PGPASSWORD, PGSSLMODE, PGSSLROOTCERT). */
export function configFromEnv(env: Record<string, string | undefined> = process.env): PgConfig {
  const sslmode = env.PGSSLMODE ?? 'disable';
  if (!['disable', 'require', 'verify-full'].includes(sslmode)) throw new Error(`PGSSLMODE ${sslmode} is not supported; use disable, require or verify-full`);
  return {
    host: env.PGHOST ?? '/tmp',
    port: Number(env.PGPORT ?? 5432),
    user: env.PGUSER ?? 'postgres',
    database: env.PGDATABASE ?? env.PGUSER ?? 'postgres',
    password: env.PGPASSWORD,
    sslmode: sslmode as PgConfig['sslmode'],
    // As in libpq, PGSSLROOTCERT is a file path; PEM text is accepted too.
    sslRootCert: env.PGSSLROOTCERT && !env.PGSSLROOTCERT.includes('-----BEGIN') ? readFileSync(env.PGSSLROOTCERT, 'utf8') : env.PGSSLROOTCERT,
    applicationName: env.PGAPPNAME ?? 'exam-simulator',
    connectTimeoutMs: Number(env.PGCONNECT_TIMEOUT ?? 10) * 1000,
    statementTimeoutMs: Number(env.PG_STATEMENT_TIMEOUT_MS ?? 30_000),
  };
}

/** An error reported by the server. `stderr` mirrors psql's output so callers can match either adapter the same way. */
export class PgError extends Error {
  readonly code: string;
  readonly detail?: string;
  readonly constraint?: string;
  readonly stderr: string;
  constructor(fields: Record<string, string>) {
    super(fields.M ?? 'database error');
    this.name = 'PgError';
    this.code = fields.C ?? '';
    this.detail = fields.D;
    this.constraint = fields.n;
    const severity = fields.S ?? 'ERROR';
    this.stderr = `${severity}:  ${this.message}${fields.D ? `\nDETAIL:  ${fields.D}` : ''}${fields.n ? `\nCONSTRAINT:  ${fields.n}` : ''}`;
  }
}

/** The connection broke or the server could not be reached. The pool discards the connection. */
export class PgConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PgConnectionError';
  }
}

// ------------------------------------------------------------------ framing

function message(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}
const cstr = (s: string): Buffer => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);

function startupMessage(cfg: PgConfig): Buffer {
  const params = Buffer.concat([
    cstr('user'), cstr(cfg.user),
    cstr('database'), cstr(cfg.database),
    cstr('application_name'), cstr(cfg.applicationName),
    cstr('client_encoding'), cstr('UTF8'),
    cstr('DateStyle'), cstr('ISO'),
    cstr('TimeZone'), cstr('UTC'),
    Buffer.from([0]),
  ]);
  const head = Buffer.alloc(8);
  head.writeInt32BE(params.length + 8, 0);
  head.writeInt32BE(196608, 4); // protocol 3.0
  return Buffer.concat([head, params]);
}

function parseFields(body: Buffer): Record<string, string> {
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < body.length && body[i] !== 0) {
    const code = String.fromCharCode(body[i]!);
    const end = body.indexOf(0, i + 1);
    fields[code] = body.toString('utf8', i + 1, end);
    i = end + 1;
  }
  return fields;
}

// ------------------------------------------------------------------ SCRAM-SHA-256 (RFC 5802, RFC 7677)

const hmac = (key: Buffer, data: string | Buffer): Buffer => createHmac('sha256', key).update(data).digest();
const sha256 = (data: Buffer): Buffer => createHash('sha256').update(data).digest();
const xor = (a: Buffer, b: Buffer): Buffer => Buffer.from(a.map((v, i) => v ^ b[i]!));

class Scram {
  private readonly nonce = randomBytes(18).toString('base64');
  private readonly password: string;
  private firstBare = '';
  private serverSignature: Buffer | null = null;
  constructor(password: string) {
    this.password = password;
  }
  first(): string {
    this.firstBare = `n=*,r=${this.nonce}`;
    return `n,,${this.firstBare}`;
  }
  final(serverFirst: string): string {
    const attrs = Object.fromEntries(serverFirst.split(',').map((kv) => [kv[0], kv.slice(2)]));
    const r = attrs.r ?? '', salt = attrs.s ?? '', iterations = Number(attrs.i);
    if (!r.startsWith(this.nonce) || !salt || !(iterations >= 4096)) throw new PgConnectionError('the server sent an invalid SCRAM challenge');
    const salted = pbkdf2Sync(this.password.normalize('NFKC'), Buffer.from(salt, 'base64'), iterations, 32, 'sha256');
    const clientKey = hmac(salted, 'Client Key');
    const finalBare = `c=biws,r=${r}`;
    const authMessage = `${this.firstBare},${serverFirst},${finalBare}`;
    const proof = xor(clientKey, hmac(sha256(clientKey), authMessage));
    this.serverSignature = hmac(hmac(salted, 'Server Key'), authMessage);
    return `${finalBare},p=${proof.toString('base64')}`;
  }
  verify(serverFinal: string): void {
    const v = /(?:^|,)v=([^,]+)/.exec(serverFinal)?.[1];
    const got = v ? Buffer.from(v, 'base64') : Buffer.alloc(0);
    if (!this.serverSignature || got.length !== this.serverSignature.length || !timingSafeEqual(got, this.serverSignature)) {
      throw new PgConnectionError('the server could not prove it knows the password');
    }
  }
}

// ------------------------------------------------------------------ connection

interface Pending {
  rows: string[];
  error: PgError | null;
  resolve: (text: string) => void;
  reject: (e: Error) => void;
}

export class PgConnection {
  private socket: Socket | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private pending: Pending | null = null;
  private onReady: ((e?: Error) => void) | null = null;
  private scram: Scram | null = null;
  private readonly cfg: PgConfig;
  broken = false;
  lastUsed = Date.now();

  constructor(cfg: PgConfig) {
    this.cfg = cfg;
  }

  async open(): Promise<void> {
    const cfg = this.cfg;
    let socket: Socket = await new Promise<Socket>((resolve, reject) => {
      const s = cfg.host.startsWith('/') ? netConnect({ path: `${cfg.host}/.s.PGSQL.${cfg.port}` }) : netConnect({ host: cfg.host, port: cfg.port });
      const timer = setTimeout(() => { s.destroy(); reject(new PgConnectionError(`could not connect to ${cfg.host}:${cfg.port} within ${cfg.connectTimeoutMs} ms`)); }, cfg.connectTimeoutMs);
      s.once('connect', () => { clearTimeout(timer); resolve(s); });
      s.once('error', (e) => { clearTimeout(timer); reject(new PgConnectionError(`could not connect to ${cfg.host}:${cfg.port}: ${e.message}`)); });
    });
    if (cfg.sslmode !== 'disable') socket = await this.startTls(socket);
    this.socket = socket;
    socket.on('data', (d: Buffer) => this.receive(d));
    socket.on('error', (e) => this.fail(new PgConnectionError(e.message)));
    socket.on('close', () => this.fail(new PgConnectionError('the database closed the connection')));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(new PgConnectionError('the database did not finish sign-in in time')); }, cfg.connectTimeoutMs);
      this.onReady = (e) => { clearTimeout(timer); this.onReady = null; e ? reject(e) : resolve(); };
      socket.write(startupMessage(cfg));
    });
    if (cfg.statementTimeoutMs > 0) await this.run(`SET statement_timeout = ${Math.floor(cfg.statementTimeoutMs)};`);
  }

  private startTls(plain: Socket): Promise<Socket> {
    const cfg = this.cfg;
    return new Promise((resolve, reject) => {
      const req = Buffer.alloc(8);
      req.writeInt32BE(8, 0);
      req.writeInt32BE(80877103, 4);
      plain.once('data', (d: Buffer) => {
        if (d[0] !== 0x53) { plain.destroy(); return reject(new PgConnectionError('the database does not accept encrypted connections')); }
        const verify = cfg.sslmode === 'verify-full';
        const s = tlsConnect({ socket: plain, servername: cfg.host.startsWith('/') || isIP(cfg.host) ? undefined : cfg.host, rejectUnauthorized: verify, ca: cfg.sslRootCert, minVersion: 'TLSv1.2' });
        s.once('secureConnect', () => resolve(s));
        s.once('error', (e) => reject(new PgConnectionError(`encrypted connection failed: ${e.message}`)));
      });
      plain.write(req);
    });
  }

  /** Runs one simple query (several statements allowed) and returns every row of every result. */
  run(sql: string): Promise<string> {
    if (this.broken || !this.socket) return Promise.reject(new PgConnectionError('the connection is closed'));
    if (this.pending) return Promise.reject(new Error('one query at a time per connection'));
    this.lastUsed = Date.now();
    return new Promise((resolve, reject) => {
      this.pending = { rows: [], error: null, resolve, reject };
      this.socket!.write(message('Q', cstr(sql)));
    });
  }

  close(): void {
    if (this.socket && !this.broken) this.socket.end(message('X', Buffer.alloc(0)));
    this.broken = true;
  }

  private fail(e: Error): void {
    if (this.broken) return;
    this.broken = true;
    this.socket?.destroy();
    if (this.onReady) this.onReady(e);
    if (this.pending) { const p = this.pending; this.pending = null; p.reject(e); }
  }

  private send(type: string, body: Buffer): void {
    this.socket!.write(message(type, body));
  }

  private receive(data: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) return;
      const type = String.fromCharCode(this.buf[0]!);
      const body = this.buf.subarray(5, len + 1);
      this.buf = this.buf.subarray(len + 1);
      try {
        this.handle(type, body);
      } catch (e) {
        this.fail(e instanceof Error ? e : new Error(String(e)));
        return;
      }
    }
  }

  private handle(type: string, body: Buffer): void {
    switch (type) {
      case 'R': return this.auth(body);
      case 'E': {
        const err = new PgError(parseFields(body));
        if (this.onReady) { this.fail(err); return; }
        if (this.pending) this.pending.error ??= err;
        return;
      }
      case 'D': {
        if (!this.pending) return;
        const n = body.readInt16BE(0);
        const cols: string[] = [];
        let p = 2;
        for (let i = 0; i < n; i++) {
          const l = body.readInt32BE(p);
          p += 4;
          if (l < 0) cols.push('');
          else { cols.push(body.toString('utf8', p, p + l)); p += l; }
        }
        this.pending.rows.push(cols.join('|'));
        return;
      }
      case 'Z': {
        if (this.onReady) { this.onReady(); return; }
        const p = this.pending;
        this.pending = null;
        if (!p) return;
        if (p.error) p.reject(p.error);
        else p.resolve(p.rows.join('\n').trim());
        return;
      }
      // RowDescription, CommandComplete, EmptyQuery, ParameterStatus, BackendKeyData, Notice: nothing to keep.
      case 'T': case 'C': case 'I': case 'S': case 'K': case 'N': return;
      default: return;
    }
  }

  private auth(body: Buffer): void {
    const kind = body.readInt32BE(0);
    const password = this.cfg.password;
    const need = () => { if (password === undefined) throw new PgConnectionError('the database asked for a password; set PGPASSWORD'); return password; };
    if (kind === 0) return; // AuthenticationOk
    if (kind === 3) return this.send('p', cstr(need())); // cleartext, only sensible over TLS or a local socket
    if (kind === 5) {
      const salt = body.subarray(4, 8);
      const inner = createHash('md5').update(need() + this.cfg.user).digest('hex');
      return this.send('p', cstr('md5' + createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex')));
    }
    if (kind === 10) {
      const mechanisms = body.toString('utf8', 4).split('\0');
      if (!mechanisms.includes('SCRAM-SHA-256')) throw new PgConnectionError('the database offers no supported SASL mechanism');
      this.scram = new Scram(need());
      const first = Buffer.from(this.scram.first());
      const len = Buffer.alloc(4);
      len.writeInt32BE(first.length, 0);
      return this.send('p', Buffer.concat([cstr('SCRAM-SHA-256'), len, first]));
    }
    if (kind === 11) return this.send('p', Buffer.from(this.scram!.final(body.toString('utf8', 4))));
    if (kind === 12) return this.scram!.verify(body.toString('utf8', 4));
    throw new PgConnectionError(`unsupported authentication method ${kind}`);
  }
}

// ------------------------------------------------------------------ pool

export interface PoolOptions {
  /** Most connections open at once. */
  max: number;
  /** Close connections idle for longer than this, in milliseconds. */
  idleMs: number;
  /** Fail a request that waited this long for a free connection, in milliseconds. */
  acquireTimeoutMs: number;
}

export class PgPool implements SqlRunner {
  private readonly cfg: PgConfig;
  private readonly opts: PoolOptions;
  private readonly idle: PgConnection[] = [];
  private readonly waiting: Array<{ resolve: (c: PgConnection) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private size = 0;
  private closed = false;
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(cfg: PgConfig = configFromEnv(), opts: Partial<PoolOptions> = {}) {
    this.cfg = cfg;
    this.opts = { max: 10, idleMs: 30_000, acquireTimeoutMs: 10_000, ...opts };
    this.sweeper = setInterval(() => this.sweep(), Math.max(1000, this.opts.idleMs / 2));
    this.sweeper.unref?.();
  }

  /** Connections open now, and requests waiting for one. For health checks and tests. */
  stats(): { open: number; idle: number; waiting: number } {
    return { open: this.size, idle: this.idle.length, waiting: this.waiting.length };
  }

  async run(sql: string): Promise<string> {
    const conn = await this.acquire();
    try {
      return await conn.run(sql);
    } finally {
      this.release(conn);
    }
  }

  /**
   * Runs `work` on one connection inside a transaction. The callback must
   * only use the runner it is given. Rolled back if it throws.
   */
  async transaction<T>(work: (tx: SqlRunner) => Promise<T>): Promise<T> {
    const conn = await this.acquire();
    try {
      await conn.run('BEGIN;');
      try {
        const out = await work({ run: (sql) => conn.run(sql) });
        await conn.run('COMMIT;');
        return out;
      } catch (e) {
        if (!conn.broken) await conn.run('ROLLBACK;').catch(() => conn.close());
        throw e;
      }
    } finally {
      this.release(conn);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweeper);
    for (const w of this.waiting.splice(0)) { clearTimeout(w.timer); w.reject(new PgConnectionError('the pool is closed')); }
    for (const c of this.idle.splice(0)) c.close();
  }

  private async acquire(): Promise<PgConnection> {
    if (this.closed) throw new PgConnectionError('the pool is closed');
    while (this.idle.length) {
      const c = this.idle.pop()!;
      if (!c.broken) return c;
      this.size--;
    }
    if (this.size < this.opts.max) {
      this.size++;
      const c = new PgConnection(this.cfg);
      try {
        await c.open();
        return c;
      } catch (e) {
        this.size--;
        c.close();
        throw e;
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiting.findIndex((w) => w.timer === timer);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(new PgConnectionError(`no database connection became free within ${this.opts.acquireTimeoutMs} ms`));
      }, this.opts.acquireTimeoutMs);
      this.waiting.push({ resolve, reject, timer });
    });
  }

  private release(c: PgConnection): void {
    if (c.broken || this.closed) {
      this.size--;
      c.close();
      // A waiter can now open a fresh connection.
      const w = this.waiting.shift();
      if (w) { clearTimeout(w.timer); this.acquire().then(w.resolve, w.reject); }
      return;
    }
    const w = this.waiting.shift();
    if (w) { clearTimeout(w.timer); w.resolve(c); return; }
    this.idle.push(c);
  }

  private sweep(): void {
    const cutoff = Date.now() - this.opts.idleMs;
    for (let i = this.idle.length - 1; i >= 0; i--) {
      const c = this.idle[i]!;
      if (c.lastUsed < cutoff || c.broken) {
        this.idle.splice(i, 1);
        this.size--;
        c.close();
      }
    }
  }
}
