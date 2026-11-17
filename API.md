# PMP Exam Simulator — API Reference

Base URL: `${PUBLIC_URL}/api`  
Auth: `Authorization: Bearer <access_token>` on all endpoints unless marked `(public)`.  
Errors: `{ "error": "<code>", "message": "...", "field"?: "..." }` with appropriate HTTP status.

---

## Auth

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/register` | Register a new account `{ email, password, language }` |
| POST | `/auth/login` | Login `{ email, password, totpCode? }` → `{ accessToken, refreshToken }` |
| POST | `/auth/refresh` | Exchange refresh token → new access + refresh tokens |
| POST | `/auth/logout` | Revoke current session |
| POST | `/auth/verify-email` | Verify email `{ token }` |
| POST | `/auth/password/reset-request` | Send reset email `{ email }` |
| POST | `/auth/password/reset` | Reset password `{ token, newPassword }` |
| POST | `/auth/mfa/setup` | Begin TOTP setup → `{ secret, qrCodeUrl }` |
| POST | `/auth/mfa/enable` | Confirm TOTP `{ totpCode }` |
| POST | `/auth/mfa/recovery-codes` | Generate recovery codes |

---

## Candidate Profile

| Method | Path | Description |
|--------|------|-------------|
| GET | `/me` | Current user record |
| PATCH | `/me` | Update profile `{ displayName?, language?, examTargetDate?, weeklyStudyHours? }` |
| DELETE | `/me` | Delete account |
| GET | `/me/export` | Export all user data (JSON attachment) |
| GET | `/me/access` | Current entitlement and plan |
| GET | `/me/dashboard` | Full dashboard: stats, readinessScore, spacedReviewsDue, taskMastery, recentMockScores, **recommendation** |
| GET | `/me/profile` | Learner intelligence profile: strongest/weakest task, error type, streak |
| GET | `/me/readiness` | `{ score: 0–100 }` |
| GET | `/me/mastery` | Task mastery rows, sorted weakest first |
| GET | `/me/spaced-reviews/due` | `{ count }` of questions overdue for spaced review |
| GET | `/me/study-plan?weekStart=YYYY-MM-DD` | Weekly study plan (auto-generates if missing) |
| POST | `/me/study-plan/refresh` | Force regenerate current week's plan |
| GET | `/me/analytics?dimension=domain\|task\|approach\|difficulty\|type` | Analytics rows |
| GET | `/me/analytics/domains` | Per-domain accuracy + mastery score |
| GET | `/me/analytics/difficulty` | Per-difficulty accuracy |
| GET | `/me/errors` | Error type distribution |
| POST | `/me/errors` | Classify errors `[{ questionId, attemptType, errorType, aiAssisted }]` |

---

## Bookmarks & Notes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/me/bookmarks?limit=20&after=<cursor>` | List bookmarked questions |
| POST | `/me/bookmarks/:questionId` | Toggle bookmark on/off → `{ bookmarked: bool }` |
| GET | `/me/notes/:questionId` | Get note for a question |
| PUT | `/me/notes/:questionId` | Upsert note `{ content }` (max 2000 chars) |
| DELETE | `/me/notes/:questionId` | Delete note |

---

## Practice Sessions

| Method | Path | Description |
|--------|------|-------------|
| POST | `/practice/sessions` | Create practice session `{ mode, blueprintId?, filters?, questionCount? }` |
| GET | `/practice/sessions/:id/questions/:ordinal` | Get question N |
| POST | `/practice/sessions/:id/questions/:ordinal/answer` | Submit answer `{ selectedOptionIds, timeSpentMs? }` → feedback + rationale |
| GET | `/practice/sessions/:id/summary` | Session summary with score |
| POST | `/practice/adaptive` | Get adaptive/spaced/diagnostic questions `{ mode: 'adaptive'\|'spaced_review'\|'diagnostic', limit?, taskCode? }` |
| POST | `/practice/adaptive/response` | Record response `{ questionId, taskId, correct, source? }` |

