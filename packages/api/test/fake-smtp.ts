// A small SMTP server for tests: speaks enough of the protocol for the
// mailer (EHLO, STARTTLS, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA, QUIT) and keeps
// every message it receives. Uses a throwaway self-signed certificate.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TLSSocket, createSecureContext } from 'node:tls';

export interface Received {
  from: string;
  to: string;
  data: string;
  auth: string | null;
  encrypted: boolean;
  /** The decoded text body. */
  text: string;
  subject: string;
}

export interface FakeSmtp {
  port: number;
  messages: Received[];
  close(): Promise<void>;
}

export async function startFakeSmtp(opts: { user?: string; password?: string; offerStartTls?: boolean; authMethod?: 'PLAIN' | 'LOGIN' } = {}): Promise<FakeSmtp> {
  const dir = mkdtempSync(join(tmpdir(), 'fake-smtp-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' });
  const context = createSecureContext({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) });
  const messages: Received[] = [];
  const offerStartTls = opts.offerStartTls ?? true;
  const method = opts.authMethod ?? 'PLAIN';

  const session = (raw: Socket) => {
    let sock: Socket = raw;
    let encrypted = false;
    let buf = '';
    let inData = false;
    let pendingLogin: 'user' | 'pass' | null = null;
    let loginUser = '';
    let auth: string | null = null;
    let from = '', to = '';
    const say = (line: string) => sock.write(line + '\r\n');
    const onLine = (line: string) => {
      if (inData) return;
      if (pendingLogin === 'user') { loginUser = Buffer.from(line, 'base64').toString(); pendingLogin = 'pass'; return say('334 UGFzc3dvcmQ6'); }
      if (pendingLogin === 'pass') {
        pendingLogin = null;
        const ok = loginUser === opts.user && Buffer.from(line, 'base64').toString() === opts.password;
        if (ok) auth = loginUser;
        return say(ok ? '235 ok' : '535 bad credentials');
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO') return say(`250-fake\r\n${offerStartTls && !encrypted ? '250-STARTTLS\r\n' : ''}250-AUTH ${method}\r\n250 8BITMIME`);
      if (line.toUpperCase() === 'STARTTLS') {
        say('220 go ahead');
        sock.removeAllListeners('data');
        const t = new TLSSocket(sock, { isServer: true, secureContext: context });
        sock = t;
        encrypted = true;
        buf = '';
        t.on('data', onData);
        return;
      }
      if (line.toUpperCase().startsWith('AUTH PLAIN ')) {
        const [, u, p] = Buffer.from(line.slice(11), 'base64').toString().split('\0');
        const ok = u === opts.user && p === opts.password;
        if (ok) auth = u!;
        return say(ok ? '235 ok' : '535 bad credentials');
      }
      if (line.toUpperCase() === 'AUTH LOGIN') { pendingLogin = 'user'; return say('334 VXNlcm5hbWU6'); }
      if (cmd === 'MAIL') { if (opts.user && !auth) return say('530 auth required'); from = /<(.*)>/.exec(line)?.[1] ?? ''; return say('250 ok'); }
      if (cmd === 'RCPT') { to = /<(.*)>/.exec(line)?.[1] ?? ''; return say('250 ok'); }
      if (cmd === 'DATA') { inData = true; return say('354 send'); }
      if (cmd === 'QUIT') { say('221 bye'); sock.end(); return; }
      say('502 not implemented');
    };
    const onData = (d: Buffer) => {
      buf += d.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const data = buf.slice(0, end).replace(/^\.\./gm, '.');
          buf = buf.slice(end + 5);
          inData = false;
          const [head, ...rest] = data.split('\r\n\r\n');
          const text = Buffer.from(rest.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8').replace(/\r\n/g, '\n');
          const rawSubject = /^Subject: (.*)$/m.exec(head ?? '')?.[1] ?? '';
          const subject = rawSubject.replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, b: string) => Buffer.from(b, 'base64').toString('utf8'));
          messages.push({ from, to, data, auth, encrypted, text, subject });
          say('250 queued');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(line);
      }
    };
    sock.on('data', onData);
    sock.on('error', () => {});
    say('220 fake smtp ready');
  };

  const server: Server = createServer(session);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { port, messages, close: () => new Promise((r) => server.close(() => r())) };
}
