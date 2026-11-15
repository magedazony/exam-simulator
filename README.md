# PMP Exam Simulator: Increments 1 to 16

**To deploy for real users, follow [DEPLOY.md](DEPLOY.md). To publish the web app and the Android app, follow [PUBLISH.md](PUBLISH.md).**

Independent exam-preparation software. Not affiliated with or endorsed by the
Project Management Institute. PMP is a registered mark of the Project
Management Institute, Inc.

These increments contain the core of the Exams module: the rules that build,
run and score an exam, the database that stores it, the service that joins
the two, the API contract, a working HTTP server for candidates and for staff
(authoring, review, import, blueprint versions, two-factor sign-in), and a
working admin panel and a working candidate web app, both tested in a real
browser. There is still no native mobile app and no real question content.

## See it running on your computer

Needs Node.js 22.18+ and a local PostgreSQL 16. One command, on Windows,
macOS or Linux:

```
# set PGUSER / PGPASSWORD (and PGHOST, PGPORT if not 127.0.0.1:5432) first
node scripts/demo.ts
```

It creates a database `exam_demo`, loads a synthetic demo question bank
(sample text, not exam content), creates a student with a pass and an
administrator, prints their sign-in details, and starts the site at
http://127.0.0.1:8080. `node scripts/demo.ts --reset` starts again from
nothing. Demo only: never point it at a production database.

## Put a free trial site online

[FREE-HOSTING.md](FREE-HOSTING.md): a free Neon database and a free Render
web service, deployed from `render.yaml`. For showing and trying only.

## Contents

