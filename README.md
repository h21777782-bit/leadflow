# LeadFlow — CRM & Sales Automation (interview demo project)

A lead-management and sales-automation system for a digital agency, built to demonstrate
CRM/automation-developer patterns: duplicate-safe intake, lead scoring, rule-based routing,
a Postgres-backed job queue with retries, a HighLevel integration layer, signed inbound
webhooks (+ an actually-run n8n workflow), DST-safe appointment booking, and reporting.

**Stack:** Next.js 16 (App Router, Turbopack) + TypeScript, Tailwind CSS v4, PostgreSQL
(Supabase-compatible) via Drizzle ORM, Vitest, Playwright.

> **Status: Phase 9 of 9 complete.** Every feature below is built, tested, and was actually
> run — not just written. Nothing has been deployed (see `DEPLOYMENT.md`). See
> `IMPLEMENTATION_LOG.md` for the phase-by-phase history, including every bug found and how it
> was fixed, and `INTERVIEW_GUIDE.md` for how to talk about all of it.

All people, companies, emails and phone numbers in the demo data are fictional. Email domains
use the reserved `.example` TLD. This is a personal portfolio project, not a client system —
see `INTERVIEW_GUIDE.md` for how to talk about it honestly.

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

For a background worker (required for follow-ups, reminders, and CRM/webhook sync to actually
run), open a second terminal: `npm run worker`.

---

## Architecture

Two always-running pieces — a request/response web app and a polling worker — coordinate
**only through Postgres**, never in-memory or over a direct connection to each other. That's
the one architectural decision everything else in this project follows from: it's what makes
the job queue, retries, and the two-process deployment (Vercel + Railway) possible at all.

```mermaid
flowchart TB
    subgraph Client["Browser"]
        UI["Pages, Kanban, forms"]
    end

    subgraph Web["Web app (request/response — Vercel-shaped)"]
        Proxy["proxy.ts — admin login gate"]
        Pages["Server components (src/server/queries)"]
        Actions["Server actions (src/app/actions)"]
        Services["Services — business rules, one transaction per change"]
        Webhooks["/api/webhooks/* — signature-verified before any DB write"]
    end

    subgraph Worker["Worker (long-running — Railway-shaped, separate process)"]
        Poll["Poll loop — SELECT ... FOR UPDATE SKIP LOCKED"]
        Handlers["Job handlers: nurture, crm-sync, webhook-process, reminders"]
    end

    subgraph DB["PostgreSQL"]
        Tables["contacts, opportunities, jobs, workflow_runs,\nmessages, appointments, webhook_events, audit_logs, ..."]
    end

    subgraph External["External systems"]
        HL["HighLevel API (CrmProvider)"]
        N8N["n8n / website (signed webhooks)"]
    end

    UI --> Proxy --> Pages
    UI --> Actions --> Services
    Services -- "enqueue job, same transaction" --> Tables
    Services --> Pages
    Pages --> Tables

    N8N -- "HMAC-signed" --> Webhooks
    HL -- "Ed25519-signed" --> Webhooks
    Webhooks -- "verify signature, then enqueue" --> Tables

    Poll -- "claim due jobs" --> Tables
    Poll --> Handlers
    Handlers -- "write results, enqueue next step" --> Tables
    Handlers -- "sync contacts/opportunities/appointments" --> HL
```

**Why a Postgres-backed job queue instead of Redis/BullMQ/SQS?** Two reasons, in order of how
much they actually mattered while building this. Practical: the web app and the worker are
separate processes (a Vercel function is killed shortly after it responds, so the worker
literally cannot live inside one), so the queue has to live somewhere both can reach — a
database, not memory. Architectural: enqueueing a job in the *same transaction* as the row
that triggered it means a contact can never exist without its follow-up job, or vice versa.
At this volume, `SELECT ... FOR UPDATE SKIP LOCKED` is a well-understood pattern and one fewer
moving part to operate than a dedicated queue product — a reasonable thing to reach for at
real scale, not needed here.

### Request flow (a typical write)

```
Browser → Server Action (thin) → Service (business rules, one transaction)
                                     │
                                     ├─ writes the row + stage_history + audit_logs
                                     └─ enqueues a job (same transaction — outbox pattern)
                                              │
                                              ▼
                              Worker polls, claims (SKIP LOCKED), runs the handler,
                              retries transient failures with jittered backoff,
                              records every attempt, updates workflow_runs
```

### Folder map

