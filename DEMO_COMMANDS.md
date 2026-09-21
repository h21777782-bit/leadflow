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
**158 tests passed**, production build with every data page marked `ƒ (Dynamic)`.

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

## 8. Phase 2 — create, duplicates, edit, stage changes

Run `npm run db:seed` first so the demo data is in its original state.

### 8a. Create a new lead (happy path)
1. `/contacts` → **Add contact**
2. First name `Kiran`, Last name `Patil`, Email `kiran@patilstudio.example`,
   Phone `98901 23456`, Country `IN`, Source *Website form*, Service *Web design*, Budget `4200`
3. **Create contact** → you land on the lead page with a green "Contact created" message.
4. Point at: phone shown as `+919890123456`, opportunity in **New lead** worth $4,200,
   timeline entries *contact.created* and *opportunity.created*.

### 8b. Duplicate by email (different case)
1. **Add contact** → First name `Priya`, Email `PRIYA@SharmaDental.example`, Source any.
2. Result: warning "A contact with this email or phone already exists" → *Priya Sharma, matched on email*.
3. Click **Update this contact instead** → lands on Priya's page with "merged" message;
   timeline shows *contact.merged*. Nothing was erased.

### 8c. Duplicate by phone (different format)
Phone `098220 11234`, Country `IN` → matched on **phone** (same number as `+91 98220 11234`).

### 8d. Two different people match
Email `priya@sharmadental.example` + Phone `+1 646 555 0142` → **both** Priya Sharma and
Marcus Reid are listed, and no merge button appears.

### 8e. Validation
Leave First name empty and type Phone `123` → all errors appear at once.

### 8f. Edit + manual owner override
Lead page → **Edit contact** → change Owner → **Save changes**.
Timeline: *contact.updated* (lists changed fields) and *owner.changed* ("manual override").