| Path | What it is | Increment |
| --- | --- | --- |
| `packages/exam-engine/src/` (generator, validator, scoring, sanitize, blueprint) | Blueprint validation, mock-exam generation, independent exam validation, scoring, candidate-safe question view | 1 |
| `packages/exam-engine/src/session.ts` | Exam session rules: server-side timer, sections, breaks, locking, idempotent answer saving, expiry, submission | 2 |
| `packages/exam-engine/data/blueprint-2026-07.json` | The July 2026 outline as data: 3 domains, 26 tasks, weights 33 / 41 / 26, 180 questions, 240 minutes | 1 |
| `db/migrations/001_core.sql` | Core schema: identity, blueprint, content, review, exams, audit (27 tables) | 1 |
| `db/migrations/002_engine_access.sql` | Blueprint import and activation, gated publishing, the JSON the engine reads, attempt storage with optimistic concurrency | 3 |
| `packages/exam-store/src/service.ts` | Mock-exam service: start, status, questions, save answer, flag, review, close section, resume, submit, result | 3 |
| `packages/exam-store/src/ports.ts` | Storage interface the service depends on | 3 |
| `packages/exam-store/src/psql-store.ts` | PostgreSQL store; every call goes through a `SqlRunner` (the pool in production, `psql` in tests) | 3, 11 |
| `packages/exam-store/src/pg-wire.ts` | PostgreSQL client and connection pool on Node's own modules: protocol v3, SCRAM-SHA-256 / MD5 / password sign-in, TLS with certificate checking, statement time limit, transactions | 11 |
| `packages/api/src/config.ts` | Reads and checks every production setting; refuses to start when one is unsafe | 12 |
| `packages/api/src/mailer.ts` | Account emails over SMTP (STARTTLS or TLS, AUTH PLAIN or LOGIN), bilingual | 12 |
| `scripts/migrate.ts`, `scripts/create-admin.ts` | Database migrations with checksums and a lock; first administrator | 12 |
| `scripts/backup.sh`, `scripts/restore.sh` | Daily compressed backups with retention; restore into an empty database only | 12 |
| `Dockerfile`, `deploy/` | Container image, Docker Compose (PostgreSQL, migration, app, Caddy HTTPS, backups), settings template, systemd units | 12 |
| `db/migrations/008_ops.sql` | Shared rate limits (hashed keys), personal data export, audit trail page | 13 |
| `packages/api/src/messages-ar.ts` | Arabic for every error title and field message the API sends | 13 |
| `packages/candidate-web/assets/`, `sw.js`, `landing.html`; `packages/api/src/web.ts` | Installable web app: icons, manifest, service worker, landing page, robots.txt, Digital Asset Links | 14 |
| `packages/api/src/billing-google.ts` | Google Play purchase verification with a service account (sign-in, check, acknowledge, consume) | 14 |
| `android/` | Android app for Google Play (Trusted Web Activity, API 36, Google Play Billing); not built here | 14 |
| `store/` | Store listing texts (Arabic and English), data safety and rating answers, real screenshots, feature graphic; `scripts/store-screenshots.ts` remakes the images | 14 |
| `content/starter-drafts.xlsx` (`content/starter_drafts.py`) | 52 original draft questions, two per task, marked as drafted with AI help, for the content team to review and import | 15 |
| `content/starter-drafts-2.xlsx` (`content/starter_drafts_2.py`) | Second batch: 52 more standalone drafts and 6 case studies with 3 questions each, all marked as drafted with AI help | 16 |
| `PUBLISH.md` | Publishing guide: web, Google Play, iPhone and iPad | 14 |
| `DEPLOY.md` | Deployment runbook, security and go-live checklists | 12 |
| `scripts/load-check.ts` | Rough load check: many candidates loading dashboards and practice questions at once | 11 |
| `db/seed/synthetic_bank.sql` | Test data only: 1,380 synthetic items pushed through the real review gates | 3 |
| `scripts/pg-temp.sh` | Starts and stops a throwaway PostgreSQL with migrations, blueprint and test bank | 3 |
| `api/openapi.yaml`, `api/check_contract.py` | OpenAPI 3.1 contract (29 paths, 33 operations) and its build gate | 2 |
| `db/migrations/003_api.sql` | Accounts tokens, refresh-token families, practice mode, explanations, review, analytics, dashboard, question reports | 4 |
| `packages/api/src/app.ts` | HTTP layer for the candidate-facing contract: auth, profile, practice, mock exam, results, analytics, reports | 4 |
| `packages/api/src/auth.ts` | Password hashing (scrypt), access tokens (HS256), opaque refresh and email tokens | 4 |
| `packages/api/src/server.ts` | Starts the API locally (development mode) | 4 |
| `db/migrations/004_staff_tools.sql` | Staff two-factor columns, authoring and versioning, the review workflow as one guarded function, import support, report triage, blueprint versions matched by task code | 5 |
| `packages/api/src/admin.ts` | Staff endpoints: questions, drafts, versions, transitions, import, blueprints, reports | 5 |
| `packages/api/src/http.ts` | Shared HTTP errors and types | 5 |
| `db/migrations/005_cases_recovery.sql` | Case-study authoring and publishing, two-factor recovery codes, blueprint list | 6 |
| `packages/admin-web/index.html` | Admin panel: sign-in and two-factor enrolment, work queue, question editor with candidate preview, both review gates, publishing, versions, case studies, CSV/JSON import, blueprints, reports, recovery codes | 6 |
| `packages/admin-web/test/ui.test.ts` | Drives the panel in headless Chrome against the real API and database | 6 |
| `db/migrations/006_exhibits_users.sql` | Exhibits (images and tables) for questions and case studies, frozen with published versions; role changes and two-factor reset | 7 |
| `packages/candidate-web/index.html` | Candidate web app, served by the API at /app: registration and email confirmation, password reset, study-plan setup, dashboard, practice with explanations and question reports, full mock exam with case studies, exhibits, autosave, navigator, section review, breaks and server timer, results, answer review, statistics, settings; English and Arabic; light and dark | 8 |
| `packages/candidate-web/test/ui.test.ts` | Drives the candidate app in headless Chrome against the real API and database | 8 |
| `db/migrations/007_access.sql` | Plans, prices per region (set by an administrator, none seeded), stacking passes, single-use access codes stored as hashes, store purchase records | 9 |
| `packages/api/src/billing.ts` | Interface for App Store and Google Play purchase verification; refuses purchases until configured | 9 |
| `packages/api/src/xlsx.ts` | Reads the first sheet of an Excel (.xlsx) file with Node's built-in zlib, with caps on parts, sizes, expansion and rows | 10 |
| `prototype/index.html` | Clickable prototype: dashboard, practice with explanations, mini mock with sections, break and timer, stats; English and Arabic; light and dark | 4 |

## Run

Requires Node.js 22.18 or newer (runs TypeScript directly) and, for the
integration tests, PostgreSQL 16 binaries. No install step.

