# Demo Commands

Exact steps to demonstrate each completed feature live. Updated every phase.
Commands assume macOS/Linux/WSL and that you are in the project folder.

---

## 0. One-time setup

```bash
npm install
cp .env.example .env.local
# Edit .env.local → set DATABASE_URL (and TEST_DATABASE_URL for DB tests)

# Start Postgres — pick ONE:
docker compose up -d            # Option B (plain Postgres, port 5432)
# or: npx supabase start        # Option A (Supabase, port 54322)

npm run db:migrate
npm run db:seed
```

Expected seed output ends with a table: `contacts 24`, `opportunities 24`,
`appointments 10`, `jobs 10`, `audit_logs 249`.

## 1. Prove the project is healthy (30 seconds)

```bash
npm run verify
```

Shows, in order: route types generated, `tsc` clean, ESLint 0 warnings,
**31 tests passed**, production build with every data page marked `ƒ (Dynamic)`.

## 2. Run the app

```bash
npm run dev
# open http://localhost:3000  → redirects to /dashboard
```

## 3. Phase 1 walkthrough (in the browser)

| Step | Where | What to point out |
|---|---|---|
| 1 | `/dashboard` | Pipeline flow bar (open deals by stage), KPIs, lead-source table, automation health, recent activity |
| 2 | `/contacts` | 24 leads, owner, stage, next follow-up |
| 3 | Click **Priya Sharma** | Lead details: normalized phone in brackets, stage history, activity timeline, messages |
| 4 | Click **Emily Carter** | A deal in Negotiation — full stage path, completed appointment, notes |
| 5 | `/pipeline` | All 9 stages; lost cards show the lost reason |
| 6 | `/appointments` | Same meeting shown in the lead's timezone **and** the rep's timezone |
| 7 | `/automations` | Workflow runs; "stopped: appointment booked / lead responded" |
| 8 | `/failed-automations` | Seeded failures — **say out loud they are `[demo seed]` demo records** |
| 9 | `/integrations` | Mock mode badge; secrets show only Set / Not set |
| 10 | `/settings` | Reps (Liam is Unavailable on purpose) and routing rules in priority order |

## 4. Show duplicate protection at the database level

```bash
npx vitest run tests/db.integration.test.ts
```

Point at the test names: *rejects a duplicate contact by normalized email*,
*rejects the same webhook event twice*, *rejects a second message with the same
idempotency key*, *allows only one running workflow per contact*.

Optional, directly in SQL (`npm run db:studio` or `psql`):

```sql
-- Fails with: duplicate key value violates unique constraint "contacts_email_normalized_uq"
INSERT INTO contacts (first_name, lead_source, email_normalized)
VALUES ('Test', 'website_form', 'priya@sharmadental.example');
```

## 5. Show normalization (why duplicates are caught)

```bash
npx vitest run tests/normalize.test.ts tests/timezone.test.ts
```

Talking point: three different ways of typing Priya's number all become `+919822011234`;
11:00 in New York is 16:00 UTC before the DST switch and 15:00 UTC after it.

## 6. DEMO failure: database outage and recovery

> This is a **demonstration scenario** on your own machine, not a production incident.

With `npm run dev` running, in a second terminal:

```bash
curl -i http://localhost:3000/api/health        # 200 {"status":"ok", ...}

docker compose stop db                          # (Supabase: npx supabase stop)
curl -i http://localhost:3000/api/health        # 503 {"status":"degraded", ...}
# Refresh /dashboard in the browser → "This page could not load its data"

docker compose start db                         # (Supabase: npx supabase start)
curl -i http://localhost:3000/api/health        # 200 again — no app restart
```

Talking point: 503 is what an uptime monitor alerts on; the pool reconnects by itself;
in production the health response hides raw driver errors.

## 7. Show config validation

```bash
npm run env:check                                   # ✔ Environment is valid + safe summary (no secrets)
DATABASE_URL= MOCK_MODE=false npm run env:check     # ✖ lists every problem, exit code 1
```

Expected second output:

```
✖ Invalid environment configuration:
  - DATABASE_URL: DATABASE_URL is required
  - DATABASE_URL: DATABASE_URL must be a postgres:// or postgresql:// URL
  - HIGHLEVEL_PRIVATE_TOKEN: HIGHLEVEL_PRIVATE_TOKEN is required when MOCK_MODE=false
  - HIGHLEVEL_LOCATION_ID: HIGHLEVEL_LOCATION_ID is required when MOCK_MODE=false
```

## 8. Reset before an interview

```bash
npm run db:seed        # restores the exact demo dataset
```
