# LeadFlow — AI Lead Management & Sales Automation (demo project)

A lead-management and sales-automation system for a digital agency, built as an
interview demonstration project. Stack: **Next.js 16 (App Router) + TypeScript,
Tailwind CSS v4, PostgreSQL (Supabase-compatible) via Drizzle ORM, Vitest.**
HighLevel and n8n integrations are added in later phases.

> **Status: Phase 8 of 9 complete** — contacts with duplicate detection, opportunities, Kanban,
> audit log, lead scoring and rule-based routing, a Postgres-backed automation engine and worker,
> a HighLevel integration layer, signed inbound webhooks + n8n, DST-safe appointment booking, and
> (Phase 8) failed-automation tooling, dashboard reporting, a `/demo` scenario page, a simple admin
> login, and real Playwright browser tests. Only Phase 9 (docs polish, deployment guide) remains.
> See `IMPLEMENTATION_LOG.md` for what is done and what remains.

All people, companies, emails and phone numbers in the demo data are fictional.
Email domains use the reserved `.example` TLD.

---

## Quick start

Requirements: **Node.js 20.9+** (tested on Node 22) and **PostgreSQL 14+** (tested on 16).

```bash
npm install
cp .env.example .env.local          # then edit DATABASE_URL (see below)
npm run db:migrate                  # create tables
npm run db:seed                     # load 24 demo leads (wipes app data!)
npm run dev                         # http://localhost:3000
```

### Getting a local Postgres

**Option A — Supabase CLI** (needs Docker):

```bash
npx supabase init
npx supabase start                  # prints the DB URL, usually port 54322
# DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

**Option B — plain Postgres in Docker** (`docker-compose.yml` included):

```bash
docker compose up -d
# DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/leadflow
# TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/leadflow_test
```

**Option C — Supabase cloud**: use the project's connection string
(Project Settings → Database). Use a separate database for `TEST_DATABASE_URL`.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build / serve |
| `npm run typecheck` | Generates Next.js route types, then `tsc --noEmit` |
| `npm run lint` | ESLint, zero warnings allowed |
| `npm test` | Unit tests + DB integration tests (DB tests skip if `TEST_DATABASE_URL` is empty) |
| `npm run e2e` | Playwright browser tests (Kanban drag-drop, forms, Retry now, `/demo`) against a real running dev server + database |
| `npm run env:check` | Validate `.env.local`; prints a summary without secret values |
| `npm run verify` | typecheck → lint → test → build (run before every commit) |
| `npm run db:generate` | Create a new SQL migration after editing `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations |
| `npm run db:seed` | **Wipe** app tables and load demo data (refuses in production unless `ALLOW_DEMO_SEED=true`) |
| `npm run db:reset` | migrate + seed |
| `npm run db:studio` | Drizzle Studio (browse tables) |
| `npm run demo:routing` | DEMO SCENARIO: runs scoring + routing through the real services with fictional leads |
| `npm run worker` | Long-running background worker (separate process — required for follow-ups to send) |
| `npm run worker:once` | Process currently due jobs once and exit (used by the demo scripts) |
| `npm run demo:a` | DEMO: success path — new lead → scored/routed → follow-up → worker → simulated send |
| `npm run demo:b` | DEMO: simulated failure → retry → recovery (proves exactly one message despite the failure) |
| `npm run demo:c` | DEMO: lead replies → follow-up skipped, workflow stopped |
| `npm run demo:crm` | DEMO: simulated HighLevel outage (503) → retry → recovery → full audit trail |
| `npm run webhook:send -- <resource>` | Signs and sends a test webhook (HMAC) to a running server; `--bad-signature` / `--expired` demo the 401 paths |

---

## Environment variables