```
cd packages/exam-engine && npm test      # 44 tests, about 20 seconds

eval "$(scripts/pg-temp.sh start)"       # throwaway database on port 5545
cd packages/exam-store && npm test       # 12 database-client tests and 13 integration tests
scripts/pg-temp.sh stop

eval "$(scripts/pg-temp.sh start)"
cd packages/api && npm test              # 71 tests: Excel reader, SMTP, Arabic messages, Google Play, HTTP, production rehearsal (candidate and staff), about 60 seconds
eval "$(scripts/pg-temp.sh start)"
cd packages/admin-web && npm test        # 15 browser tests, including the Arabic panel and both starter-draft imports, needs Playwright and Chrome
eval "$(scripts/pg-temp.sh start)"
cd packages/candidate-web && npm test    # 12 browser tests: phone screen, offline start, Google Play purchase
TOKEN_SECRET="$(openssl rand -hex 32)" node packages/api/src/server.ts   # :8080 — candidate app at /app, admin panel at /admin (emails printed to the console)

python3 api/check_contract.py api/openapi.yaml   # needs PyYAML
```

Total: 168 automated tests (44 engine, 12 database client, 13 database integration, 4 Excel reader, 5 SMTP, 2 message catalogue, 4 Google Play, 49 HTTP, 8 production rehearsal, 27 browser).

`npm run typecheck` in either package needs TypeScript 5.8+. In exam-store it
covers `ports.ts` and `service.ts`; `psql-store.ts` also needs `@types/node`.

## What is official and what is ours

In the blueprint file, each mix rule has a `source`:

- `official`: stated in PMI's July 2026 Examination Content Outline
  (domain weights, about 40% predictive and 60% agile plus hybrid).
- `house`: our own setting, because the outline gives no number: the
  agile / hybrid split, difficulty mix, share of multiple-response and
  graphic questions.

Also our settings, all changeable without code changes:

- Case-study section size (20 questions) and the 80 / 80 split of the
  independent questions.
- `breakPausesClock` (default on): time on a break, up to its allowed length,
  does not count against the 240 minutes; staying away longer does. Confirm
  against the current PMI handbook before launch.
- `excludeRecentAttempts` (default 2): a new mock avoids questions from the
  user's last two mocks, and falls back to the whole bank if that is not
  possible.

## Guarantees covered by tests

Engine (25 tests) and session rules (19 tests): see the test names in
`packages/exam-engine/test/`.

Integration on PostgreSQL (13 tests)

- The blueprint and the published bank are read from the database in the
  shape the engine expects; a generated exam is stored and still passes
  validation when read back.
- One active attempt per user; another user cannot see or change it.
- The open section is served without keys, rationales, question ids or
  case-study ids.
- A full 180-question attempt with two breaks runs against the database; the
  stored score, per-answer correctness and section states match a hand count.
- Nothing is accepted after submission; the result is stable.
- A user's next mock shares no question with the previous one.
- An abandoned attempt expires on the server and is scored on what was saved.
- A stale write is rejected instead of overwriting newer state.
- A question cannot be published unless approved at both gates by someone
  other than its author; publishing is written to the audit log.
- An exam containing an unpublished question version cannot be stored.
- Withdrawing one question of a case set removes the whole set from new exams;
  finished attempts that used it remain readable.

HTTP API (19 tests, real requests, responses checked against the contract)

- Registration with validation; email verification required before sign-in;
  the verification and reset tokens are only ever emailed.
- Wrong password and unknown email give the same answer; repeated sign-in
  attempts from one client are limited.
- Forged, tampered and expired access tokens are rejected; sign-out and
  password change end sessions at once.
- Refresh tokens rotate; reusing an old one revokes the whole chain.
- Practice serves questions without keys and explains them only after the
  answer is stored; it never offers questions from a running mock.
- A full mock exam runs over HTTP; review with keys is available only after
  submission; one user cannot reach another user's data.
- Dashboard and analytics totals reconcile with the stored answers.
- Malformed JSON, oversized bodies and unknown routes get clean errors with
  no internal detail.

Staff tools (13 tests)

- One-time codes match the RFC 6238 test vectors; a code is accepted once,
  with one step of clock drift; secrets are stored encrypted (AES-256-GCM).
- Students cannot reach staff endpoints; staff cannot use them without a
  two-factor session, which survives token refresh.
- Drafts are validated field by field; only the author or an administrator
  can edit a draft, and only while it is a draft.
- The workflow refuses: submitting without the originality declaration or an
  explanation, approving without all eight checks, returning without a
  comment, reviewing your own question (administrators included), publishing
  by a non-administrator, and publishing with approvals from before a return.
- Every workflow step is written to the audit log.
- A new version of a published question is a draft copy; publishing it
  retires the old version; only one open version per question.
- Imports report each row as valid, invalid or duplicate (against the bank and
  within the file) and store only valid rows, as drafts.