```
src/
  proxy.ts                admin-login gate (Next 16 renamed middleware.ts → proxy.js — see IMPLEMENTATION_LOG.md)
  app/(app)/…            pages: Dashboard, Contacts, Pipeline, Appointments, Automations,
                          Failed automations, Activity log, Integrations, Webhook events, Settings, Demo
  app/login/              admin sign-in page
  app/api/health         liveness + DB check (503 when DB is down)
  app/api/webhooks/      6 inbound webhook routes (thin — logic in server/http/webhook-route.ts)
  app/actions/            server actions (thin — call into server/services or server/queue)
  components/            sidebar + page-level UI (Kanban board, forms, tables)
  db/schema.ts           full database schema, 22 tables, all phases
  db/seed-data.ts        demo dataset (pure data, unit-tested)
  db/seed.ts             transactional seed routine
  lib/                   env validation (Zod), normalization, timezone, DST-safe scheduling,
                          pipeline constants, backoff, job-error classification, webhook-signature,
                          admin-session
  server/http/           shared webhook route handler (auth → size limit → parse → dispatch)
  server/queries/        read-side data access used by pages, incl. dashboard reporting
  server/queue/          job queue: enqueue, claim, complete/fail, lease-recovery, Retry Now/Cancel
  server/worker/         worker runtime: handler registry, poll loop, heartbeat
  server/workflows/      nurture (follow-ups), crm-sync (outbox), webhook-process,
                          appointment-reminders
  server/integrations/   messaging + CRM provider interfaces; mock implementations; real
                          HighLevel HTTP client
  server/services/       business rules: contacts, opportunities, scoring, routing, appointments,
                          payments, notifications — one transaction per change
scripts/                 migrate / seed / worker / demo:* / webhook:send / check-env CLIs
drizzle/                 generated SQL migrations (committed) — 5 so far, hand-edited where the
                          schema DSL can't express something (enum renames, EXCLUDE constraints)
n8n/                     importable n8n workflow JSON (actually run in Docker — see below)
tests/                   Vitest unit + real-Postgres integration tests (225 tests, 18 files)
e2e/                     Playwright browser tests (5 tests, real Chromium + real Postgres)
```

---

## What's built, phase by phase

Full detail, every bug found and fixed, and what's explicitly still unverified: `IMPLEMENTATION_LOG.md`
(newest phase first). Short version:

| Phase | What it added |
|---|---|
| 1 — Foundation | Schema, Zod-validated env, seed data, read-only UI, duplicate-safe unique indexes |
| 2 — Contacts & pipeline | Create/edit/merge with duplicate detection, Kanban stage changes, append-only audit log |
| 3 — Scoring & routing | 5-factor lead score (Hot/Warm/Cold, explained), rule-based routing with sticky ownership, row-locked concurrency |
| 4 — Automation engine | Postgres job queue (`SKIP LOCKED`), a separate long-running worker process, follow-up sequences, retries with jittered backoff, idempotent sends |
| 5 — HighLevel integration | `CrmProvider` interface (mock + real), outbox sync jobs, doc-verified endpoints, rate-limit/timeout handling |
| 6 — Webhooks + n8n | 6 signed inbound endpoints (HMAC + Ed25519), idempotent by `(source, event_id)`, an n8n workflow actually run in Docker against this app |
| 7 — Appointment booking | DST-safe availability, database-enforced no-overlap (`EXCLUDE USING gist`), one booking flow for both the UI and the webhook |
| 8 — Ops polish | Failed-automation filters/bulk-retry, dashboard reporting, a `/demo` page that runs a real lead through the real pipeline, a shared-password admin login, a real no-JS-hang bug fixed, Playwright browser tests |
| 9 — Docs & interview prep | This document (full rewrite), full `INTERVIEW_GUIDE.md`, `FAILURE_STORY.md`, `DEPLOYMENT.md`, a doc audit, and a final fresh-DB two-process verification run |

---

## Lead scoring & routing (Phase 3)

Every contact gets a score out of 100 across five factors — budget fit, service fit,
engagement, whether they've replied, appointment status — each with a plain-English reason,
banded Hot/Warm/Cold. **Missing information gets neutral partial credit, not zero** — a lead
that hasn't been contacted yet isn't penalized for not having replied; only explicit negative
evidence (a budget below the minimum, two+ unanswered attempts, a no-show) lowers a factor.

Routing checks rules in priority order, filters out reps who are inactive/on leave/at capacity,
prefers reps who actually sell that service, then picks fairly (round robin, lowest workload,
or fixed order). If nothing matches, the lead stays visibly **Unassigned** with the exact
reason — never silently given to an unsuitable rep. Ownership is **sticky**: a later change to
the lead doesn't move it, except when the current owner goes on leave and the lead hasn't been
contacted yet.

