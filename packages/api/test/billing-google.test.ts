// Google Play verification against a fake Google: checks the signed sign-in
// token, the purchase lookup, acknowledge and consume. No database needed.
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { GooglePlayVerifier, serviceAccountFromJson } from '../src/billing-google.ts';

describe('Google Play purchase verification', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const calls: string[] = [];
  let tokenRequests = 0;
  const purchases: Record<string, { purchaseState: number; orderId?: string }> = {
    'good-token': { purchaseState: 0, orderId: 'GPA.1234-5678' },
    'pending-token': { purchaseState: 2 },
    'tester-token': { purchaseState: 0 },
  };
  let base = '';
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/token') {
        tokenRequests++;
        const assertion = new URLSearchParams(body).get('assertion') ?? '';
        const [h, c, sig] = assertion.split('.');
        const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig ?? '', 'base64url'));
        const claims = JSON.parse(Buffer.from(c ?? '', 'base64url').toString());
        if (!ok || claims.iss !== 'play@project.iam.gserviceaccount.com' || claims.scope !== 'https://www.googleapis.com/auth/androidpublisher' || claims.aud !== `${base}/token`) {
          res.writeHead(400).end('{}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'access-1', expires_in: 3600 }));
        return;
      }
      if (req.headers.authorization !== 'Bearer access-1') { res.writeHead(401).end('{}'); return; }
      const m = /^\/androidpublisher\/v3\/applications\/com\.example\.exam\/purchases\/products\/([^/]+)\/tokens\/([^/:]+)(:\w+)?$/.exec(url.pathname);
      if (!m) { res.writeHead(404).end('{}'); return; }
      calls.push(`${req.method} ${decodeURIComponent(m[1]!)} ${decodeURIComponent(m[2]!)}${m[3] ?? ''}`);
      const p = purchases[decodeURIComponent(m[2]!)];
      if (!p) { res.writeHead(400).end('{"error":{"message":"Invalid token"}}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(m[3] ? '' : JSON.stringify({ ...p, consumptionState: 0, acknowledgementState: 0 }));
    });
  });
  let verifier: GooglePlayVerifier;
  before(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const key = serviceAccountFromJson(JSON.stringify({ type: 'service_account', client_email: 'play@project.iam.gserviceaccount.com', private_key: pem, token_uri: `${base}/token` }), 'com.example.exam');
    verifier = new GooglePlayVerifier({ ...key, apiBase: base });
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  it('signs in with the service account and confirms a completed purchase by its order id', async () => {
    assert.deepEqual(await verifier.verify('google', 'pass30', 'good-token'), { transactionId: 'GPA.1234-5678', productId: 'pass30' });
    await verifier.complete('google', 'pass30', 'good-token');
    assert.deepEqual(calls.slice(-3), ['GET pass30 good-token', 'POST pass30 good-token:acknowledge', 'POST pass30 good-token:consume']);
  });

  it('reuses the access token instead of signing in for every purchase', async () => {
    await verifier.verify('google', 'pass30', 'good-token');
    assert.equal(tokenRequests, 1);
  });

  it('refuses pending and unknown purchases, and accepts tester purchases without an order id', async () => {
    assert.equal(await verifier.verify('google', 'pass30', 'pending-token'), null);
    assert.equal(await verifier.verify('google', 'pass30', 'forged-token'), null);
    assert.deepEqual(await verifier.verify('google', 'pass90', 'tester-token'), { transactionId: 'token:tester-token', productId: 'pass90' });
  });

  it('rejects a key file that is not a service account, and a wrong private key', async () => {
    assert.throws(() => serviceAccountFromJson('{"type":"authorized_user"}', 'com.example.exam'), /not a Google service-account key/);
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const wrong = new GooglePlayVerifier({ packageName: 'com.example.exam', clientEmail: 'play@project.iam.gserviceaccount.com', privateKey: other, tokenUri: `${base}/token`, apiBase: base });
    await assert.rejects(wrong.verify('google', 'pass30', 'good-token'), /Google sign-in failed/);
  });
});