---

## Full Mock Exams

| Method | Path | Description |
|--------|------|-------------|
| POST | `/exams/attempts` | Start mock exam (requires pass) |
| GET | `/exams/attempts` | List attempts `?limit&cursor` |
| GET | `/exams/attempts/:id` | Attempt state |
| PUT | `/exams/attempts/:id/answers/:ordinal` | Save answer `{ selectedOptionIds, clientSeq, flagged? }` |
| POST | `/exams/attempts/:id/sections/:idx/close` | Lock section |
| GET | `/exams/attempts/:id/sections/:idx/review` | Section review |
| GET | `/exams/attempts/:id/sections/:idx/questions` | Questions list for section |
| POST | `/exams/attempts/:id/resume` | Resume after break |
| POST | `/exams/attempts/:id/submit` | Submit exam → result |
| GET | `/exams/attempts/:id/result` | Exam result |
| GET | `/exams/attempts/:id/review?filter=all\|incorrect\|flagged\|unanswered&limit&cursor` | Post-exam review |

---

## Case Studies

| Method | Path | Description |
|--------|------|-------------|
| GET | `/case-studies?limit=20` | List published case sets |
| GET | `/case-studies/:id` | Case scenario + all questions |

---

## AI Coach

| Method | Path | Description |
|--------|------|-------------|
| POST | `/coach/hint` | Get hint `{ questionId, hintType: 'general'\|'approach'\|'eliminate'\|'explain' }` → `{ hint, usedToday }`. Free: 3/day; Pass: unlimited. |

---

## Notifications

| Method | Path | Description |
|--------|------|-------------|
| GET | `/me/notifications?limit=20&unread=true` | List notifications (optionally unread only) |
| POST | `/me/notifications/:id/read` | Mark one notification as read |
| POST | `/me/notifications/read-all` | Mark all notifications as read |

---

## Gamification

| Method | Path | Description |
|--------|------|-------------|
| GET | `/me/streak` | Current streak, longest streak, last activity date |
| GET | `/me/referral` | Referral code + usage stats |
| POST | `/me/coupon` | Apply a coupon code `{ code }` → `{ valid, discountPct?, reason? }` |

---

## Certificates

| Method | Path | Description |
|--------|------|-------------|
| GET | `/me/certificates` | List the candidate's completion certificates (newest first, up to 50) |
| GET | `/verify/:token` | Public certificate verification — `{ user_display, score_percent, issued_at, passed, revoked }` (public). `passed` is always `null`: a certificate records a finished mock exam and its score, never pass/fail, because PMI does not publish a passing score. |

A certificate is issued automatically, once, when a mock exam is submitted or its result is first read after it expired. Share links have the form `/app#verify-cert/<token>`.

---

## Weekly Progress Snapshots

| Method | Path | Description |
|--------|------|-------------|
| GET | `/me/weekly-snapshots?weeks=12` | Last N weeks of snapshot rows `{ weekStart, questionsAnswered, mocksTaken, accuracy }` |
| POST | `/me/weekly-snapshots/refresh` | Force recompute today's snapshot row |

---

## Exam Timer

| Method | Path | Description |
|--------|------|-------------|
| POST | `/exams/attempts/:id/heartbeat` | Client keepalive `{ timeRemainingMs? }` — prevents server-side abandonment detection |

---

## Billing & Access

| Method | Path | Description |
|--------|------|-------------|
| GET | `/plans?region=EG\|GULF\|INTL` | List plans with prices (public) |
| POST | `/me/redeem` | Redeem access code `{ code }` |
| POST | `/billing/purchases` | Verify store receipt (iOS/Android) |
| POST | `/billing/restore` | Restore purchase `{ transactionId, productId }` |

---

## Content & Utilities