Validated at runtime by `src/lib/env.ts` (Zod). The app fails with a clear
message listing every invalid variable. Secrets are never shown in the UI.
`next build` needs neither a database nor secrets (verified).

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `TEST_DATABASE_URL` | for DB tests | Separate DB — the test suite wipes it |
| `DEMO_ACTOR_EMAIL` | no (`admin@leadflow.example`) | Every UI action is attributed to this one user, regardless of who's signed in (there's no per-person login, just the shared admin password below) |
| `ADMIN_PASSWORD` | no | Gates every page and internal API behind one shared password (`src/proxy.ts`). Unset = app runs fully open (local dev only; a startup warning is logged). `/api/webhooks/*` is never gated by this — it's protected by its own signature checks instead |
| `APP_TIMEZONE` | no (`Asia/Kolkata`) | Timezone used to display times in the UI |
| `DEFAULT_CURRENCY` | no (`USD`) | |
| `MOCK_MODE` | no (`true`) | `true` = HighLevel calls go to the isolated mock provider |
| `HIGHLEVEL_PRIVATE_TOKEN` | when `MOCK_MODE=false` | Private Integration token (sub-account level) |
| `HIGHLEVEL_LOCATION_ID` | when `MOCK_MODE=false` | Sub-account (location) id — ignored by the mock provider |
| `HIGHLEVEL_PIPELINE_ID` | when `MOCK_MODE=false` | The single pipeline opportunities sync into |
| `HIGHLEVEL_CALENDAR_ID` | when `MOCK_MODE=false` | The calendar appointments sync into (`crm.sync_appointment` job) |
| `HIGHLEVEL_API_BASE_URL` | no | Defaults to `https://services.leadconnectorhq.com` |
| `HIGHLEVEL_API_VERSION` | no | Defaults to `v3` (sent as the `Version` header) — see `IMPLEMENTATION_LOG.md`, Phase 5, for the doc-check behind this default |
| `HIGHLEVEL_HTTP_TIMEOUT_MS` | no (`10000`) | Real HighLevel calls are aborted and treated as a transient failure past this |
| `HIGHLEVEL_WEBHOOK_PUBLIC_KEY` | no | Ed25519 key for `X-GHL-Signature`; defaults to HighLevel's own fixed, published key (see `IMPLEMENTATION_LOG.md`, Phase 6) — set this only to test with a different keypair |
| `WEBHOOK_SIGNING_SECRET` | for `/api/webhooks/*` (website/n8n) | HMAC-SHA256 secret; generate with `openssl rand -hex 32`. Required for the HMAC path — HighLevel's `X-GHL-Signature` path doesn't need it |
| `FOLLOWUP_1_DELAY_SECONDS` | no (`30`) | Delay before the first follow-up (kept short for demos) |
| `JOB_MAX_ATTEMPTS` | no (`5`) | Retries before a job is marked `failed` |
| `RETRY_BASE_DELAY_SECONDS` / `RETRY_MAX_DELAY_SECONDS` | no (`15` / `3600`) | Exponential backoff bounds |
| `JOB_LEASE_SECONDS` | no (`60`) | How long a claimed job is protected before it's considered abandoned |
| `WORKER_POLL_MS` | no (`2000`) | How often the worker checks for due jobs when idle |
| `WORKER_BATCH_SIZE` | no (`5`) | Jobs claimed per poll |
| `DATABASE_PREPARE` | no (`true`) | Set `false` on Supabase's transaction pooler (port 6543), which doesn't support prepared statements |

The HighLevel field names and endpoints were checked against the official docs before Phase 5
was written (see `IMPLEMENTATION_LOG.md`) — no real API call has been made against a live account yet.

---

## Architecture (current)

```
Browser ──► pages (server components) ──► src/server/queries   (reads)
   │
   └──► forms / Kanban ──► src/app/actions (server actions, thin)
                                  │
                                  ▼
                          src/server/services      (business rules, writes)
                          contacts.ts  opportunities.ts  audit.ts
                                  │  one transaction per change:
                                  ▼  row + stage_history + audit_logs
                          src/db (Drizzle) ──► PostgreSQL
```

Built as of Phase 4: `contacts.created` (and intake events) also start a **workflow run** →
one **job** per follow-up step in a Postgres-backed queue → a **separate worker process**
(`npm run worker`, not part of the web app) claims due jobs with `SKIP LOCKED`, runs the
`new_lead_nurture` handler, retries transient failures with backoff, and stops on reply /
appointment / won / lost / opt-out / manual cancel. Messaging is a `MessagingProvider`
interface with only a `MockMessagingProvider` implementation.