- A blueprint version is activated only if 20 sample exams against the current
  bank are all valid; the bank is reused across versions by task code.

Case studies and recovery (in the 34 HTTP tests)

- Exam sections now carry the scenario text of their case studies, keyed by
  per-attempt labels, in the order candidates meet them.
- A case study is published only with 2 to 10 questions, all published;
  published case studies cannot be edited; withdrawing one removes the whole
  set from new exams.
- Enabling two-factor sign-in returns ten recovery codes, stored as hashes;
  each signs in once; a new set cancels the old one.

Exhibits and user administration (in the 36 HTTP tests)

- Images must really be PNG, JPEG or WebP (checked from the file's bytes, so
  an SVG renamed as PNG is refused), at most 1 MiB, with alternative text.
  Tables are limited to 12 columns and 30 rows of plain text.
- Candidates get tables inline and images through signed addresses that
  expire after 4 hours; a guessed, altered or expired address answers 404.
- Exhibits of a published question version cannot change; a new version
  copies them.
- Changing a user's roles ends their sessions; an administrator cannot remove
  their own administrator role or reset their own two-factor sign-in.
- A two-factor reset removes the secret and recovery codes and ends all
  sessions; the person enrols again at next sign-in.

Admin panel in a browser (9 tests, headless Chrome)

- An author enrols in two-factor sign-in, writes a draft with a live candidate
  preview, and cannot submit without the originality declaration.
- A reviewer finds it in the work queue, cannot approve with a failed check,
  and approves both gates; an administrator publishes it from the queue, and
  the question enters the exam bank.
- The author attaches a table and an image; both appear in the candidate
  preview, and the image loads through its signed address.
- CSV import shows a row-by-row check before anything is stored.
- An administrator resets a staff member's two-factor sign-in from the Users
  screen, and cannot do it for themselves.
- A case study is created and a question started inside it.
- No script errors in the browser console.

Candidate app in a browser (7 tests, headless Chrome)

- A new candidate registers, cannot sign in before confirming the email,
  confirms it from the emailed link, and sets an exam date and study hours.
- Ten practice questions with verdicts and explanations; a question report
  reaches the database.
- Arabic switches the whole layout to right to left; question text stays left
  to right; the language choice is saved to the profile.
- A full mock exam: the case scenario opens with its first question, answers
  autosave, a flag shows in the navigator, sections close into breaks and
  resume, and the exam is submitted; the database holds exactly the answers
  given.
- Answer review after the exam, filtered to flagged questions.
- After a page reload and a new sign-in, an unfinished exam resumes with the
  saved answer still selected.
- Statistics by domain and approach; no script errors in the console.

### Plans and access (increment 9)

- Prices live in the database per plan and region (Egypt, Gulf, other) and
  are changed from the admin panel; the code holds no price. No price is
  seeded: a plan without a price in a region is shown as not on sale there.
- Without a pass, a candidate gets a daily allowance of practice questions
  (server setting `freeDailyPractice`, default 15, counted per UTC day) and
  no mock exams: the API answers 402 `payment_required` or
  `daily_limit_reached`, and the app shows the allowance and a locked mock
  card instead of letting the request fail. Staff always have full access.
- Passes stack: a new one starts when the current one ends. A store
  transaction or access code can grant at most one pass, however often it
  is sent.
- Access codes (`XXXX-XXXX-XXXX`) are created in batches by an administrator,
  shown once, and stored only as hashes. Redemption ignores case, spaces and
  dashes, is rate limited, and refuses unknown, used and expired codes. Two
  simultaneous redemptions of one code cannot both succeed (row lock).
- Every price change, code batch and grant is written to the audit log.
- `POST /billing/purchases` checks the product against the price table, then
  asks a `StoreVerifier`. The default verifier refuses with 503
  `store_billing_not_configured`; no purchase is ever trusted from the client.

### Excel import and Arabic admin panel (increment 10)

- The import screen accepts .xlsx files as well as CSV and JSON. The server
  reads the first sheet (`POST /admin/imports/spreadsheet`, stores nothing);
  the panel maps the columns exactly as for CSV, then the usual check and
  import run. Shared, rich, inline and Arabic text, numbers and booleans
  are read; password-protected, damaged, ZIP64 and oversized files are
  refused with a reason; a part that expands beyond 32 MiB is stopped.
- The admin panel has an Arabic interface: every label goes through one
  dictionary, the layout mirrors right to left, and the choice is saved to
  the staff member's profile. Question text, options, emails and codes keep
  their own direction. A browser test visits every screen in Arabic, checks
  that nothing scrolls sideways, and fails if any interface string has no
  translation.

