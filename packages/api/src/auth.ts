// Credentials and tokens, using only Node's built-in crypto.
//
// Password hashing uses scrypt. The architecture document names Argon2id;
// scrypt is the memory-hard function available without a native dependency,
// and the stored format carries its parameters so hashes can be upgraded on
// next login when Argon2id is added.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const SCRYPT = { N: 32768, r: 8, p: 1, keyLen: 64, maxmem: 128 * 1024 * 1024 };

const b64u = (buf: Buffer): string => buf.toString('base64url');

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize('NFKC'), salt, SCRYPT.keyLen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64u(salt)}$${b64u(key)}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, 'base64url');
  let actual: Buffer;
  try {
    actual = scryptSync(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT.maxmem,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Password rules: length first, plus a small deny-list of the most common choices. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string') return 'password is required';
  if (password.length < 10) return 'password must be at least 10 characters';
  if (password.length > 128) return 'password must be at most 128 characters';
  if (/^(.)\1+$/.test(password) || ['password123', '1234567890', 'qwertyuiop'].includes(password.toLowerCase())) {
    return 'password is too easy to guess';
  }
  return null;
}

/** Random opaque token (refresh, email verification, reset). Only its hash is stored. */
export function newOpaqueToken(): string {
  return b64u(randomBytes(32));
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface AccessClaims {
  sub: string;
  sid: string;
  roles: string[];
  exp: number;
  /** True when the session was opened with a second factor. */
  mfa?: boolean;
}

/** Signs a short-lived access token (JWT, HS256). */
export function signAccessToken(claims: AccessClaims, secret: string): string {
  const head = b64u(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64u(Buffer.from(JSON.stringify(claims)));
  const sig = b64u(createHmac('sha256', secret).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}

/** Returns the claims of a valid, unexpired token; null otherwise. */
export function verifyAccessToken(token: string, secret: string, nowSeconds: number): AccessClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${head}.${body}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as { alg?: string };
    if (header.alg !== 'HS256') return null;
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AccessClaims;
    if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number' || claims.exp <= nowSeconds) return null;
    return claims;
  } catch {
    return null;
  }
}

/** Opaque, signed reference to a question version, used for reporting a question. */
export function signReportToken(versionId: string, userId: string, secret: string): string {
  const body = b64u(Buffer.from(`${versionId}:${userId}`));
  return `${body}.${b64u(createHmac('sha256', secret).update(`report:${body}`).digest())}`;
}

export function readReportToken(token: string, userId: string, secret: string): string | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(`report:${body}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const [versionId, owner] = Buffer.from(body, 'base64url').toString('utf8').split(':');
  return owner === userId && versionId ? versionId : null;
}

// ------------------------------------------------------------ two-factor (TOTP, RFC 6238)

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** One-time code for a time step: HMAC-SHA1, dynamic truncation, as authenticator apps compute it. */
export function totpCode(secret: Buffer, step: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1]! & 0xf;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const totpStep = (nowMs: number): number => Math.floor(nowMs / 30_000);

/**
 * Checks a code against the current step and one step either side (clock
 * drift). Returns the matching step, or null. Steps at or before `lastStep`
 * are refused so a code cannot be replayed.
 */
export function verifyTotp(secret: Buffer, code: unknown, nowMs: number, lastStep: number): number | null {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const now = totpStep(nowMs);
  for (const step of [now - 1, now, now + 1]) {
    if (step <= lastStep) continue;
    const expected = Buffer.from(totpCode(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

/** Ten single-use recovery codes such as "k7m2-q9xd". Only their hashes are stored. */
export function newRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(5)).toLowerCase();
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
  });
}

/** Access codes such as "K7M2-Q9XD-4HTR" for trainers to hand out. Only hashes are stored. */
export function newAccessCodes(count: number): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(8)).slice(0, 12);
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  });
}

/** Case, spaces and dashes do not matter when a code is typed. */
export const normalizeAccessCode = (code: string): string => code.toUpperCase().replace(/[\s-]/g, '');

export const isRecoveryCode = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z2-7]{4}-[a-z2-7]{4}$/i.test(value.trim());

export function newTotpSecret(): Buffer {
  return randomBytes(20);
}

export function otpauthUri(secret: Buffer, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${base32Encode(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/** Key for encrypting secrets at rest, derived from the server secret. */
export function deriveKey(serverSecret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', serverSecret, 'pmp-sim', purpose, 32));
}

export function encryptSecret(plain: Buffer, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return b64u(Buffer.concat([iv, cipher.getAuthTag(), body]));
}

export function decryptSecret(sealed: string, key: Buffer): Buffer {
  const raw = Buffer.from(sealed, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
}

// ------------------------------------------------------------ signed exhibit addresses
// Images are loaded by <img> tags, which cannot send a bearer token. The API
// hands out addresses signed with the server secret that expire after a few
// hours; an address cannot be guessed or extended.

export function signExhibitUrl(exhibitId: string, expiresAtSeconds: number, key: Buffer): string {
  const sig = b64u(createHmac('sha256', key).update(`${exhibitId}.${expiresAtSeconds}`).digest());
  return `/api/v1/exhibits/${exhibitId}?exp=${expiresAtSeconds}&sig=${sig}`;
}

export function verifyExhibitUrl(exhibitId: string, exp: string | null, sig: string | null, nowSeconds: number, key: Buffer): boolean {
  if (!exp || !sig || !/^\d{1,12}$/.test(exp) || Number(exp) <= nowSeconds) return false;
  const expected = createHmac('sha256', key).update(`${exhibitId}.${exp}`).digest();
  const given = Buffer.from(sig, 'base64url');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Detects the image type from its first bytes. Only formats browsers show safely; never SVG. */
export function sniffImage(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