All of it runs inside a transaction with `SELECT ... FOR UPDATE` row locks (always in id order,
to avoid deadlocks) so concurrent requests can't double-assign a lead or push a rep over
capacity — proven with a real concurrent-request test (5 simultaneous leads for a rep with one
free slot → exactly one assigned, four correctly left Unassigned).

## Automation engine, retries & idempotency (Phase 4)

A lead entering the pipeline starts a **workflow run**; each follow-up step is a **job** in a
Postgres-backed queue, claimed by a separate worker process via one atomic
`UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)` — proven with 4 simulated workers
claiming concurrently and never claiming the same row twice.

- **Idempotent sends**: every outgoing message has a unique key (`wf:<runId>:<stepKey>`) with a
  UNIQUE index; a retried job checks for an existing sent row before sending again, but still
  re-runs the rest of the step (advancing the workflow) — because if it's being retried,
  something *around* the send failed, not necessarily the send itself.
- **Crash recovery**: every claim holds a lease; an abandoned job (worker died) is recovered by
  the next poll and re-queued, with an `abandoned` row in its attempt history. A stale worker
  that wakes up late and tries to complete a job it no longer holds the lease for is refused —
  the completion UPDATE has a `WHERE locked_by = me AND status = 'processing'` clause that
  matches zero rows once the job has moved on.
- **Transient vs. permanent errors**: transient (timeout, 5xx, 429) gets exponential backoff
  *with jitter* — jitter matters because a real outage failing 100 jobs at once would otherwise
  retry all 100 at the identical instant again. Permanent errors (bad recipient, no handler)
  fail immediately rather than wasting the retry budget.

## HighLevel integration (Phase 5)

Every contact/opportunity write enqueues a sync job — an **outbox pattern**, on the same queue
the follow-up engine uses. A `CrmProvider` interface has two implementations, switched by
`MOCK_MODE`: a mock (default, with a fault-injection switch for live demos) and a real
HighLevel client used only when `MOCK_MODE=false` and credentials are set — neither the
services nor the worker know which one they're talking to.

`ghl_contact_id`/`ghl_opportunity_id` are stored once and reused, so a record is never created
twice in HighLevel however many times its sync job retries. Every endpoint, field name, and
header traces back to a specific HighLevel doc URL recorded with the date checked (see
`IMPLEMENTATION_LOG.md`, Phase 5) — several third-party blog posts consulted along the way
turned out to state things that were simply wrong (e.g. claiming no upsert endpoint exists).
**No request has been made against a real HighLevel account** — this is stated plainly rather
than implied to work; see "Known limitations" below.

## Webhooks + n8n (Phase 6)

Six inbound endpoints (`/api/webhooks/{leads,contacts,opportunities,appointments,payments,messages}`).
Every request is authenticated **before anything touches the database**: our own
website/n8n traffic with HMAC-SHA256 over a timestamp + raw body (5-minute replay window,
timing-safe compare), HighLevel's traffic with Ed25519 (`X-GHL-Signature`, their real, current,
fixed published key). Idempotent by `UNIQUE(source, event_id)` — a duplicate delivery replays
the original stored result rather than reprocessing.

An importable n8n workflow (`n8n/leadflow-lead-intake.json`) was **actually pulled, run in
Docker, imported, activated, and triggered** against a real running instance of this app — not
just written and assumed to work. That surfaced 4 real configuration bugs (see
`IMPLEMENTATION_LOG.md`, Phase 6), including a wrong HTTP-node parameter name that silently
sent an empty body while still attaching a signature computed from the real payload — found by
diffing n8n's own node-type schema, not by guessing.

## Appointment booking (Phase 7)

One function, `bookAppointment()` — called by both the UI's booking form and the
`/api/webhooks/appointments` webhook, so there's structurally only one path and it can't drift.
It stages the deal, stops the nurture sequence immediately, sends a confirmation, schedules
24h/1h reminders (skipped if already past — never sent late), notifies the rep, rescores the
lead, and queues a HighLevel calendar sync.

Rep working hours are wall-clock time in the **rep's own** timezone; slots are shown in the
**lead's**. DST-safe — proven against both of 2026's actual US clock-change dates, not just
asserted. Double-booking is refused by a Postgres `EXCLUDE USING gist` constraint on
`appointments` (hand-written — Drizzle's schema DSL can't express one), the real guarantee
under concurrency, not just an application-level check — proven with a real `Promise.all` race.

## Ops tooling, demo page & admin login (Phase 8)