### Production database access (increment 11)

- The application no longer starts a `psql` process per call. Every store
  call is asynchronous and goes through `PgPool`, a connection pool written
  on Node's own `net`, `tls` and `crypto` modules (no driver package could be
  installed here, and the project avoids runtime dependencies).
- It signs in with SCRAM-SHA-256 (the PostgreSQL default), MD5 or a plain
  password, encrypts with TLS (`PGSSLMODE=require` or `verify-full` with
  `PGSSLROOTCERT`), sets a statement time limit (`PG_STATEMENT_TIMEOUT_MS`,
  default 30 s), runs sessions in UTC, caps open connections (`PGPOOL_MAX`),
  queues requests beyond that with a time limit, closes idle connections and
  replaces connections the server dropped. A multi-statement call runs as one
  transaction; `pool.transaction()` gives an explicit one.
- The HTTP and browser tests now run the application on the pool;
  assertions still read the database through `psql`.
- `GET /api/v1/health` reports whether the database answers, for load
  balancers. `server.ts` uses the pool and finishes open requests on SIGTERM.
- Load check on this machine (database on the same host, 50 candidates at
  once, dashboard + practice question): about 590 requests/s, median 133 ms
  per pair, 95th percentile 178 ms. The same check on the old `psql` adapter:
  25 requests/s, median 3.5 s. This is not a capacity test.
- The candidate app now ignores a slow, outdated screen load if the person
  has already moved on (found while running the tests on the faster pool).

### Ready for a production server (increment 12)

- Settings come from environment variables and are checked at start-up;
  in production the server refuses a weak secret, a non-https address,
  console email, unencrypted SMTP, a remote database without TLS, or missing
  terms and privacy links, and lists what to fix.
- Account emails go out over SMTP to any provider, in Arabic and English,
  in the background so the response never waits for, or reveals, the mail
  provider.
- `scripts/migrate.ts` applies new migrations in one transaction under an
  advisory lock, records a checksum per file, refuses an edited applied
  migration, and activates the exam blueprint on a new database. It never
  loads test data. The server refuses to start on an unmigrated database.
- `scripts/create-admin.ts` creates the first administrator, who must set up
  two-factor sign-in before any staff tool opens.
- Behind a reverse proxy the client address is read from X-Forwarded-For
  (`TRUST_PROXY_HOPS`) for rate limiting and logs. HSTS on https sites,
  request ids, JSON request logs without secrets, request time limits,
  `/` redirects to `/app`, clean shutdown on SIGTERM.
- Terms, privacy and support links are settings, shown at sign-up and in
  Settings (`GET /api/v1/site`).
- Backups and restore scripts, a Dockerfile (unprivileged, read-only, health
  check), Docker Compose with Caddy for automatic HTTPS, systemd units, and
  the runbook [DEPLOY.md](DEPLOY.md).
- `packages/api/test/production.test.ts` rehearses a production start on an
  empty database with the real server process and a real SMTP conversation.
- Docker itself could not run here: the image's file list was copied out
  and run by hand as an unprivileged user instead. Build it once on a
  staging server before going live.

### Operations and privacy (increment 13)

- Sign-in rate limiting is counted in the database, so several copies of the
  app can run behind one load balancer and limits survive restarts. Only a
  SHA-256 hash of the client address and endpoint is stored; old windows are
  cleaned up automatically.
- Error titles and field messages come back in Arabic when the request asks
  for Arabic (`Accept-Language: ar`); `code` and `field` stay the same. A test
  extracts every message from the source and fails if one has no Arabic. The
  admin panel now sends its language too.
- Candidates can download everything stored about them as a JSON file
  (`GET /api/v1/me/export`, Settings → Your data): profile, sessions,
  practice answers, mock exams, reports, access. No secrets are included.
- Administrators have an **Audit log** screen: every staff action and access
  change, newest first, filtered by area and by person (`GET /api/v1/admin/audit`).

### Web and mobile publishing (increment 14)

- The candidate app is an installable web app: manifest, icons for every
  platform (original design), a service worker that keeps only the app shell
  (never answers or personal data), offline start with a clear notice, an
  install button in Settings and Add to Home Screen instructions on iPhone.
- `https://<domain>/` is a bilingual landing page; `robots.txt` keeps search
  engines out of the admin panel and the API.