Built as of Phase 5: every contact/opportunity write also enqueues an **outbox job**
(`crm.sync_contact`, `crm.sync_opportunity`, `crm.update_opportunity`) through the same
queue and worker. A `CrmProvider` interface has two implementations — `MockCrmProvider`
(default, `MOCK_MODE=true`, with a DEMO fault-injection switch on the Integrations page) and
`HighLevelProvider` (real HTTP calls, only used when `MOCK_MODE=false` and credentials are
set). `ghl_contact_id`/`ghl_opportunity_id` are stored once and reused, so a record is never
created twice in HighLevel however many times its sync job retries.

```
Web app (Vercel-shaped, request/response only)      Worker (Railway-shaped, always-on)
   │ writes jobs                                        │ polls Postgres every WORKER_POLL_MS
   ▼                                                     ▼
                    PostgreSQL: jobs, job_attempts, workflow_runs, messages
```

The worker cannot run inside a Vercel serverless function — those are killed shortly after
each response, and the worker is an infinite poll loop. See `IMPLEMENTATION_LOG.md` (Phase 4,
"Deployment notes") for the Vercel/Supabase/Railway split actually exercised locally as two
separate OS processes; the full step-by-step deployment guide is Phase 9's `DEPLOYMENT.md`
(nothing has been deployed yet).

Built as of Phase 6: `/api/webhooks/{leads,contacts,opportunities,appointments,payments,messages}`
authenticate every request (HMAC-SHA256 for website/n8n, Ed25519 `X-GHL-Signature` for HighLevel)
**before touching the database at all**, then either call an existing service directly (`leads` →
`ingestLeadEvent`, already idempotent) or enqueue a `webhook.process` job through the same Phase 4
queue (the other five resource types) and return `202` immediately. `webhook_events` is the
idempotency + audit record either way — `UNIQUE(source, event_id)` means the same delivery twice is
a no-op that replays the original result. An importable n8n workflow
(`n8n/leadflow-lead-intake.json`) was built and **actually run** against a local n8n in Docker,
signing and posting to a real running instance of this app — see `IMPLEMENTATION_LOG.md`, Phase 6.

Built as of Phase 7: appointment booking is one function, `bookAppointment()` — the UI's booking
form and the `/api/webhooks/appointments` webhook both call it, so a lead's stage, follow-ups,
confirmation message, 24h/1h reminder jobs, rep notification, score, and HighLevel calendar sync
all happen together, never partially. Rep working hours are wall-clock time in the **rep's own**
timezone; slots are generated DST-safe (built on Phase 1's `src/lib/timezone.ts`, not a new date
library) and shown in the **lead's** timezone. Double-booking is impossible even under
concurrency — not just checked in application code, but refused by a Postgres `EXCLUDE` constraint
on `appointments`, verified with a real concurrent-request test.

