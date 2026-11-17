# A free online trial site

This puts the site online at no cost, to show it to people and try it.
It is **not** for real candidates: the free server sleeps when nobody uses
it (the first visit after a pause takes up to a minute), and this setup
prints account emails to the server log instead of sending them. For a real
launch use DEPLOY.md.

It uses two free services (limits change; check their pricing pages):

- **Neon** – the PostgreSQL database. The free plan has no time limit.
- **Render** – runs the application from this project's `Dockerfile` and
  gives it an `https://<name>.onrender.com` address.
- **GitHub** – Render takes the code from a GitHub repository.

Not tried from the environment where this was written (no access to these
services). What was tested: the same start command against a database
reached over TLS with a password and a non-administrator account.

## Steps

1. **GitHub.** Create a free account and a new **private** repository.
   Upload the contents of this project folder (GitHub → *Add file → Upload
   files*, or `git push`).
2. **Neon.** Sign up at neon.com, create a project (PostgreSQL 16 or newer,
   a region close to your users). Open *Connect* and note the host, database,
   user and password of the **direct** connection (not the "pooled" one).
3. **Render.** Sign up at render.com → *New → Blueprint* → choose your
   repository. Render reads `render.yaml` and asks for these values:

   | Name | Value |
   | --- | --- |
   | `PGHOST` | Neon host, such as `ep-xxxx.eu-central-1.aws.neon.tech` |
   | `PGDATABASE` | Neon database, usually `neondb` |
   | `PGUSER` | Neon user |
   | `PGPASSWORD` | Neon password |
   | `PUBLIC_URL` | `https://<service name>.onrender.com` (shown by Render; you can correct it after the first deploy) |
   | `ADMIN_EMAIL` | your email: the first administrator |
   | `ADMIN_PASSWORD` | a long password, at least 10 characters |

4. **Deploy.** The first build takes a few minutes. On start the service
   updates the database, creates the administrator, loads the demo question
   bank and starts. Watch *Logs* until you see `listening`.
5. **Open** `https://<service name>.onrender.com/`:
   - Student app `/app`: `student@demo.local` / `demo student 2026`
   - Admin panel `/admin`: your `ADMIN_EMAIL` and `ADMIN_PASSWORD`, then set
     up two-factor sign-in with an authenticator app.

## Good to know

- `DEMO_CONTENT=1` (set in `render.yaml`) loads a **synthetic** bank so mock
  exams work. Its questions read "Synthetic item …": it shows how the product
  works, not real content. Remove the variable for an empty bank, then import
  `content/starter-drafts.xlsx` in the admin panel and take the drafts
  through review.
- The demo student's password is public. Delete that account, or do not load
  demo content, before sharing the address widely.
- New sign-ups: the confirmation link appears in Render's *Logs* (look for
  `[dev mail]`), because no email provider is connected.
- After `ADMIN_PASSWORD` has done its job, delete that variable on Render.
- To move to a real launch: a paid instance (or your own server), SMTP,
  terms and privacy pages, `NODE_ENV=production` and no `DEMO_CONTENT`.

---

## Alternative: Back4App (containers free tier)

Back4App's free container tier does not sleep between requests, which makes
it better for showing the app to real people, though limits still apply.

1. **Back4App account.** Sign up at back4app.com and open *Containers*.
2. **Connect your GitHub repo.** Back4App pulls directly from GitHub on each push.
3. **Set environment variables** (same list as the Render table above, plus
   `HOST=0.0.0.0` and `PORT=80`).
4. **Health check path:** `/api/v1/health`
5. **Free limits:** 0.25 vCPU, 256 MB RAM, 10 GB bandwidth/month. Enough for
   a demo with a handful of users.

The Neon database setup is the same as above.

---

## Upgrading to a paid plan for real launches

For real candidates use a service that:
- Does **not** sleep (Render Starter $7/month, Railway, Fly.io, or your own VPS)
- Keeps `NODE_ENV=production`
- Has SMTP configured (Resend free tier: 100 emails/day; Brevo free tier: 300/day)
- Has `TERMS_URL` and `PRIVACY_URL` set to publicly reachable HTTPS pages

The `/terms` and `/privacy` pages built into the server can be used as
`TERMS_URL=https://your-domain.com/terms` and
`PRIVACY_URL=https://your-domain.com/privacy` once you have a custom domain.