- `android/` is a Google Play app (Trusted Web Activity) targeting Android 16
  (API 36), with Google Play Billing. Inside it, the plan screen shows Google
  Play prices and a Buy button; the server checks each purchase with Google
  (`GOOGLE_SERVICE_ACCOUNT_FILE`), grants the pass once per order, never to a
  second account, then acknowledges and consumes it. The site confirms the
  app through `/.well-known/assetlinks.json` (`ANDROID_PACKAGE`,
  `ANDROID_CERT_SHA256`).
- `store/` holds the listing texts, data safety and content rating answers,
  12 real phone screenshots (Arabic and English, 1080 × 1920), the feature
  graphic and the 512 px icon.
- Not done: building the Android project (no Android SDK or network here),
  and any App Store app; see PUBLISH.md.

### Starter content (increment 15)

- `content/starter-drafts.xlsx`: 52 original questions, two for each of the
  26 tasks of the July 2026 outline (23 predictive, 20 agile, 9 hybrid; 2
  multiple-response), each with four options, a rationale per option, why
  the answer is right, the mindset and the key concept. Every row is marked
  `aiAssisted`; the import makes them drafts, which must pass expert review
  and language review before an administrator can publish them. The import
  now carries the `aiAssisted` column.
- They are a starting point for authors, not exam content: reviewers must
  check every answer against current references and rewrite freely. The
  bank still needs several hundred reviewed questions (DEPLOY.md, section 5).
- Store screenshots now show case-study questions that match their scenario.

### Case studies from Excel and a second batch of drafts (increment 16)

- The Excel import reads every sheet. A sheet named like "Case studies"
  (columns `caseKey`, `title`, `scenario`) creates case-study drafts, and
  question rows with a matching `caseKey` are attached to them. A file whose
  questions name a case missing from the file is stopped before checking.
- `content/starter-drafts-2.xlsx`: 52 more standalone drafts (two more per
  task) and 6 case studies (hospital, solar farm, banking app, school
  building, retail rollout, logistics platform) with 3 questions each.
  Together with the first batch: 122 original drafts, 53 predictive, 39
  agile, 30 hybrid, 15 multiple-response, all marked as drafted with AI help
  and all needing expert and language review.

## Not yet done

- No real question content exists. The bank is synthetic metadata.
- The admin panel was tested in Chrome only. Error messages that come from
  the server (validation details, workflow refusals) are still in English
  in the Arabic panel. Excel import reads the first sheet only and ignores
  formulas' logic (it uses the last value Excel saved); old .xls files must
  be saved as .xlsx.
- Images are stored in the database. At scale they should move to object
  storage behind a CDN; only the exhibit functions and the image endpoint
  change. A question cannot move between case studies after it is created.
- Duplicate detection compares normalised stems exactly; it does not find
  reworded near-duplicates.
- Identity checks before a two-factor reset are a manual procedure (for
  example a phone call); the panel only reminds the administrator.
- Password hashing uses scrypt, not the Argon2id named in the architecture,
  because no native module could be installed. The stored format allows a
  later upgrade on sign-in.
- No native mobile app: there is no Flutter SDK in this environment. The web
  app covers the same flows and the API contract is ready for the Flutter
  client. `prototype/` is the earlier static mock-up and is superseded.
- The candidate app was tested in Chrome, on a desktop window and on a
  390 x 844 phone viewport (no sideways scrolling, 44 px touch targets).
  Real phones, Safari and Firefox, and screen readers still need testing.
- Store purchases are not verified yet: that needs App Store Connect and
  Google Play Console accounts, products and server credentials. Store rules
  on selling digital access outside in-app purchase (access codes sold for
  money, web checkout) differ by store and country and must be checked
  before launch. Refunds and store notifications (revocations) are not
  handled yet. No web card payments.
- Prices are flat per region. Taxes, promotional prices and currency
  display rules for each store still need decisions.
- The database client is new code. It is tested against PostgreSQL 16 here,
  including TLS and every sign-in method, but has not met a managed cloud
  database, a connection proxy (PgBouncer) or a failover yet. Before launch:
  run it against the chosen provider, or swap in a widely used driver behind
  the same `SqlRunner` interface if the team prefers.
- SQL is sent as text built from validated or dollar-quoted literals (simple
  query protocol). Server-side parameters (extended protocol) would add a
  second layer of protection and are a sensible next step.
- Under optimistic concurrency a conflicting request retries up to three
  times. This is tested for a stale write, not under real parallel load.
- Each request loads the attempt's 180 questions from PostgreSQL. A cache
  (Redis, as in the architecture) is still to be added and measured.
