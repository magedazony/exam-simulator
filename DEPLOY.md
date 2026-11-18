# Deploying the Exam Simulator

This is the procedure to run the system for real users: the API, the
candidate web app (`/app`) and the admin panel (`/admin`), on one server,
with HTTPS, email, daily backups and monitoring.

Two ways are described. **A. Docker Compose** is the recommended one.
**B. systemd** is for a server where Docker is not wanted.

What was tested before this was written (see "What has and has not been
verified" at the end): every command and script below on PostgreSQL 16 and
Node.js 22, a full production start on an empty database, the image's file
layout run as an unprivileged user, and a backup restored into a new
database. Docker itself could not be run where this was prepared.

---

## 1. What you need

| Item | Notes |
| --- | --- |
| A Linux server | 2 vCPU, 4 GB RAM, 40 GB SSD is enough to start. Ubuntu 24.04 LTS or Debian 12. Open ports 80 and 443 only (and SSH). |
| A domain name | For example `exam.example.com`, with an A record (and AAAA for IPv6) pointing at the server. |
| An SMTP email provider | Amazon SES, Mailgun, Postmark, SendGrid, Microsoft 365, or a company relay. You need host, port, user, password and a sender address on your domain. Set up SPF, DKIM and DMARC for that domain, or confirmation emails will land in spam. |
| Terms of use and privacy policy pages | Published at public https addresses. The server refuses to start in production without them, because candidates must be able to read what they accept. These texts need a lawyer. |
| Docker Engine with the Compose plugin | For way A. |
| An off-server place for backups | Another region, object storage, or another machine. |

## 2. Settings

All settings are environment variables. The template with every variable
explained is [`deploy/.env.example`](deploy/.env.example).

```
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
openssl rand -hex 32     # use the output for TOKEN_SECRET
openssl rand -hex 24     # use the output for PGPASSWORD
```

Then fill in `deploy/.env`: `DOMAIN`, `ACME_EMAIL`, `PUBLIC_URL`,
`TOKEN_SECRET`, `PGPASSWORD`, the `SMTP_*` and `MAIL_FROM` lines, and
`TERMS_URL`, `PRIVACY_URL`, `SUPPORT_EMAIL`.

With `NODE_ENV=production` the server checks its settings at start-up and
stops with a list of what to fix if anything is unsafe: a short or
placeholder `TOKEN_SECRET`, a `PUBLIC_URL` without https, email printed to
the console instead of sent, unencrypted SMTP, a remote database without
TLS, or missing terms and privacy links.

Keep `deploy/.env` out of version control. Store a copy of `TOKEN_SECRET`
and `PGPASSWORD` in your password manager: losing `TOKEN_SECRET` signs
everyone out and makes staff two-factor secrets unreadable (staff then
enrol again).

## 3A. Install with Docker Compose (recommended)

```
# on the server, in the project folder
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/docker-compose.yml --env-file deploy/.env ps
```

This starts five services:

| Service | What it does |
| --- | --- |
| `db` | PostgreSQL 16, data in the `pgdata` volume, reachable only inside the Compose network. |
| `migrate` | Runs once on every start: applies new database migrations and activates the July 2026 exam blueprint if none is active. The app does not start if it fails. |
| `app` | The server, as an unprivileged user, read-only file system, 512 MB memory cap. |
| `caddy` | HTTPS in front of the app. Gets and renews the Let's Encrypt certificate for `DOMAIN` automatically. |
| `backup` | A database backup at start and every 24 hours into `BACKUP_HOST_DIR` (default `deploy/backups`), kept for `BACKUP_KEEP_DAYS`. |

Check it:

```
curl https://exam.example.com/api/v1/health
# {"status":"ok","database":"ok","databaseMs":2}
docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs -f app
```

Logs are JSON lines: one per request (time, request id, method, path,
status, duration, client address) and one per server problem. They never
contain tokens, passwords, request bodies or query strings.

## 3B. Install with systemd (no Docker)

1. Install Node.js 22.18 or newer, PostgreSQL 16 and Caddy from their
   official packages.
2. Create the database and a user with a password:
   ```
   sudo -u postgres createuser --pwprompt exam
   sudo -u postgres createdb --owner exam exam
   ```
   The first migration creates the `citext` and `pgcrypto` extensions. If the
   `exam` user may not create extensions, run once as the postgres user:
   `CREATE EXTENSION citext; CREATE EXTENSION pgcrypto;` in the `exam`
   database.
3. Create a system user and copy the code:
   ```
   sudo useradd --system --home /srv/exam-simulator --shell /usr/sbin/nologin exam
   sudo mkdir -p /srv/exam-simulator && sudo cp -r packages db scripts package.json /srv/exam-simulator/
   ```
4. Put the settings in `/etc/exam-simulator.env` (same variables as
   `deploy/.env.example`, plus `PGHOST=127.0.0.1`, `TRUST_PROXY_HOPS=1`),
   owned by root, mode 600.
5. Install the units from `deploy/systemd/` into `/etc/systemd/system/`, then:
   ```
   sudo systemctl daemon-reload
   sudo systemctl enable --now exam-simulator exam-simulator-backup.timer
   ```
   The service runs the migrations before every start.
6. Use `deploy/Caddyfile.host` as `/etc/caddy/Caddyfile` (change the domain)
   and `sudo systemctl reload caddy`.

## 4. First administrator

```
# Docker
docker compose -f deploy/docker-compose.yml --env-file deploy/.env run --rm app node scripts/create-admin.ts --email you@example.com
# systemd
sudo systemd-run --uid=exam --pty --wait -p EnvironmentFile=/etc/exam-simulator.env -p WorkingDirectory=/srv/exam-simulator /usr/bin/node scripts/create-admin.ts --email you@example.com
```

It asks for a password (at least 10 characters). Then open
`https://exam.example.com/admin`, sign in, and set up two-factor sign-in with
an authenticator app; no staff tool opens before that. Save the ten recovery
codes it shows. Add authors and reviewers from **Users**: they register at
`/app` first, then you give them their roles.

## 5. Before opening to candidates

The database starts empty: no questions, no prices. No test data is ever
loaded by these commands.

1. **Questions.** Authors write or import questions (Import accepts Excel,
   CSV and JSON). `content/starter-drafts.xlsx` holds 52 original drafts, two
   per task, drafted with AI help, as a starting point for reviewers; each goes through expert review and language review, then
   an administrator publishes it. Case studies need 2 to 10 published
   questions each.

   Additional content files in `content/`:
   - `pmp-questions-all.xlsx` — the owner's own questions, all in one file:
     336 questions from the English practice deck (EXAM No.1) and the Arabic
     Agile deck, merged and de-duplicated. Every row is bilingual (stem,
     options and explanation in English and Arabic) with the answer key.
     Explanations and translations are AI drafts (`aiAssisted` = TRUE): review
     them on Admin → Bulk review before publishing. Sheet "Check the key" lists
     doubtful keys, "Needs your answer" 3 slides with no marked answer, and
     "Not imported" duplicates and drag-and-drop or chart questions.
   - `starter-drafts-2.xlsx` — 52 more AI-assisted draft questions plus 6
     case studies (requires the same expert + language review as the first
     batch).
2. **Is the bank big enough?** Open **Blueprints** and press **Dry run** on
   the active blueprint. It builds 20 sample mock exams from the published
   questions. Until 20 of 20 are valid, starting a mock exam returns a clear
   "exam could not be generated" error; practice mode works with whatever is
   published. The content plan targets about 700 questions so that repeat
   attempts do not keep showing the same ones.
3. **Prices.** In **Plans and access**, set a price for each pass in each
   region you sell in. A pass without a price in a region is shown as not
   on sale there. In-app purchases stay off until App Store and Google Play
   accounts and their server credentials are set up; until then the
   purchase endpoint answers "not available yet", and access is given with
   access codes or by an administrator.
4. **Access codes** for training courses: **Plans and access → Access codes**.
   Copy the codes when they are shown; only fingerprints are kept.
5. **Email check.** Register a test account at `/app` with an address you
   own and confirm the email arrives (check spam), and that the link opens.
6. **Restore drill.** Restore last night's backup into a scratch database
   (section 7) before real candidates arrive.

## 6. Updating

Migrations only move forward and run automatically.

```
# take a backup first
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec backup sh /usr/local/bin/backup.sh
# get the new release into the project folder, then
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/docker-compose.yml --env-file deploy/.env logs migrate
```

If `migrate` reports that an applied migration file changed, the release is
wrong: never edit an applied migration; new changes go in a new numbered
file. A failed migration changes nothing, and the old app keeps running.

**Rolling back** a release that already migrated: restore the backup taken
before the update into a new database (section 7), point `PGDATABASE` at
it, and start the previous release.

## 7. Backups and restore

`scripts/backup.sh` writes `PGDATABASE-YYYYMMDDTHHMMSSZ.dump` (compressed),
checks the file can be read, and deletes local backups older than the
retention period. Copy the backup folder off the server every day, for
example with `rclone` or `restic` to object storage in another region.

Restore into an **empty** database (the script refuses a database that
already has tables, so it cannot overwrite live data):

```
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec db createdb -U exam exam_restore
docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec -e PGDATABASE=exam_restore backup \
  sh /usr/local/bin/restore.sh /backups/exam-20261115T020000Z.dump
```

On a systemd server: `PGDATABASE=exam_restore scripts/restore.sh <file>`. It
prints the number of migrations, users and questions restored, to compare
with the live database.

## 8. Monitoring

- **Health:** `GET /api/v1/health` returns 200 when the database answers
  within 2 seconds, 503 otherwise. Point an uptime monitor at it (one check
  a minute) and alert on two failures in a row.
- **Logs:** alert on any `"level":"error"` line, and on a rising share of
  5xx statuses.
- **Disk:** alert at 80% (database volume and backup folder).
- **Certificates:** Caddy renews them; an uptime monitor that checks HTTPS
  catches a failed renewal.
- **Staff activity:** the admin panel's **Audit log** lists every staff
  action, role change, price change, code batch and pass given.

## 9. Security checklist

- [ ] Only ports 22, 80 and 443 open; SSH by key only.
- [ ] `deploy/.env` is mode 600 and not in version control.
- [ ] Automatic security updates for the operating system.
- [ ] Every staff account uses two-factor sign-in (enforced) and stores its
      recovery codes.
- [ ] Backups copied off the server and a restore tested.
- [ ] SPF, DKIM and DMARC set for the email domain.
- [ ] A managed database, if used, is reached with `PGSSLMODE=verify-full`.
- [ ] Several app copies may run behind a load balancer: rate limits are
      shared through the database. Set `TRUST_PROXY_HOPS` to the number of
      proxies in front (Caddy alone: 1; a cloud load balancer plus Caddy: 2).

## 10. Go-live checklist (needs people, not code)

- [ ] Terms of use and privacy policy written by a lawyer for each country
      you sell in, published, and their addresses set.
- [ ] Trademark wording reviewed: the apps say the product is independent
      and not endorsed by PMI; keep it that way in marketing.
- [ ] Questions written, reviewed in both gates and published; Dry run 20/20.
- [ ] Prices decided and entered per region.
- [ ] Rules for selling access codes for money checked with Apple and Google
      for each country, before codes are sold rather than given to course
      students.
- [ ] App Store and Google Play accounts, products and server credentials,
      if and when the mobile apps are published.
- [ ] Support mailbox monitored; reports from the candidate app reviewed in
      **Reports** within 72 hours.
- [ ] A procedure for privacy requests: candidates download their own data
      from Settings → Your data and delete their account there; requests by
      email are answered from **Users** and the database within the time the
      law sets (Egypt: Personal Data Protection Law No. 151 of 2020; check
      each country you sell in).

## What has and has not been verified

Verified here, by automated tests that run on every change
(`packages/api/test/production.test.ts` and the other suites):

- Migrations on an empty database, idempotent re-runs, refusal when an
  applied migration was edited, complete rollback of a failing migration.
- Creating the first administrator from the command line.
- The server refusing unsafe production settings; starting in production
  mode; HTTPS-only headers; sign-up through a real SMTP conversation
  (STARTTLS and authentication) to email confirmation and sign-in; rate
  limiting by the client address behind one proxy; JSON request logs without
  secrets; clean shutdown on SIGTERM.
- The image's file list (`Dockerfile`) copied out by hand and run as an
  unprivileged user: migrations and server start.
- A backup restored into a new database with matching counts.

Not verified here:

- Building and running the Docker image, Compose and Caddy: Docker's
  service could not run in the preparation environment. Do a first run on a
  staging server and keep this document's commands as the checklist.
- A managed cloud database, a real SMTP provider and real email delivery.
- Load beyond the rough check in the README.