| Method | Path | Description |
|--------|------|-------------|
| GET | `/blueprints/active` | Active exam blueprint |
| GET | `/exhibits/:id` | Exhibit file (image/PDF) |
| POST | `/question-reports` | Report a question `{ questionId, reason, detail? }` |
| GET | `/health` | Health check (public) |
| GET | `/site` | Site config: appName, androidPackage, etc. (public) |
| GET | `/tips` | Exam tips, published sections only: `{ items: [{ id, position, titleEn, titleAr, items: [{ en, ar }], published, updatedAt }] }` (public) |

---

## Admin (role: administrator)

Prefix: `/admin`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/questions` | List/search questions |
| POST | `/admin/questions` | Create question |
| GET | `/admin/questions/:id` | Question detail |
| PUT | `/admin/questions/:id` | Update question |
| POST | `/admin/questions/:id/review` | Submit review |
| POST | `/admin/questions/:id/publish` | Publish question |
| GET | `/admin/blueprints` | List blueprints |
| POST | `/admin/blueprints` | Import blueprint |
| POST | `/admin/blueprints/:id/activate` | Activate blueprint |
| GET | `/admin/users` | List users |
| PATCH | `/admin/users/:id` | Update user (status, roles) |
| POST | `/admin/access-codes` | Generate access codes |
| GET | `/admin/audit` | Audit log |
| GET | `/admin/plans` | List plans with prices |
| POST | `/admin/plans/:code/prices` | Set plan price |
| GET | `/admin/tips` | All exam tips sections, including unpublished (any staff role) |
| PUT | `/admin/tips` | Replace the whole tips document `{ sections: [{ titleEn, titleAr, published?, items: [{ en, ar }] }] }` in the order sent (content author or administrator). Up to 30 sections, 50 tips each; every title and tip needs English and Arabic. Recorded in the audit log as `tips.replace`. |
| GET | `/admin/question-difficulty?min_attempts=5&limit=50` | Questions ranked by measured difficulty (share of wrong answers in practice and finished mock exams) |
| GET | `/admin/certificates?limit=50&offset=0` | Completion certificates; `POST`/`DELETE /admin/certificates/:id/revoke` revokes or restores one |

---

## V2 Adaptive Signals Flow

```
Answer question → POST /practice/sessions/:id/questions/:ordinal/answer
  ↳ server records answer AND fires recordAdaptiveResponse() (non-blocking)
      ↳ updates task_mastery (weighted score, SM-2 ease/interval)
      ↳ inserts spaced_reviews row → trigger updates spaced_state

GET /me/dashboard
  ↳ returns readinessScore + spacedReviewsDue + recommendation (next_best_action())

Recommendation types:
  'spaced_review' → POST /practice/adaptive { mode: 'spaced_review' }
  'weakness'      → POST /practice/adaptive { mode: 'adaptive', taskCode: '...' }
  'general'       → POST /practice/adaptive { mode: 'diagnostic' }
```

---

## Migration Order

```
001_core         — identity, blueprint, questions, exams
002_engine_access — engine helpers, access
003_api          — practice sessions, dashboard
004_staff_tools  — admin, reviews, workflow
005_cases_recovery — case studies, password reset
006_exhibits_users — exhibits, MFA, user export
007_access       — plans, prices, entitlements, access codes
008_ops          — rate limiting, audit
009_bilingual    — Arabic columns, bilingual question functions
010_adaptive     — task_mastery, spaced_reviews, SM-2, next_best_action
011_study_plan   — study plans, learner profiles, error classification
012_bookmarks_notes — bookmarks, notes, domain/difficulty analytics
013_case_coach   — case study bilingual, AI coach hints, purchase restore
014_notifications_referral — notifications inbox, exam heartbeat, referral codes, coupons, streak milestones
015_certificates_snapshots — completion certificates, weekly progress snapshots
016_question_stats_v2 — question_difficulty view (measured from stored answers)
017_exam_tips    — admin-editable exam tips (8 seeded sections)
```

Migration files must not contain `BEGIN;`/`COMMIT;`: `scripts/migrate.ts` wraps each file in its own transaction.
