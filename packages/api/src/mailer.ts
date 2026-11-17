// Sends account emails over SMTP, with Node's own modules only.
//
// Works with any SMTP provider (Amazon SES, Mailgun, SendGrid, Postmark,
// Microsoft 365, a company relay): STARTTLS on port 587, implicit TLS on 465,
// AUTH PLAIN or LOGIN. One connection per message, which is plenty for
// sign-up and password-reset volumes.

import { randomBytes } from 'node:crypto';
import { isIP, connect as netConnect } from 'node:net';
import type { Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { Mail } from './app.ts';

export interface SmtpConfig {
  host: string;
  port: number;
  /** 'starttls' (port 587), 'tls' (port 465) or 'none' (local relay only). */
  security: 'starttls' | 'tls' | 'none';
  user?: string;
  password?: string;
  /** Sender, such as "Exam Simulator <no-reply@example.com>". */
  from: string;
  heloName: string;
  timeoutMs: number;
  /** false only for a test server with a self-signed certificate. */
  rejectUnauthorized: boolean;
}

export interface OutgoingMessage {
  to: string;
  subject: string;
  text: string;
}

export class SmtpError extends Error {
  readonly reply: string;
  constructor(stage: string, reply: string) {
    super(`SMTP ${stage} failed: ${reply.slice(0, 200)}`);
    this.name = 'SmtpError';
    this.reply = reply;
  }
}

const address = (s: string): string => (/<([^>]+)>/.exec(s)?.[1] ?? s).trim();
/** SNI takes host names only, never IP addresses (RFC 6066). */
const sni = (host: string): string | undefined => (isIP(host) ? undefined : host);
const SAFE_ADDRESS = /^[^\s<>()",;:\\@]+@[^\s<>()",;:\\@]+\.[^\s<>()",;:\\@]+$/;

/** RFC 2047 encoded word, so Arabic subjects arrive intact. */
const encodeHeader = (s: string): string => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

export function buildMessage(from: string, msg: OutgoingMessage, now = new Date()): string {
  if (!SAFE_ADDRESS.test(address(msg.to)) || /[\r\n]/.test(msg.to) || /[\r\n]/.test(from)) throw new Error('invalid email address');
  const domain = address(from).split('@')[1] ?? 'localhost';
  const body = Buffer.from(msg.text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  return [
    `From: ${from}`,
    `To: ${address(msg.to)}`,
    `Subject: ${encodeHeader(msg.subject.replace(/[\r\n]/g, ' '))}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
    '',
    body,
  ].join('\r\n');
}

/** A minimal SMTP conversation over one socket. */
class Conversation {
  private socket: Socket;
  private buffer = '';
  private waiter: ((line: string) => void) | null = null;
  private failure: Error | null = null;

  constructor(socket: Socket) {
    this.socket = socket;
    this.attach();
  }

  private attach(): void {
    this.socket.setEncoding('utf8');
    this.socket.on('data', (d: string) => {
      this.buffer += d;
      this.flush();
    });
    this.socket.on('error', (e) => this.fail(e));
    this.socket.on('close', () => this.fail(new Error('the mail server closed the connection')));
  }

  private fail(e: Error): void {
    this.failure ??= e;
    const w = this.waiter;
    this.waiter = null;
    w?.('');
  }

  /** A complete reply: lines "250-..." continue, "250 ..." ends it. */
  private flush(): void {
    if (!this.waiter) return;
    const lines = this.buffer.split('\r\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i]!) || /^\d{3}$/.test(lines[i]!)) {
        const reply = lines.slice(0, i + 1).join('\n');
        this.buffer = lines.slice(i + 1).join('\r\n');
        const w = this.waiter;
        this.waiter = null;
        w(reply);
        return;
      }
    }
  }

  read(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      this.waiter = (line) => (this.failure ? reject(this.failure) : resolve(line));
      this.flush();
    });
  }

  async expect(stage: string, code: number, command?: string): Promise<string> {
    if (command !== undefined) this.socket.write(command + '\r\n');
    const reply = await this.read();
    if (!reply.startsWith(String(code))) throw new SmtpError(stage, reply);
    return reply;
  }

  upgrade(socket: Socket): void {
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('error');
    this.socket.removeAllListeners('close');
    this.socket = socket;
    this.buffer = '';
    this.attach();
  }

  end(): void {
    this.socket.end();
  }
}

export async function sendSmtp(cfg: SmtpConfig, msg: OutgoingMessage): Promise<void> {
  const data = buildMessage(cfg.from, msg);
  const plain: Socket = await new Promise((resolve, reject) => {
    const s = cfg.security === 'tls'
      ? tlsConnect({ host: cfg.host, port: cfg.port, servername: sni(cfg.host), rejectUnauthorized: cfg.rejectUnauthorized, minVersion: 'TLSv1.2' })
      : netConnect({ host: cfg.host, port: cfg.port });
    s.setTimeout(cfg.timeoutMs, () => s.destroy(new Error('the mail server did not answer in time')));
    s.once(cfg.security === 'tls' ? 'secureConnect' : 'connect', () => resolve(s));
    s.once('error', (e) => reject(new Error(`could not reach the mail server: ${e.message}`)));
  });
  const c = new Conversation(plain);
  try {
    await c.expect('greeting', 220);
    let ehlo = await c.expect('EHLO', 250, `EHLO ${cfg.heloName}`);
    if (cfg.security === 'starttls') {
      if (!/STARTTLS/i.test(ehlo)) throw new SmtpError('STARTTLS', 'the server does not offer STARTTLS');
      await c.expect('STARTTLS', 220, 'STARTTLS');
      const secure: Socket = await new Promise((resolve, reject) => {
        const t = tlsConnect({ socket: plain, servername: sni(cfg.host), rejectUnauthorized: cfg.rejectUnauthorized, minVersion: 'TLSv1.2' });
        t.once('secureConnect', () => resolve(t));
        t.once('error', (e) => reject(new Error(`encrypted mail connection failed: ${e.message}`)));
      });
      c.upgrade(secure);
      ehlo = await c.expect('EHLO', 250, `EHLO ${cfg.heloName}`);
    }
    if (cfg.user) {
      const pass = cfg.password ?? '';
      if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo)) {
        await c.expect('AUTH', 235, `AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${pass}`).toString('base64')}`);
      } else if (/AUTH[ =][^\n]*LOGIN/i.test(ehlo)) {
        await c.expect('AUTH', 334, 'AUTH LOGIN');
        await c.expect('AUTH', 334, Buffer.from(cfg.user).toString('base64'));
        await c.expect('AUTH', 235, Buffer.from(pass).toString('base64'));
      } else throw new SmtpError('AUTH', 'the server offers neither PLAIN nor LOGIN');
    }
    await c.expect('MAIL FROM', 250, `MAIL FROM:<${address(cfg.from)}>`);
    await c.expect('RCPT TO', 250, `RCPT TO:<${address(msg.to)}>`);
    await c.expect('DATA', 354, 'DATA');
    // Dot-stuffing: a line starting with "." gets a second one.
    await c.expect('message', 250, data.replace(/^\./gm, '..') + '\r\n.');
    await c.expect('QUIT', 221, 'QUIT').catch(() => undefined);
  } finally {
    c.end();
  }
}

