// Verifies Google Play in-app purchases with the Google Play Developer API,
// using a service account, with Node's own modules only.
//
// Set up once in Google Play Console: create a service account in Google
// Cloud, grant it access to the app in Play Console (financial data and
// order management), download its JSON key, and point
// GOOGLE_SERVICE_ACCOUNT_FILE at it. See PUBLISH.md.

import { createSign } from 'node:crypto';
import type { StoreVerifier, VerifiedPurchase } from './billing.ts';

export interface GooglePlayConfig {
  packageName: string;
  clientEmail: string;
  privateKey: string;
  /** Overridable for tests. */
  tokenUri?: string;
  apiBase?: string;
  timeoutMs?: number;
}

export class GooglePlayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GooglePlayError';
  }
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Reads the fields we need from a service-account key file's JSON. */
export function serviceAccountFromJson(json: string, packageName: string): GooglePlayConfig {
  const k = JSON.parse(json) as { client_email?: string; private_key?: string; token_uri?: string; type?: string };
  if (k.type !== 'service_account' || !k.client_email || !k.private_key) throw new Error('the file is not a Google service-account key');
  return { packageName, clientEmail: k.client_email, privateKey: k.private_key, tokenUri: k.token_uri };
}

export class GooglePlayVerifier implements StoreVerifier {
  private readonly cfg: Required<GooglePlayConfig>;
  private token: { value: string; expires: number } | null = null;

  constructor(cfg: GooglePlayConfig) {
    this.cfg = {
      packageName: cfg.packageName,
      clientEmail: cfg.clientEmail,
      privateKey: cfg.privateKey,
      tokenUri: cfg.tokenUri ?? 'https://oauth2.googleapis.com/token',
      apiBase: cfg.apiBase ?? 'https://androidpublisher.googleapis.com',
      timeoutMs: cfg.timeoutMs ?? 10_000,
    };
  }

  /** OAuth access token for the Android Publisher API, from a signed JWT (RFC 7523). Cached until shortly before it expires. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const now = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64u(JSON.stringify({ iss: this.cfg.clientEmail, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: this.cfg.tokenUri, iat: now, exp: now + 3600 }));
    const signature = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(this.cfg.privateKey).toString('base64url');
    const res = await this.fetch(this.cfg.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${signature}` }).toString(),
    });
    if (!res.ok) throw new GooglePlayError(`Google sign-in failed (${res.status})`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new GooglePlayError('Google sign-in returned no token');
    this.token = { value: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(this.cfg.timeoutMs) });
    } catch (e) {
      throw new GooglePlayError(`could not reach Google: ${e instanceof Error ? e.message : e}`);
    }
  }

  private url(productId: string, token: string, action = ''): string {
    const enc = encodeURIComponent;
    return `${this.cfg.apiBase}/androidpublisher/v3/applications/${enc(this.cfg.packageName)}/purchases/products/${enc(productId)}/tokens/${enc(token)}${action}`;
  }

  private async call(url: string, method: 'GET' | 'POST'): Promise<Response> {
    const res = await this.fetch(url, { method, headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    if (res.status === 401) this.token = null;
    return res;
  }

  async verify(platform: 'apple' | 'google', productId: string, purchaseToken: string): Promise<VerifiedPurchase | null> {
    if (platform !== 'google') throw new GooglePlayError('not a Google Play purchase');
    const res = await this.call(this.url(productId, purchaseToken), 'GET');
    if (res.status === 400 || res.status === 404 || res.status === 410) return null; // unknown or expired token
    if (!res.ok) throw new GooglePlayError(`Google Play check failed (${res.status})`);
    const p = (await res.json()) as { purchaseState?: number; orderId?: string; consumptionState?: number };
    // 0 purchased, 1 canceled, 2 pending (for example cash payment not made yet).
    if (p.purchaseState !== 0) return null;
    // Test purchases from licence testers have no order id; the token is unique too.
    return { transactionId: p.orderId ?? `token:${purchaseToken.slice(0, 120)}`, productId };
  }

  async complete(platform: 'apple' | 'google', productId: string, purchaseToken: string): Promise<void> {
    if (platform !== 'google') return;
    const ack = await this.call(this.url(productId, purchaseToken, ':acknowledge'), 'POST');
    // 400 here usually means it was already acknowledged (a retry); consuming settles it either way.
    if (!ack.ok && ack.status !== 400) throw new GooglePlayError(`Google Play acknowledge failed (${ack.status})`);
    const consume = await this.call(this.url(productId, purchaseToken, ':consume'), 'POST');
    if (!consume.ok && consume.status !== 400) throw new GooglePlayError(`Google Play consume failed (${consume.status})`);
  }
}