### 8g. Pipeline stage changes
1. `/pipeline` → drag a card from *New lead* to *Contacted* (or use the card's **Move to** menu).
2. Open that lead → Stage history shows the new row with time and actor.
3. Drag a card to **Lost** → the reason dialog appears; the Mark as lost button is disabled until
   you type a reason. The lost reason then shows on the card.
4. Drag a **Won** card back to *Negotiation* → reason required → timeline shows *manual.override*.
5. `/activity` → the *stage.changed* entries are at the top.

### 8h. Prove it with tests
```bash
npx vitest run tests/services.integration.test.ts
```
Point at: *creates exactly ONE contact when the same lead is submitted 5 times concurrently*
and *serializes two simultaneous drags of the same card*.

## 9. Phase 3 — scoring & routing

> DEMO SCENARIO with fictional leads. Every step runs the real services and writes to the database.

### 9a. Start fresh
```bash
npm run db:migrate      # applies 0001_scoring_routing.sql if you are upgrading from Phase 2
npm run db:seed         # scores all 24 leads; routes the 4 brand-new ones with the real engine
npm run dev
```

### 9b. One-command terminal demo
```bash
npm run db:seed && npm run demo:routing
```
Prints 8 steps: new lead scored + assigned → budget change (score up, owner sticky) → reply
(Warm → Hot) → CRM lead to Daniel → Daniel unavailable (not-contacted leads move) → Neha unavailable
(new CRM lead stays Unassigned with reason) → Daniel back (waiting leads assigned) → Neha back.

### 9c. In the browser
Follow "Step-by-step live demo" in `INTERVIEW_GUIDE.md`. What to check on each screen:
- `/dashboard`: Lead temperature, Unassigned leads + reasons, rep workload, routing decisions
- lead page: Lead score panel (5 factors with reasons, score history), Ownership & routing
  (provenance, Route now if unassigned, rule-by-rule trace), Log a reply
- `/settings`: Available / Active / Capacity per rep; Edit / Add a routing rule; scoring rules explained
- `/pipeline` and `/contacts`: Hot/Warm/Cold badge with score on every lead

### 9d. Tests
```bash
npx vitest run tests/scoring.test.ts tests/routing.test.ts        # 43 pure-logic tests, no DB
npx vitest run tests/lead-intelligence.integration.test.ts         # 13 real-DB tests (needs TEST_DATABASE_URL)
npm run verify                                                     # everything + build
```

### 9e. Inspect the database directly (optional)
```sql
select first_name, lead_score, lead_band, assignment_source, unassigned_reason from contacts order by lead_score desc;
select outcome, rule_name, trigger, reason from routing_decisions order by created_at desc limit 10;
select event_type, message from audit_logs where event_type in ('lead.scored','owner.assigned','owner.reassigned','lead.unassigned') order by created_at desc limit 10;
```

## 10. Phase 4 — automation engine (job queue, worker, follow-ups)

> Every send here is `[SIMULATED]` — the mock messaging provider never contacts anyone real.

### 10a. Start the worker (separate terminal, keep it running)

```bash
npm run dev          # terminal 1 — the web app
npm run worker        # terminal 2 — the worker (polls Postgres every 2s by default)
```

A new lead's first follow-up is scheduled `FOLLOWUP_1_DELAY_SECONDS` (default **30s**) after creation —
wait ~30s after creating a lead and watch terminal 2 print `✔ workflow.send_followup … completed`.

### 10b. One-command terminal demos (no waiting — force the job due immediately)

```bash
npm run demo:a         # success: score + owner → follow-up scheduled → worker → SIMULATED send
npm run demo:b         # failure: switch → transient → job fails+retries → switch off → Retry Now → success
npm run demo:c         # cancellation: lead replies → worker → follow-up skipped, workflow stopped
```

Each prints the exact before/after state and throws if the outcome isn't what it asserts. They only
touch their own fictional lead (`demo-a-*@automation.example` etc., tag `demo-automation`) and can be
run in any order, any number of times.

### 10c. In the browser

| Page | What to point out |
|---|---|
| `/automations` | Worker online/offline (from heartbeats), job counts by status, the **demo failure switch** (mock mode only — flip it to `transient` before creating a lead to show a live failure), editable follow-up delays, workflow runs with **Cancel**, the jobs table with **Retry Now** / **Cancel** and expandable attempt history, and every outgoing message labelled `SIMULATED`. |
| `/failed-automations` | **Retry Now** per row; a job with no worker handler explains why retrying can't succeed instead of silently failing again. |
| A lead's page (e.g. after `npm run demo:a`) | New "Follow-up automation" panel: opt-out toggle, Cancel workflow, and the job/attempt-history timeline. |

### 10d. Prove it with tests

```bash
npx vitest run tests/automation.integration.test.ts   # 26 tests, real Postgres
```

Point at: *concurrent claiming by several workers never claims the same job twice*, *fails after
exactly 5 attempts, with 5 attempt rows*, *a stale worker cannot overwrite the result once its lease
has been recovered*, and *idempotency: calling the handler twice … sends exactly one message*.

### 10e. Two real, separate processes (what makes this "not a monolith")

```bash
npm run build && npm run start   # terminal 1 — production web server
npm run worker                    # terminal 2 — completely separate OS process
```

Create a lead in the browser, then watch **terminal 2** (not terminal 1) log the completed job ~30s
later. The web process only ever writes to Postgres; it never runs the job itself. This is exactly why
the worker must be deployed as its own always-on service (Railway/Render/Fly), never inside a Vercel
serverless function — see `IMPLEMENTATION_LOG.md`, Phase 4, "Deployment notes".

## 11. Phase 5 — HighLevel integration (outbox sync, mock/live provider)

> `MOCK_MODE=true` by default — nothing here contacts a real HighLevel account.

### 11a. One-command terminal demo

```bash
npm run demo:crm       # outage (503) → retry scheduled → recovery → full audit trail
```

### 11b. In the browser

1. Create any lead (`/contacts/new` or `npm run demo:a`) → open `/integrations`.
2. **Sync status** shows the contact/opportunity now counted as synced (`ghl_contact_id` /
   `ghl_opportunity_id` stored) once the worker has run the outbox job — same 30s delay pattern as the
   nurture follow-ups, or force it with `npm run worker:once`.
3. **Test connection** → calls the provider's `getPipelines()` (cheapest read) and reports pipeline/stage
   counts — works in mock mode too, so it's safe to click any time.
4. **Demo failure switch** → set to `503`, create a new lead, wait/`worker:once` → its sync job fails and
   is shown in **Recent integration calls**; switch back to `off` and it recovers on its own retry.
5. **Pipeline stage mapping** → set a HighLevel stage id against any of our 9 stages (any string works in
   mock mode) → move a lead through `/pipeline` → the corresponding `crm.update_opportunity` job carries
   that mapped id.
6. `/failed-automations` → the seeded `crm.sync_contact` job (Rohan Deshpande) now has a working **Retry
   Now** button instead of "no handler exists yet".

### 11c. Tests

```bash
npx vitest run tests/crm-integration.test.ts   # 11 tests: mocked-fetch HTTP behavior + idempotent re-sync
```

Point at: *never logs the bearer token*, *idempotent re-sync: an opportunity is created once … then
updated in place on every later sync*, and *the seeded HighLevel failure jobs … are now retryable*.

## 12. Reset before an interview

```bash
npm run db:seed        # restores the exact demo dataset
```
