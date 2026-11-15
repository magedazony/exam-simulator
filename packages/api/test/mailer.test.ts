// Tests of SMTP sending against a fake server. No database needed.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { accountEmail, buildMessage, sendSmtp } from '../src/mailer.ts';
import type { SmtpConfig } from '../src/mailer.ts';
import { startFakeSmtp } from './fake-smtp.ts';
import type { FakeSmtp } from './fake-smtp.ts';

describe('email over SMTP', () => {
  let server: FakeSmtp;
  before(async () => { server = await startFakeSmtp({ user: 'mailer', password: 'p@ss wörd' }); });
  after(() => server.close());
  const cfg = (over: Partial<SmtpConfig> = {}): SmtpConfig => ({
    host: '127.0.0.1', port: server.port, security: 'starttls', user: 'mailer', password: 'p@ss wörd',
    from: 'Exam Simulator <no-reply@example.test>', heloName: 'test', timeoutMs: 5000, rejectUnauthorized: false, ...over,
  });

  it('sends over STARTTLS with AUTH PLAIN, in UTF-8, with the link intact', async () => {
    const mail = accountEmail({ to: 'nour@example.test', purpose: 'verify', token: 'tok+/=123', language: 'ar' }, 'https://exam.example.test');
    await sendSmtp(cfg(), mail);
    const got = server.messages.at(-1)!;
    assert.equal(got.encrypted, true);
    assert.equal(got.auth, 'mailer');
    assert.equal(got.from, 'no-reply@example.test');
    assert.equal(got.to, 'nour@example.test');
    assert.match(got.subject, /^أكّد بريدك الإلكتروني/);
    assert.ok(got.text.indexOf('أكّد بريدك') < got.text.indexOf('Confirm your email'), 'Arabic first for an Arabic user');
    assert.ok(got.text.includes('https://exam.example.test/app#verify?token=tok%2B%2F%3D123'));
    assert.match(got.text, /Not affiliated with or endorsed by PMI/);
  });

  it('refuses to send when the server cannot encrypt, or the certificate cannot be verified', async () => {
    const noTls = await startFakeSmtp({ offerStartTls: false });
    await assert.rejects(sendSmtp(cfg({ port: noTls.port, user: undefined }), { to: 'a@example.test', subject: 's', text: 't' }), /does not offer STARTTLS/);
    await noTls.close();
    await assert.rejects(sendSmtp(cfg({ rejectUnauthorized: true }), { to: 'a@example.test', subject: 's', text: 't' }), /encrypted mail connection failed/);
  });

  it('reports wrong credentials and an unreachable server', async () => {
    await assert.rejects(sendSmtp(cfg({ password: 'wrong' }), { to: 'a@example.test', subject: 's', text: 't' }), /AUTH failed: 535/);
    await assert.rejects(sendSmtp(cfg({ port: 1 }), { to: 'a@example.test', subject: 's', text: 't' }), /could not reach the mail server/);
  });

  it('supports AUTH LOGIN, and keeps a body line that starts with a dot', async () => {
    const login = await startFakeSmtp({ user: 'u', password: 'p', authMethod: 'LOGIN' });
    await sendSmtp(cfg({ port: login.port, user: 'u', password: 'p' }), { to: 'b@example.test', subject: 'Hi', text: 'line one\n.dot line\nend' });
    assert.equal(login.messages[0]!.text, 'line one\n.dot line\nend');
    await login.close();
  });

  it('rejects addresses that could inject headers', () => {
    assert.throws(() => buildMessage('x <a@example.test>', { to: 'a@example.test\r\nBcc: z@evil.test', subject: 's', text: 't' }), /invalid email address/);
    assert.throws(() => buildMessage('x <a@example.test>', { to: 'not an address', subject: 's', text: 't' }), /invalid email address/);
    assert.doesNotMatch(buildMessage('x <a@example.test>', { to: 'a@example.test', subject: 'a\r\nBcc: z@evil.test', text: 't' }), /\r\nBcc:/);
  });
});