Failed Automations gained type/status filters, a per-row attempt-history drawer, and a guarded
bulk retry. The dashboard gained three real reporting queries: conversion funnel, workflow
success/failure rates, and average time-in-stage (a `LAG()`/`LEAD()` window-function query).

The `/demo` page runs a **real** fictional lead through the actual intake service — duplicate
check, scoring, routing, workflow — and renders that contact's real `audit_logs` timeline, not
a scripted animation; "Reset demo data" deletes only `demo-live`-tagged rows.

A simple shared-password admin login (`ADMIN_PASSWORD`, `src/proxy.ts` — this Next.js version
renamed `middleware.ts` to `proxy.js`) gates every page and internal API with a signed httpOnly
cookie. `/api/webhooks/*` and `/api/health` are deliberately excluded — HighLevel/n8n can't
hold a browser session, so they stay protected by their own signature checks instead.

A real, previously-undiagnosed bug was found and fixed this phase: any `useActionState`-bound
form that doesn't call `redirect()` on success hangs indefinitely for a no-JavaScript
submission in this Next.js build — root-caused by elimination (not guesswork), see
`IMPLEMENTATION_LOG.md`, Phase 8, for the full write-up.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build / serve |
| `npm run typecheck` | Generates Next.js route types, then `tsc --noEmit` |
| `npm run lint` | ESLint, zero warnings allowed |
| `npm test` | Unit tests + DB integration tests (DB tests skip if `TEST_DATABASE_URL` is empty) |
| `npm run e2e` | Playwright browser tests against a real running dev server + database |
| `npm run env:check` | Validate `.env.local`; prints a summary without secret values |
| `npm run verify` | typecheck → lint → test → build (run before every commit) |
| `npm run db:generate` | Create a new SQL migration after editing `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations |
| `npm run db:seed` | **Wipe** app tables and load demo data (refuses in production unless `ALLOW_DEMO_SEED=true`) |
| `npm run db:reset` | migrate + seed |
| `npm run db:studio` | Drizzle Studio (browse tables) |
| `npm run worker` | Long-running background worker (separate process — required for follow-ups/reminders/sync to actually run) |
| `npm run worker:once` | Process currently due jobs once and exit (used by the demo scripts) |
| `npm run demo:routing` | DEMO: scoring + routing through the real services with fictional leads |
| `npm run demo:a` / `demo:b` / `demo:c` | DEMO: success path / simulated failure+retry / reply stops follow-up |
| `npm run demo:crm` | DEMO: simulated HighLevel outage → retry → recovery → audit trail (see `FAILURE_STORY.md`) |
| `npm run webhook:send -- <resource>` | Signs and sends a test webhook (HMAC) to a running server; `--bad-signature` / `--expired` demo the 401 paths |

See `DEMO_COMMANDS.md` for the full command-by-command walkthrough of every phase.

---

## Environment variables

Validated at runtime by `src/lib/env.ts` (Zod). The app fails with a clear message listing every
invalid variable. Secrets are never shown in the UI. `next build` needs neither a database nor
secrets (verified).

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `TEST_DATABASE_URL` | for DB tests | Separate DB — the test suite wipes it |
| `DEMO_ACTOR_EMAIL` | no (`admin@leadflow.example`) | Every UI action is attributed to this one user — there's no per-user login, just the shared admin password below |
| `ADMIN_PASSWORD` | no | Gates every page and internal API behind one shared password (`src/proxy.ts`). Unset = app runs fully open (local dev convenience; a startup warning is logged). `/api/webhooks/*` is never gated by this |
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

---

## Database schema

22 tables, defined once in `src/db/schema.ts`, 5 migrations (`drizzle/*.sql`, committed — two
hand-edited where Drizzle's schema DSL can't express something: an enum rename, and a Postgres
`EXCLUDE USING gist` constraint). All timestamps are `timestamptz` (UTC); money is integer
whole units plus a currency code — never floating point.

| Table | Purpose | Key guarantee |
|---|---|---|
| `users` | Sales reps/admins: timezone, services, regions, availability, working hours, capacity | unique email |
| `pipeline_stages` | Stage labels, order, win probability, HighLevel stage-id mapping | |
| `contacts` | Lead record: tags, custom fields (jsonb), follow-up dates, HighLevel id | **unique normalized email, unique E.164 phone, unique `ghl_contact_id`** |
| `opportunities` | Deal: stage, status, value, owner, next action, lost reason, HighLevel id | **unique `ghl_opportunity_id`** |
| `stage_history` | Append-only log of every stage change | |
| `routing_rules` | Configurable rules: conditions (jsonb), strategy, target reps | |
| `routing_decisions` | Every assignment/reassignment/unassigned outcome with reason + rule trace | |
| `lead_scores` | Score, band (hot/warm/cold), per-factor breakdown | |
| `workflow_runs` | One run of an automation for a contact | **only one running run per (workflow, contact)** |
| `workflow_steps` | Configurable step delays per workflow | unique (workflow, step) |
| `jobs` | Postgres job queue: type, status, run_at, attempts, lease, last error | **unique idempotency key** |
| `job_attempts` | Append-only attempt history per job (outcome, error) | |
| `messages` | Every email/SMS attempt | **unique idempotency key → no double sends** |
| `appointments` | UTC start/end + the lead's IANA timezone, HighLevel id | **unique `ghl_appointment_id`, `EXCLUDE USING gist` — no overlapping non-cancelled appointment per rep, enforced by Postgres itself** |
| `webhook_events` | Every inbound webhook, signature result, linked job | **unique (source, external_event_id)** |
| `integration_calls` | Every outbound HighLevel call: status code, duration, attempt, error (never the token) | |
| `notifications` | SIMULATED in-app rep notifications (reply received, appointment booked) | |
| `payments` | Inbound payment events | **unique `external_payment_id`** |
| `onboarding_tasks` | Created once a deal is Won | |
| `app_settings` | Runtime-editable settings (demo failure switch, pipeline stage mapping) | |
| `worker_heartbeats` | Worker liveness, shown on the Automations page | |
| `audit_logs` | Append-only activity log — every automated and manual change, human-readable | |

Why unique indexes and not just "check first, then insert": two requests arriving at the same
moment can both pass an application-level check. A unique index — or, for the appointments
overlap case, a Postgres exclusion constraint — cannot be raced.

---

## Security notes

- No secrets in code; `.env*` is git-ignored except `.env.example`.
- The Integrations page shows only whether a secret is *set*, never its value (covered by a unit test).
- `/api/health` hides raw database errors in production (they can reveal hosts/ports).
- The seed refuses to run when `NODE_ENV=production` unless explicitly overridden.
- Lead detail pages validate the id format before querying.
- Every inbound webhook is signature-verified **before any database write** — HMAC-SHA256
  (our own traffic, timing-safe compare, 5-minute replay window) or Ed25519 (HighLevel).
- A simple shared-password admin login (`ADMIN_PASSWORD`, `src/proxy.ts`) gates every page and
  internal API — a signed httpOnly cookie, not a plaintext session, but still one shared
  password for a single "admin" role, not per-user accounts. `/api/webhooks/*` stays gated by
  its own signature checks instead, since HighLevel/n8n can't hold a browser session. Next's own
  docs note that Proxy-level gating alone isn't a complete answer for Server Functions — a real
  deployment would add per-user auth (e.g. Supabase Auth) and a second auth check per action.

---

## Known limitations (stated honestly)

- **No real HighLevel account has ever been used.** Every endpoint, field name and header comes
  from reading HighLevel's current official docs (URL + date recorded in `IMPLEMENTATION_LOG.md`);
  the HTTP client's own logic (timeouts, retries, classification, logging) is tested against a
  mocked `fetch`, not a live account. The inbound Ed25519 webhook signature *is* HighLevel's
  real, current, fixed public key, so that specific path works against a genuine delivery today.
- **HighLevel's native webhook payload shape isn't mapped.** Every endpoint expects LeadFlow's
  own canonical field names regardless of which signature scheme authenticated the request —
  building a mapping layer for HighLevel's real event envelopes wasn't asked for and would have
  been speculative, unverified code.
- **The admin login is one shared password**, not per-user accounts, and doesn't add a
  second, per-Server-Function auth check on top of the page-level gate (see Security notes).
- **A no-JS form hang fix has an unproven half.** Forms that redirect on success are fixed and
  verified; the "return inline state on error" half of that same pattern was never actually
  exercised by a no-JS request. The two newest forms (`/login`, `/demo`) route around this by
  always redirecting instead.
- **Playwright covers Chromium only, headless, no touch/mobile drag testing** — the Kanban
  board's own "Move to" dropdown exists specifically because HTML5 drag-and-drop doesn't work
  on touch screens.
- **Nothing has been deployed.** `DEPLOYMENT.md` documents the intended Vercel + Supabase +
  Railway split (and why the worker specifically cannot run on Vercel) but no deployment has
  actually happened yet.

For the full, phase-by-phase list of what was verified live versus only unit/integration
tested, see `IMPLEMENTATION_LOG.md` — every phase ends with an honest "not verified this
phase" section rather than implying more coverage than exists.