Built as of Phase 8: `src/proxy.ts` (this Next.js version renamed `middleware.ts` → `proxy.js` — see
`IMPLEMENTATION_LOG.md`) gates every page behind a single shared admin password, excluding
`/api/webhooks/*` and `/api/health`, which stay protected by their own mechanisms instead. The
`/demo` page runs a real fictional lead through the actual intake service and renders its real
`audit_logs` timeline — not a scripted animation. A no-JS form hang bug (any `useActionState` form
that doesn't `redirect()` on success hung indefinitely for a plain-HTML-form submission) was
root-caused by elimination and fixed. `e2e/*.spec.ts` (Playwright) cover the Kanban board's native
HTML5 drag-and-drop, the contact form, Failed Automations' Retry Now, and the demo page, against a
real browser and a real database.

Planned (Phase 9): a full README/architecture rewrite, `INTERVIEW_GUIDE.md`'s 2-/5-minute
walkthroughs, `FAILURE_STORY.md`, and `DEPLOYMENT.md`.

### Folder map

```
src/
  proxy.ts                admin-login gate (Next 16's middleware → proxy rename) — excludes webhooks + health
  app/(app)/…            pages (Dashboard, Contacts, Lead details, Pipeline, Automations, Failed automations, Demo, …)
  app/login/              admin sign-in page
  app/api/health         liveness + DB check (503 when DB is down)
  app/api/webhooks/      6 inbound webhook routes (thin — logic lives in server/http/webhook-route.ts)
  components/            sidebar + small UI primitives
  db/schema.ts           full database schema (all phases)
  db/seed-data.ts        demo dataset (pure data, unit-tested)
  db/seed.ts             transactional seed routine
  lib/                   env validation, normalization, timezone, scheduling (DST-safe slots), pipeline constants, backoff, job-errors, webhook-signature, admin-session
  server/http/           shared webhook route handler (auth, size limit, dispatch) behind app/api/webhooks/*
  server/queries/        read-side data access used by pages, incl. dashboard reporting (Phase 8)
  server/queue/          job queue (enqueue, claim, complete/fail, recovery)
  server/worker/         worker runtime (handler registry, poll loop)
  server/workflows/      nurture (follow-up), crm-sync (outbox), webhook-process, and appointment-reminders workflows
  server/integrations/   messaging + CRM provider interfaces, mock implementations, real HighLevel client
  server/services/       business rules, incl. payments (payment → won), appointments, notifications (Phase 6)
scripts/                 migrate / seed / worker / demo / webhook:send CLIs
drizzle/                 generated SQL migrations (committed)
n8n/                     importable n8n workflow JSON
tests/                   Vitest unit + DB integration tests
e2e/                     Playwright browser tests (real Chromium + real database)
```

---

## Database schema

16 tables, defined once in `src/db/schema.ts`. All timestamps are `timestamptz`
(UTC); money is integer whole units plus currency code.

| Table | Purpose | Key guarantees |
|---|---|---|
| `users` | Sales reps / admins: timezone, services, regions, availability, capacity | unique email |
| `pipeline_stages` | Stage labels, order, win probability, HighLevel stage-id mapping | |
| `contacts` | Lead record incl. tags, custom fields (jsonb), follow-up dates | **unique normalized email, unique E.164 phone** |
| `opportunities` | Deal: stage, status, value, owner, next action, lost reason | |
| `stage_history` | Append-only log of every stage change | |
| `routing_rules` | Configurable rules: conditions (jsonb), strategy, target reps | |
| `routing_decisions` | Every assignment / reassignment / unassigned outcome with reason + rule trace | |
| `lead_scores` | Score, band (hot/warm/cold), per-factor breakdown | |
| `workflow_runs` | One run of an automation for a contact | **only one running run per (workflow, contact)** |
| `jobs` | Postgres job queue: status, run_at, attempts, last_error | **unique idempotency key** |
| `messages` | Every email/SMS attempt | **unique idempotency key → no double sends** |
| `appointments` | UTC start/end + the lead's IANA timezone | |
| `webhook_events` | Every inbound webhook | **unique (source, external_event_id)** |
| `integration_calls` | Every outbound API call: status code, duration, attempt, error | |
| `audit_logs` | Append-only activity log | |
| `payments`, `onboarding_tasks` | Won → paid → onboarding | unique external payment id |

Why unique indexes and not just "check first, then insert": two requests arriving
at the same moment can both pass an application-level check. A unique index
cannot be raced.

---

## Security notes (current)

- No secrets in code; `.env*` is git-ignored except `.env.example`.
- The Integrations page shows only whether a secret is *set*, never its value
  (covered by a unit test).
- `/api/health` hides raw database errors in production (they can reveal hosts/ports).
- The seed refuses to run when `NODE_ENV=production` unless explicitly overridden.
- Lead details validates the id format before querying.
- A simple shared-password admin login (`ADMIN_PASSWORD`, `src/proxy.ts`) gates every page and
  internal API — a signed httpOnly cookie, not a plaintext session, but still a single shared
  password for one "admin" role, not per-user accounts. `/api/webhooks/*` stays gated by its own
  HMAC/Ed25519 signature checks instead, since HighLevel/n8n can't hold a browser session. A real
  deployment would replace this with per-user auth (e.g. Supabase Auth).

Webhook signatures, idempotency, retries, the HighLevel integration layer and
n8n are documented as each phase lands.
