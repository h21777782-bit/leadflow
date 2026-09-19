# LeadFlow — AI Lead Management & Sales Automation (demo project)

A lead-management and sales-automation system for a digital agency, built as an
interview demonstration project. Stack: **Next.js 16 (App Router) + TypeScript,
Tailwind CSS v4, PostgreSQL (Supabase-compatible) via Drizzle ORM, Vitest.**
HighLevel and n8n integrations are added in later phases.

> **Status: Phase 1 of 9 complete** — foundation, database, demo data, read-only UI.
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
| `npm run env:check` | Validate `.env.local`; prints a summary without secret values |
| `npm run verify` | typecheck → lint → test → build (run before every commit) |
| `npm run db:generate` | Create a new SQL migration after editing `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations |
| `npm run db:seed` | **Wipe** app tables and load demo data (refuses in production unless `ALLOW_DEMO_SEED=true`) |
| `npm run db:reset` | migrate + seed |
| `npm run db:studio` | Drizzle Studio (browse tables) |

---

## Environment variables

Validated at runtime by `src/lib/env.ts` (Zod). The app fails with a clear
message listing every invalid variable. Secrets are never shown in the UI.
`next build` needs neither a database nor secrets (verified).

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `TEST_DATABASE_URL` | for DB tests | Separate DB — the test suite wipes it |
| `APP_TIMEZONE` | no (`Asia/Kolkata`) | Timezone used to display times in the UI |
| `DEFAULT_CURRENCY` | no (`USD`) | |
| `MOCK_MODE` | no (`true`) | `true` = HighLevel calls go to the isolated mock provider |
| `HIGHLEVEL_PRIVATE_TOKEN` | when `MOCK_MODE=false` | Private Integration token (sub-account level) |
| `HIGHLEVEL_LOCATION_ID` | when `MOCK_MODE=false` | Sub-account (location) id |
| `HIGHLEVEL_PIPELINE_ID`, `HIGHLEVEL_CALENDAR_ID` | later phases | |
| `HIGHLEVEL_API_BASE_URL` | no | Defaults to `https://services.leadconnectorhq.com` |
| `HIGHLEVEL_API_VERSION` | no | Defaults to `2021-07-28` (sent as the `Version` header) |
| `HIGHLEVEL_WEBHOOK_PUBLIC_KEY` | later phases | Ed25519 key for `X-GHL-Signature` verification |
| `WEBHOOK_SIGNING_SECRET` | later phases | HMAC secret for website / n8n webhooks |

The HighLevel values are re-verified against the official docs in Phase 5,
before any real API call is written.

---

## Architecture (current)

```
Browser ──► Next.js server components (pages)
                 │
                 ▼
         src/server/queries   ← all read SQL lives here
                 │
                 ▼
         src/db (Drizzle) ──► PostgreSQL
```

Planned (later phases): webhook routes → `webhook_events` (dedupe) → `jobs`
table (Postgres queue) → worker → routing / scoring / follow-ups → `CrmProvider`
interface → Mock or HighLevel provider.

### Folder map

```
src/
  app/(app)/…            pages (Dashboard, Contacts, Lead details, Pipeline, …)
  app/api/health         liveness + DB check (503 when DB is down)
  components/            sidebar + small UI primitives
  db/schema.ts           full database schema (all phases)
  db/seed-data.ts        demo dataset (pure data, unit-tested)
  db/seed.ts             transactional seed routine
  lib/                   env validation, normalization, timezone, pipeline constants
  server/queries/        read-side data access used by pages
scripts/                 migrate / seed CLIs
drizzle/                 generated SQL migrations (committed)
tests/                   Vitest unit + DB integration tests
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
- No authentication yet — this is a local demo. A real deployment would put the
  app behind auth (e.g. Supabase Auth) and restrict admin routes.

Webhook signatures, idempotency, retries, the HighLevel integration layer and
n8n are documented as each phase lands.
