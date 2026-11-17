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
    bytes: Buffer.from(`User-agent: *\nAllow: /$\nAllow: /app\nAllow: /terms\nAllow: /privacy\nDisallow: /admin\nDisallow: /api/\n`),
    cacheControl: 'public, max-age=86400',
  });
  files.set('/favicon.ico', files.get('/assets/favicon-32.png')!);

  // ── Legal pages (Terms & Privacy) ──────────────────────────────────────────
  const year = String(new Date().getUTCFullYear());
  const legalCss = `
:root{--bg:#f4f6f9;--surface:#fff;--text:#121a26;--muted:#505c6c;--primary:#1b4a78;--border:#d5dbe3;color-scheme:light dark}
@media(prefers-color-scheme:dark){:root{--bg:#0e1319;--surface:#18202a;--text:#eef1f5;--muted:#a3afbd;--primary:#86b8ea;--border:#2c3846}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.7 "IBM Plex Sans","Segoe UI",system-ui,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:24px 20px 60px}
.top-bar{display:flex;align-items:center;gap:12px;margin-bottom:36px;padding-bottom:16px;border-bottom:1px solid var(--border)}
.top-bar a{text-decoration:none;color:var(--primary);font-weight:600;font-size:15px}
.top-bar span{color:var(--muted);font-size:13px;margin-right:auto}
h1{font-size:clamp(22px,4vw,32px);margin:0 0 4px;color:var(--primary)}
h2{font-size:1.1rem;margin:28px 0 8px;color:var(--text)}
.ar{direction:rtl;font-size:.93em;color:var(--muted);margin:4px 0 16px;line-height:1.6}
p,li{margin:0 0 10px}
ul{padding-right:20px;padding-left:20px}
footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--border);font-size:13px;color:var(--muted)}
a{color:var(--primary)}`.trim();

  const termsHtml = `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Terms of Use · ${esc(s.appName)}</title>
<meta name="robots" content="noindex">
<style>${legalCss}</style>
</head>
<body>
<div class="wrap">
<div class="top-bar">
  <a href="/">← ${esc(s.appName)}</a>
  <span>Last updated ${year}</span>
</div>

<h1>Terms of Use</h1>
<p class="ar">شروط الاستخدام — آخر تحديث ${year}</p>

<h2>1. Independent Study Tool</h2>
<p>${esc(s.appName)} is an independent exam-preparation platform. It is <strong>not affiliated with, endorsed by, or associated with PMI®</strong> (Project Management Institute) or any certification body. "PMP®" is a registered trademark of PMI.</p>
<p class="ar">هذا التطبيق أداة استذكار مستقلة وغير تابعة لمعهد إدارة المشاريع PMI® أو أي جهة اعتماد. العلامات التجارية المذكورة ملك أصحابها.</p>

<h2>2. Eligibility</h2>
<p>You must be at least 16 years old to create an account. By registering, you confirm that the information you provide is accurate.</p>
<p class="ar">يجب أن يكون عمرك 16 عامًا على الأقل لإنشاء حساب. بالتسجيل، تؤكد أن المعلومات المقدمة صحيحة.</p>

<h2>3. Account Security</h2>
<p>You are responsible for keeping your credentials confidential. Notify us immediately at <a href="mailto:${esc(s.site.supportEmail || 'support@example.com')}">${esc(s.site.supportEmail || 'support@example.com')}</a> if you suspect unauthorized access.</p>
<p class="ar">أنت مسؤول عن سرية بيانات حسابك. أبلغنا فورًا عند أي وصول غير مصرح به.</p>

<h2>4. Permitted Use</h2>
<p>You may use this platform for personal, non-commercial exam preparation. You may not:</p>
<ul>
  <li>Share, resell, or redistribute questions, answers, or explanations.</li>
  <li>Use automated tools to scrape or extract content.</li>
  <li>Attempt to reverse-engineer or circumvent any part of the platform.</li>
</ul>
<p class="ar">يُتاح استخدام المنصة للتحضير الشخصي غير التجاري للاختبار. يُحظر مشاركة الأسئلة أو إعادة توزيعها أو استخراجها بأدوات آلية.</p>

<h2>5. Content Accuracy</h2>
<p>Questions and explanations are created to reflect the current PMI Examination Content Outline (ECO) and reflect general project-management knowledge. They do not constitute guaranteed exam questions. We update content regularly but cannot guarantee it reflects the latest exam format at any given moment.</p>
<p class="ar">الأسئلة والشروحات تعكس المعرفة العامة لإدارة المشاريع وفق ECO الحالية. لا تُمثل أسئلة الامتحان الفعلية بالضرورة، ونحرص على تحديثها باستمرار.</p>

<h2>6. Subscriptions and Payments</h2>
<p>Paid plans are billed in advance. Prices are displayed in the app before purchase. Refund eligibility follows our refund policy, available on request.</p>
<p class="ar">تُدفع الاشتراكات مقدمًا. الأسعار معروضة في التطبيق قبل الشراء. سياسة الاسترداد متاحة عند الطلب.</p>

<h2>7. Termination</h2>
<p>We may suspend or terminate accounts that violate these terms. You may delete your account at any time from account settings.</p>
<p class="ar">يحق لنا تعليق أو إنهاء الحسابات التي تنتهك هذه الشروط. يمكنك حذف حسابك في أي وقت من الإعدادات.</p>

<h2>8. Limitation of Liability</h2>
<p>To the maximum extent permitted by law, ${esc(s.appName)} and its operators are not liable for indirect, incidental, or consequential damages arising from use of the platform.</p>
<p class="ar">بالقدر المسموح به قانونًا، لا يتحمل مشغلو المنصة المسؤولية عن الأضرار غير المباشرة أو التبعية الناجمة عن استخدامها.</p>

<h2>9. Changes to Terms</h2>
<p>We may update these terms. Continued use after changes constitutes acceptance. We will notify registered users of material changes by email.</p>
<p class="ar">قد نُحدّث هذه الشروط. استمرار الاستخدام بعد التغييرات يُعدّ قبولًا لها. سنُخطر المستخدمين المسجلين بالتغييرات الجوهرية عبر البريد الإلكتروني.</p>

<h2>10. Governing Law</h2>
<p>These terms are governed by the laws of the Arab Republic of Egypt. Disputes shall be resolved in the competent courts of Egypt.</p>
<p class="ar">تخضع هذه الشروط لقوانين جمهورية مصر العربية، وتُحسم النزاعات أمام المحاكم المختصة في مصر.</p>

<footer>
  <p>© ${year} ${esc(s.appName)} · <a href="/privacy">Privacy Policy · سياسة الخصوصية</a>
  ${s.site.supportEmail ? ` · <a href="mailto:${esc(s.site.supportEmail)}">${esc(s.site.supportEmail)}</a>` : ''}</p>
  <p>PMI® and PMP® are registered trademarks of Project Management Institute, Inc. This platform is not affiliated with PMI.</p>
</footer>
</div>
</body>
</html>`;

  const privacyHtml = `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy Policy · ${esc(s.appName)}</title>
<meta name="robots" content="noindex">
<style>${legalCss}</style>
</head>
<body>
<div class="wrap">
<div class="top-bar">
  <a href="/">← ${esc(s.appName)}</a>
  <span>Last updated ${year}</span>
</div>

<h1>Privacy Policy</h1>
<p class="ar">سياسة الخصوصية — آخر تحديث ${year}</p>

<h2>1. Who We Are</h2>
<p>${esc(s.appName)} is an independent PMP exam-preparation platform. For privacy inquiries contact: <a href="mailto:${esc(s.site.supportEmail || 'support@example.com')}">${esc(s.site.supportEmail || 'support@example.com')}</a></p>
<p class="ar">${esc(s.appName)} منصة تحضير مستقلة لامتحان PMP. لاستفسارات الخصوصية تواصل معنا عبر البريد المذكور أعلاه.</p>

<h2>2. Data We Collect</h2>
<p>We collect only what is needed to provide the service:</p>
<ul>
  <li><strong>Account data:</strong> email address, display name, preferred language.</li>
  <li><strong>Usage data:</strong> questions answered, scores, session timestamps, spaced-repetition state, streaks.</li>
  <li><strong>Payment data:</strong> subscription status and coupon use. Card details are handled by our payment processor; we never store card numbers.</li>
  <li><strong>Technical data:</strong> device type, OS, browser, IP address (for security and analytics).</li>
</ul>
<p class="ar">نجمع فقط ما يلزم لتقديم الخدمة: بيانات الحساب، بيانات الاستخدام (الأسئلة والنتائج)، حالة الاشتراك، والبيانات التقنية (النوع، IP للأمان). لا نخزن بيانات بطاقات الدفع.</p>

<h2>3. How We Use Your Data</h2>
<ul>
  <li>To provide and improve the exam-preparation service.</li>
  <li>To personalise your learning path using spaced repetition and adaptive difficulty.</li>
  <li>To send transactional emails (email verification, password reset, subscription receipts).</li>
  <li>To detect and prevent fraud and abuse.</li>
</ul>
<p class="ar">نستخدم بياناتك لتقديم الخدمة وتحسينها، وتخصيص مسار التعلم، وإرسال رسائل المعاملات (التحقق، إعادة كلمة المرور)، ومكافحة الاحتيال.</p>

<h2>4. Data Sharing</h2>
<p>We do not sell your personal data. We share data only with:</p>
<ul>
  <li><strong>Payment processors</strong> to handle subscription billing.</li>
  <li><strong>Email delivery providers</strong> to send transactional emails.</li>
  <li><strong>Hosting providers</strong> who store data on our behalf under data-processing agreements.</li>
</ul>
<p>All third parties are bound by data-processing agreements and may not use your data for their own purposes.</p>
<p class="ar">لا نبيع بياناتك. نشاركها فقط مع معالجي الدفع، ومزودي البريد الإلكتروني، والاستضافة — وجميعهم ملتزمون باتفاقيات معالجة البيانات.</p>

<h2>5. Data Retention</h2>
<p>We retain your account and learning data for as long as your account is active. If you delete your account, we delete your personal data within 30 days, except where required by law or for fraud prevention.</p>
<p class="ar">نحتفظ ببياناتك طوال فترة نشاط حسابك. عند الحذف، تُحذف بياناتك خلال 30 يومًا ما لم يقتضِ القانون خلاف ذلك.</p>

<h2>6. Your Rights</h2>
<p>Depending on your jurisdiction you may have the right to:</p>
<ul>
  <li>Access the personal data we hold about you.</li>
  <li>Request correction of inaccurate data.</li>
  <li>Request deletion of your data ("right to be forgotten").</li>
  <li>Object to or restrict certain processing.</li>
  <li>Data portability.</li>
</ul>
<p>To exercise these rights, email <a href="mailto:${esc(s.site.supportEmail || 'support@example.com')}">${esc(s.site.supportEmail || 'support@example.com')}</a>. We will respond within 30 days.</p>
<p class="ar">يحق لك — حسب نطاقك القانوني — الوصول لبياناتك أو تصحيحها أو حذفها أو نقلها. أرسل طلبك عبر البريد الإلكتروني وسنرد خلال 30 يومًا.</p>

<h2>7. Cookies and Local Storage</h2>
<p>We use browser local storage to maintain your session and store app preferences (language, theme). We do not use third-party tracking cookies.</p>
<p class="ar">نستخدم التخزين المحلي للمتصفح للحفاظ على جلستك وتفضيلاتك. لا نستخدم كوكيز تتبع من طرف ثالث.</p>

<h2>8. Security</h2>
<p>Passwords are stored as salted hashes (bcrypt). Data in transit is encrypted via TLS. We follow industry-standard security practices and promptly address vulnerabilities.</p>
<p class="ar">تُخزَّن كلمات المرور كـ hashes مشفرة (bcrypt). البيانات المنقولة مشفرة بـ TLS. نتبع أفضل ممارسات الأمان الصناعية.</p>

<h2>9. Children's Privacy</h2>
<p>Our service is not directed at children under 16. We do not knowingly collect data from children. If you believe we have collected data from a child, contact us and we will delete it promptly.</p>
<p class="ar">الخدمة غير موجهة لمن هم دون 16 عامًا. إذا علمت بجمع بيانات طفل، تواصل معنا وسنحذفها فورًا.</p>

<h2>10. Changes to This Policy</h2>
<p>We may update this policy. We will notify registered users by email of material changes. The "Last updated" date at the top reflects the latest revision.</p>
<p class="ar">قد نُحدّث هذه السياسة ونُخطر المستخدمين المسجلين بالتغييرات الجوهرية عبر البريد الإلكتروني.</p>

<footer>
  <p>© ${year} ${esc(s.appName)} · <a href="/terms">Terms of Use · شروط الاستخدام</a>
  ${s.site.supportEmail ? ` · <a href="mailto:${esc(s.site.supportEmail)}">${esc(s.site.supportEmail)}</a>` : ''}</p>
  <p>PMI® and PMP® are registered trademarks of Project Management Institute, Inc. This platform is not affiliated with PMI.</p>
</footer>
</div>
</body>
</html>`;

  files.set('/terms', { contentType: 'text/html; charset=utf-8', bytes: Buffer.from(termsHtml), cacheControl: 'public, max-age=3600' });
  files.set('/privacy', { contentType: 'text/html; charset=utf-8', bytes: Buffer.from(privacyHtml), cacheControl: 'public, max-age=3600' });

  if (s.android) {
    const links = [{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: s.android.packageName, sha256_cert_fingerprints: s.android.certSha256 },
    }];
    files.set('/.well-known/assetlinks.json', { contentType: 'application/json', bytes: Buffer.from(JSON.stringify(links, null, 2)), cacheControl: 'public, max-age=3600' });
  }
  return files;
}
