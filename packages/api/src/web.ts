// Files that make the candidate app a publishable, installable web app:
// the landing page, the web app manifest, the service worker, icons,
// robots.txt and the Digital Asset Links file the Android app needs.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

export interface WebFile {
  contentType: string;
  bytes: Buffer;
  cacheControl: string;
}

export interface WebSettings {
  appName: string;
  shortName: string;
  publicUrl: string;
  site: { termsUrl: string; privacyUrl: string; supportEmail: string };
  /** Android package name and SHA-256 fingerprints of its signing certificates, for /.well-known/assetlinks.json. */
  android: { packageName: string; certSha256: string[] } | null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const TYPES: Record<string, string> = { png: 'image/png', svg: 'image/svg+xml' };

/** Builds every public web file once, at start-up. Paths are fixed: nothing is read from the request. */
export function buildWebFiles(dir: URL, s: WebSettings): Map<string, WebFile> {
  const files = new Map<string, WebFile>();
  const page = readFileSync(new URL('index.html', dir), 'utf8');
  const version = createHash('sha256').update(page).digest('hex').slice(0, 12);

  for (const name of readdirSync(new URL('assets/', dir))) {
    const ext = name.split('.').pop() ?? '';
    if (!TYPES[ext] || !/^[a-z0-9-]+\.[a-z]+$/.test(name)) continue;
    files.set(`/assets/${name}`, { contentType: TYPES[ext]!, bytes: readFileSync(new URL(`assets/${name}`, dir)), cacheControl: 'public, max-age=604800' });
  }

  const manifest = {
    id: '/app',
    name: s.appName,
    short_name: s.shortName,
    description: 'PMP exam practice and full mock exams, in Arabic and English.',
    start_url: '/app',
    scope: '/app',
    display: 'standalone',
    orientation: 'any',
    background_color: '#f4f6f9',
    theme_color: '#1b4a78',
    lang: 'ar',
    dir: 'auto',
    categories: ['education'],
    icons: [
      { src: '/assets/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/assets/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/assets/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  files.set('/app/manifest.webmanifest', { contentType: 'application/manifest+json; charset=utf-8', bytes: Buffer.from(JSON.stringify(manifest, null, 2)), cacheControl: 'no-cache' });

  const sw = readFileSync(new URL('sw.js', dir), 'utf8').replace('__VERSION__', version);
  files.set('/sw.js', { contentType: 'text/javascript; charset=utf-8', bytes: Buffer.from(sw), cacheControl: 'no-cache' });

  const link = (href: string, en: string) => (href ? `<a href="${esc(href)}" rel="noopener">${en}</a>` : '');
  const landing = readFileSync(new URL('landing.html', dir), 'utf8')
    .replaceAll('{{APP_NAME}}', esc(s.appName))
    .replaceAll('{{PUBLIC_URL}}', esc(s.publicUrl))
    .replaceAll('{{YEAR}}', String(new Date().getUTCFullYear()))
    .replace('{{TERMS_LINK}}', link(s.site.termsUrl, 'Terms of use · شروط الاستخدام'))
    .replace('{{PRIVACY_LINK}}', link(s.site.privacyUrl, 'Privacy · الخصوصية'))
    .replace('{{SUPPORT_LINK}}', s.site.supportEmail ? link(`mailto:${s.site.supportEmail}`, esc(s.site.supportEmail)) : '');
  files.set('/', { contentType: 'text/html; charset=utf-8', bytes: Buffer.from(landing), cacheControl: 'public, max-age=300' });

  files.set('/robots.txt', {
    contentType: 'text/plain; charset=utf-8',
    bytes: Buffer.from(`User-agent: *\nAllow: /$\nAllow: /app\nDisallow: /admin\nDisallow: /api/\n`),
    cacheControl: 'public, max-age=86400',
  });
  files.set('/favicon.ico', files.get('/assets/favicon-32.png')!);

  if (s.android) {
    const links = [{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: s.android.packageName, sha256_cert_fingerprints: s.android.certSha256 },
    }];
    files.set('/.well-known/assetlinks.json', { contentType: 'application/json', bytes: Buffer.from(JSON.stringify(links, null, 2)), cacheControl: 'public, max-age=3600' });
  }
  return files;
}