/** The text of an account email, in both languages, with the person's language first. */
export function accountEmail(mail: Mail, publicUrl: string, product = 'Exam Simulator'): OutgoingMessage {
  const appUrl = `${publicUrl}/app`;
  const link = mail.purpose === 'welcome'
    ? appUrl
    : `${publicUrl}/app#${mail.purpose === 'verify' ? 'verify' : 'reset'}?token=${encodeURIComponent(mail.token)}`;

  let en: string;
  let ar: string;
  let subject: string;

  if (mail.purpose === 'welcome') {
    const name = mail.displayName ? `, ${mail.displayName}` : '';
    en = `Welcome${name}! 🎉\n\nYour ${product} account is ready. Start your PMP exam preparation now:\n\n${appUrl}\n\nTip: begin with the Diagnostic mode to see which areas need the most work.\n\nGood luck with your exam!`;
    ar = `أهلاً${name}! 🎉\n\nحسابك في ${product} جاهز. ابدأ التحضير لامتحان PMP الآن:\n\n${appUrl}\n\nنصيحة: ابدأ بـ Diagnostic Mode لتعرف المواضيع التي تحتاج تركيزاً أكثر.\n\nبالتوفيق في امتحانك!`;
    subject = mail.language === 'ar'
      ? `أهلاً بك في ${product} · Welcome to ${product}`
      : `Welcome to ${product} · أهلاً بك في ${product}`;
  } else if (mail.purpose === 'verify') {
    en = `Confirm your email address for ${product} by opening this link within 24 hours:\n\n${link}\n\nIf you did not create an account, you can ignore this email.`;
    ar = `أكّد بريدك الإلكتروني لحساب ${product} بفتح هذا الرابط خلال 24 ساعة:\n\n${link}\n\nإذا لم تنشئ حساباً، يمكنك تجاهل هذه الرسالة.`;
    subject = mail.language === 'ar'
      ? `أكّد بريدك الإلكتروني · Confirm your email`
      : `Confirm your email · أكّد بريدك الإلكتروني`;
  } else {
    en = `Someone asked to reset the password of your ${product} account. Open this link within one hour to choose a new password:\n\n${link}\n\nIf it was not you, ignore this email; your password stays the same.`;
    ar = `طلب أحدهم إعادة تعيين كلمة مرور حسابك في ${product}. افتح هذا الرابط خلال ساعة لاختيار كلمة مرور جديدة:\n\n${link}\n\nإذا لم تكن أنت، تجاهل هذه الرسالة؛ لن تتغير كلمة المرور.`;
    subject = mail.language === 'ar'
      ? `إعادة تعيين كلمة المرور · Reset your password`
      : `Reset your password · إعادة تعيين كلمة المرور`;
  }

  const notice = 'Independent study tool. Not affiliated with or endorsed by PMI. · أداة دراسة مستقلة، غير تابعة لـ PMI وغير معتمدة منه.';
  const body = mail.language === 'ar' ? `${ar}\n\n---\n\n${en}` : `${en}\n\n---\n\n${ar}`;
  return { to: mail.to, subject, text: `${body}\n\n${notice}\n` };
}

export const smtpMailer = (cfg: SmtpConfig, publicUrl: string, product?: string) => (mail: Mail) => sendSmtp(cfg, accountEmail(mail, publicUrl, product));
