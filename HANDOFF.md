# HANDOFF — read this first

Exact state of LeadFlow at handoff. Any AI assistant or developer continuing this
project should read this file, then `IMPLEMENTATION_LOG.md`.

**Updated 2026-09-23:** Phase 9 is now complete — **the entire 9-phase project is done.**
Everything is built, tested, documented, and interview-ready; nothing has been deployed.

## Phase status

| Phase | Status |
|---|---|
| 1 Foundation, DB, seed, read-only UI | ✅ complete, committed |
| 2 Contacts, duplicates, opportunities, stage changes, audit | ✅ complete, committed |
| 3 Lead scoring + smart routing | ✅ complete, committed |
| 4 Automation engine, follow-ups, retries | ✅ **complete** — engine, UI, 26 integration tests, 3 demo scripts, docs |
| 5 HighLevel integration | ✅ **complete** — CrmProvider (mock + real), outbox sync, 11 integration tests, demo script, docs |
| 6 Webhooks + n8n | ✅ **complete** — 6 signed endpoints, Webhook Events UI, n8n workflow actually run in Docker, 26 tests, docs |
| 7 Appointment booking | ✅ **complete** — DST-safe slots, DB-enforced no-overlap, one booking flow (stage/workflow/confirm/reminders/notify/rescore/sync), reschedule/cancel/no-show/completed, 21 tests, docs |
| 8 Failed-automation tooling, reporting, demo page, admin login, real browser tests | ✅ **complete** — filters/bulk retry, 3 dashboard reporting queries, `/demo` scenario page, shared-password admin login (`src/proxy.ts`), a real no-JS-hang bug found and fixed, 5 Playwright browser tests, docs |
| **9 Final docs, FAILURE_STORY, deployment guide, interview prep** | ✅ **complete** — doc audit (2 stale claims found/fixed), full `README.md` rewrite with a Mermaid architecture diagram, `INTERVIEW_GUIDE.md` top-level material (2-min/5-min/20-Q&A/"what would you improve"), `FAILURE_STORY.md` (real captured demo output), `DEPLOYMENT.md`, a fresh-DB two-process web+worker verification |

## Verified at handoff (actually run)

- `npm run verify` → typecheck ✓, lint 0 warnings ✓, **225 tests passed (18 files)**, production build ✓
  (216 carried over from Phase 7 + 9 new admin-session tests).
- `npm run e2e` (Playwright, real Chromium + real Postgres) → **5/5 passed, confirmed stable across
  three consecutive full runs** — Kanban drag-and-drop, the contact intake form, Failed Automations'
  Retry Now, and the `/demo` page (create + reset). See `IMPLEMENTATION_LOG.md`, Phase 8, for the three
  real bugs this surfaced (native HTML5 DnD needing a manual mouse sequence, and two test-isolation
  bugs from unbounded same-named leftover data across repeated runs).
- **A real, previously-uninvestigated bug was found and fixed**: any `useActionState`-bound form action
  that doesn't call `redirect()` on success hangs indefinitely for a no-JavaScript submission in this
  Next.js build. Root-caused by elimination (not guesswork) and fixed in
  `src/app/actions/lead-intelligence.ts`; verified via the same raw-multipart-POST technique used since
  Phase 6. Full write-up in `IMPLEMENTATION_LOG.md`, Phase 8.
- Admin login (`ADMIN_PASSWORD`, `src/proxy.ts`) verified live: page redirect to `/login` when unset →
  set, wrong password → fast redirect with an error (not a hang), correct password → signed httpOnly
  cookie → in, Log out clears it, `/api/webhooks/*` and `/api/health` confirmed to stay reachable and
  gated by their own mechanisms instead. Restored to unset afterward so local dev stays open by default.
- `/demo` verified live end to end: created a real lead via raw HTTP (full pipeline visible in the
  timeline — duplicate check, contact, opportunity, scoring, routing, follow-up scheduling), reset, then
  confirmed via `psql` the demo-tagged row was actually gone from the database.
- Migration `0002_automation_engine.sql` applied on a **copy of real data** (Phase 4 detail — old job
  statuses renamed in place, no rows lost). Migrations `0003_webhooks_n8n.sql` (Phase 6) and
  `0004_appointments_booking.sql` (Phase 7) are additive — the latter also hand-adds a Postgres
  `EXCLUDE` constraint (drizzle-kit's schema DSL can't express one) that makes double-booking
  impossible at the database level; verified with raw SQL before any app code was written against it.
- `npm run demo:a`, `npm run demo:b`, `npm run demo:c`, `npm run demo:crm` all run to completion
  against the dev DB. Phase 7 has no dedicated demo script (not requested) but was verified live via
  two throwaway smoke-test scripts (deleted after use) — see `IMPLEMENTATION_LOG.md`, Phase 7.
- **`npm run build` caught a real bug neither typecheck nor 216 passing tests caught**: three
  appointment server actions were first written as `export const x = (...) => ...` inside a
  `"use server"` file; Next's Server Actions compiler requires a plain `async function` declaration
  for its action manifest and failed only at build time. Fixed; noted in `IMPLEMENTATION_LOG.md`,
  Phase 7, as a reminder that `npm run verify`'s build step is not redundant with typecheck/tests.
- Real two-process test (Phase 4): production web server + a separate `npm run worker` process, a lead
  created through a genuine HTTP POST to the web server, completed by the *other* process, visible on
  the dashboard the web process serves. Full write-up in `IMPLEMENTATION_LOG.md`, Phase 4.
- HighLevel API v2 docs checked directly against `marketplace.gohighlevel.com` before writing Phase 5
  and Phase 6 code (not third-party blogs, some of which repeat stale claims) — every endpoint URL and
  date checked is in `IMPLEMENTATION_LOG.md`. No real HighLevel account was used for the outbound sync
  (Phase 5) — `MOCK_MODE=true` by default, live path UNVERIFIED against a real account. The inbound
  Ed25519 webhook signature scheme (Phase 6) *is* HighLevel's real, current, fixed public key — that
  part works against a real HighLevel delivery without any configuration.
- **n8n was actually pulled, run in Docker, imported, activated, and triggered** against the real dev
  server — not just written. Found and fixed 4 real bugs in the process (wrong n8n HTTP node
  parameter, env/module sandboxing, a Set node dropping fields) — see `IMPLEMENTATION_LOG.md`, Phase 6.
  The container was removed after verification; it's not part of the ongoing dev setup.
- **Phase 9's final full run**, in order: fresh `npm run db:migrate` + `npm run db:seed`, then
  `npm run verify` (typecheck ✓, lint 0 warnings ✓, **225/225 tests, 18 files** ✓, build ✓) on the
  freshly reseeded database, then a **real two-process test repeating Phase 4's method on the
  current codebase**: `next start` (production build) on a separate port + `npm run worker` as two
  genuinely independent OS processes, a real signed HMAC webhook POST to the production server
  (`npm run webhook:send -- leads --url http://localhost:3700`), and confirmation via direct
  `psql` queries + the worker's own log timestamps that the **worker process** — not the web
  server — claimed and completed all three resulting jobs (CRM sync × 2, then the follow-up once
  its delay elapsed), with the result visible back on the web server's own contact page. Both
  extra processes were stopped and the database reseeded once more afterward.
- `npm run demo:crm` was re-run for `FAILURE_STORY.md` and initially **failed** — a real,
  reproduced fragility (not a product bug): hours of manual testing this session had left many
  unrelated jobs due, and the demo script's own job lost the race for a `WORKER_BATCH_SIZE` (5)
  batch slot. Fixed by reseeding first; documented in `DEMO_COMMANDS.md` §15 and
  `IMPLEMENTATION_LOG.md`, Phase 9, so it doesn't surprise anyone demoing after a long session.
- Audited `README.md`, `HANDOFF.md`, and `DEMO_COMMANDS.md` for stale/overclaiming statements:
  found and fixed a README status line stuck at "Phase 3 of 9" and a `DEMO_COMMANDS.md` test
  count stuck at 158 (real count: 225) — both genuinely stale, not accuracy problems with any
  technical claim.

## Phase 4 — what exists

| File | What it does |
|---|---|
| `drizzle/0002_automation_engine.sql` | job statuses, `job_attempts`, `workflow_steps`, `app_settings`, `worker_heartbeats`, `contacts.opted_out_at`, `messages.provider/subject`, jobs lease columns. **Hand-edited** to rename enum values instead of drop/recreate. |
| `src/server/queue/queue.ts` | enqueue (idempotent), atomic claim (`FOR UPDATE SKIP LOCKED`), lease-guarded complete/fail, backoff retries, abandoned-lease recovery, Retry Now, Cancel |
| `src/server/worker/runner.ts` | handler registry, `processJob`, `runOnce`, long-running `runWorker` with heartbeat |
| `scripts/worker.ts` | `npm run worker` (graceful SIGINT/SIGTERM) and `npm run worker:once` |
| `src/server/workflows/nurture.ts` | start workflow (one run per contact), follow-up handler with stop checks (reply, appointment, won/lost, opt-out, cancelled), send via provider with idempotency, schedule next step, cancel run, opt-out, edit step delay |
| `src/server/services/intake.ts` | `ingestLeadEvent` — same event twice = no duplicates (uses `webhook_events` unique key) |
| `src/server/integrations/messaging/*` | provider interface + **MOCK provider** (simulated only) + DB-stored demo failure switch |
| `src/lib/backoff.ts`, `job-errors.ts`, `followup-rules.ts` | pure logic, 18 unit tests in `tests/automation-logic.test.ts` |
| `src/server/services/contacts.ts` | `createContact` now also starts the nurture workflow (after scoring/routing, not repeated) |

## Phase 4 — now done (was the "NOT done yet" list)

1. ✅ Integration tests for queue/worker/workflow — `tests/automation.integration.test.ts` (26 tests)
2. ✅ Automations page UI — jobs, attempts, Retry Now / Cancel, failure switch, worker status, step delays, simulated messages
3. ✅ Lead page — follow-up timeline, opt-out toggle, cancel workflow
4. ✅ Failed Automations page — Retry Now button, explains non-retryable jobs
5. ✅ Demo scripts A / B / C — `npm run demo:a` / `demo:b` / `demo:c`
6. ✅ Web + separate worker process integration test — see `IMPLEMENTATION_LOG.md`, Phase 4
7. ✅ Docs for Phase 4 — `LEARNING_GUIDE.md`, `INTERVIEW_GUIDE.md`, `DEMO_COMMANDS.md`, `.env.example`, `README.md`

## Phase 5 — what exists

| File | What it does |
|---|---|
| `src/server/integrations/crm/types.ts` | `CrmProvider` interface (`upsertContact`, `upsertOpportunity`, `updateOpportunityStatus`, `getPipelines`) |
| `src/server/integrations/crm/mock-provider.ts`, `highlevel-provider.ts`, `http-client.ts`, `index.ts` | Mock (with fault injection) + real HTTP implementations, switched by `MOCK_MODE`, same pattern as Phase 4's messaging provider |
| `src/server/workflows/crm-sync.ts` | Outbox handlers: `crm.sync_contact`, `crm.sync_opportunity`, `crm.update_opportunity` (idempotent — stores and reuses `ghl_*_id`) |
| `src/app/(app)/integrations/page.tsx` (rewritten), `src/app/actions/integrations.ts`, `src/components/integrations/controls.tsx` | Test connection, sync status, demo failure switch, editable pipeline stage mapping |
| `scripts/demo-crm.ts` (`npm run demo:crm`), `tests/crm-integration.test.ts` (11 tests) | Demo + mocked-fetch/idempotency tests |

## Phase 6 — what exists

| File | What it does |
|---|---|
| `src/lib/webhook-signature.ts` | HMAC-SHA256 (website/n8n, 5-min replay window) + Ed25519 `X-GHL-Signature` (HighLevel, fixed published key) verification — pure, 13 unit tests |
| `src/server/http/webhook-route.ts` | Shared handler behind all 6 routes: size limit → signature (before any DB write) → parse → idempotency key → dispatch |
| `src/app/api/webhooks/{leads,contacts,opportunities,appointments,payments,messages}/route.ts` | Six one-line routes |
| `src/server/services/webhooks.ts`, `src/server/workflows/webhook-process.ts` | Idempotent receive + enqueue (`webhook_events` UNIQUE(source,event_id)), and the `webhook.process` job that dispatches to existing services (contacts/opportunities/messages) or two new ones (payments, appointments) |
| `src/server/services/payments.ts`, `notifications.ts` | Payment → Won + onboarding checklist (idempotent on `externalPaymentId`); SIMULATED rep notification on reply (and, since Phase 7, on appointment booked) |
| `src/app/(app)/webhooks/page.tsx` + actions/components | Webhook Events screen: payload, signature result, status, result/error, linked job, Reprocess button |
| `scripts/webhook-send.ts` (`npm run webhook:send`), `n8n/leadflow-lead-intake.json` | Signed test sender + curl examples; n8n workflow **actually run** in Docker (see IMPLEMENTATION_LOG.md for the 4 real bugs found and fixed) |
| `tests/webhook-signature.test.ts` (13), `tests/webhooks-integration.test.ts` (13) | Signature edge cases; duplicate/concurrent delivery, invalid payload, reprocess, payment→won against real Postgres |

## Phase 7 — what exists

| File | What it does |
|---|---|
| `src/lib/scheduling.ts` | DST-safe slot generation, pure, 11 tests (both 2026 US DST transitions) |
| `drizzle/0004_appointments_booking.sql` | `users` working-hours columns, `jobs.appointment_id`, and a hand-added Postgres `EXCLUDE` constraint that makes double-booking impossible at the DB level |
| `src/server/services/appointments.ts` (rewritten) | `bookAppointment()` — the one flow (stage, stop workflow, confirm, reminders, notify, rescore, CRM sync); `rescheduleAppointment`, `cancelAppointment`, `markNoShow`/`markCompleted`/`confirmAppointment`, `getAvailableSlots`; `upsertAppointmentFromWebhook` now calls `bookAppointment`/`rescheduleAppointment` — the webhook and the UI form are the same code path |
| `src/server/workflows/appointment-reminders.ts` | 24h/1h reminder job handlers — reload appointment status before sending, never send for a cancelled slot |
| `src/server/integrations/crm/*` (extended) | `CrmProvider.createAppointment()`, `crm.sync_appointment` job |
| `src/app/actions/appointments.ts`, `src/components/appointments/*`, `src/app/(app)/appointments/page.tsx` (rewritten) | Booking form (slot search + pick + book, both timezones shown), row actions (Confirm/Reschedule/Complete/No-show/Cancel) |
| `src/components/settings/working-hours-editor.tsx` | Per-rep working hours on the Settings page |
| `tests/scheduling.test.ts` (11), `tests/appointments-integration.test.ts` (10) | DST, concurrent double-booking, reminder-skipped-after-cancel, idempotent booking webhook |

## Phase 8 — what exists

| File | What it does |
|---|---|
| `src/server/queries/index.ts` (extended) | `listFailedJobs`/`listFailedJobTypes` filters; `getConversionFunnel`, `getTimeInStage` (window-function query), `getWorkflowRates` — 3 new dashboard reporting queries |
| `src/components/automations/bulk-retry.tsx` (`FailedJobsTable`) | Filters, per-row attempt history, guarded bulk retry — one client component owns all selection state |
| `src/app/(app)/dashboard/page.tsx` (extended) | Date-range filter + conversion funnel / workflow rates / time-in-stage panels |
| `src/app/(app)/demo/page.tsx`, `src/app/actions/demo.ts` | Runs a real fictional lead through the actual intake service; renders its real `audit_logs` timeline; reset deletes only `demo-live`-tagged data |
| `src/proxy.ts`, `src/lib/admin-session.ts`, `src/app/actions/admin-auth.ts`, `src/app/login/page.tsx` | Shared-password admin login — signed httpOnly cookie, `/api/webhooks/*` and `/api/health` excluded on purpose |
| `src/app/actions/lead-intelligence.ts` (fixed) | `logReplyAction`/`updateRepAction`/`saveRuleAction` now redirect on success instead of hanging for no-JS submissions |
| `playwright.config.ts`, `e2e/*.spec.ts` | 5 real-browser tests (Kanban DnD, contact form, Retry now, demo page) |
| `tests/admin-session.test.ts` (9) | Sign/verify/expiry/tamper unit tests for the login cookie |

## Phase 9 — what exists

No new application code (the brief explicitly said not to add features) — documentation only.

| File | What it does |
|---|---|
| `README.md` (full rewrite) | Mermaid architecture diagram, corrected 22-table schema reference, phase-by-phase feature summary, consolidated "Known limitations" |
| `INTERVIEW_GUIDE.md` (extended) | New top-level: 2-min pitch, 5-min walkthrough, "why each technology", 20-question quick reference, "what would you improve" — existing phase-by-phase deep dive kept intact below it |
| `FAILURE_STORY.md` (new) | Real captured `npm run demo:crm` output — simulated HighLevel outage → retry → recovery, with a reproduce-it-yourself section |
| `DEPLOYMENT.md` (new) | Step-by-step Vercel + Supabase + Railway guide, pooler settings, costs to check, explicit "won't deploy without asking" list |

## Known limitations carried over

- Admin login is one shared password for a single "admin" role, not per-user accounts — see
  `README.md`'s Security notes. Next's own docs note Proxy-level gating alone isn't a complete answer
  for Server Functions; this phase didn't add a second, per-action auth check on top of it.
- The "return inline state on error" half of the no-JS hang fix is unproven for the no-JS path itself
  (only the success/redirect path was verified) — see `IMPLEMENTATION_LOG.md`, Phase 8. The two new
  forms this phase (`/login`, `/demo`) route around this entirely by always redirecting.
- Playwright only runs Chromium, headless, no touch/mobile-viewport drag testing (the "Move to"
  dropdown fallback exists specifically because HTML5 drag-and-drop doesn't work on touch screens).
- `next.config.ts` allows server actions from `*.app.github.dev` (Codespaces) — **not tested in Codespaces yet**.
- The real `HighLevelProvider` (Phase 5) has never made a request against a live HighLevel account —
  only against a mocked `fetch` in tests. If real credentials are supplied, run `npm run demo:crm`-style
  verification against them once (with `MOCK_MODE=false`) before relying on it live.
- Phase 6's webhook endpoints expect **our own canonical payload shape** for the business data
  regardless of which signature scheme authenticated the request — a real HighLevel webhook's native
  `data` envelope (`ContactCreate`/`ContactUpdate`/etc. field names) is not mapped into it. Only the
  `X-GHL-Signature` verification itself was checked against real HighLevel docs and a real key format.
- `HighLevelProvider.createAppointment()`'s response field (`res.id`) is HighLevel's usual convention
  but was not confirmed against a real response in the Phase 5 doc-check — UNVERIFIED, flagged in code.
- Booking deliberately never calls HighLevel's own `free-slots` endpoint — our own DST-safe
  `src/lib/scheduling.ts` is the single source of truth for availability, so a meeting created directly
  in HighLevel (outside this app) would not be detected or prevented here.
- The admin login added in Phase 8 (`ADMIN_PASSWORD`) now gates the booking form, working-hours editor,
  and every other write path when it's set — see the Phase 8 section above. It's unset by default in
  this dev environment for convenience, so the app currently runs open.

## How to run

```bash
npm install
cp .env.example .env.local        # set DATABASE_URL (+ TEST_DATABASE_URL for DB tests)
docker compose up -d               # or Supabase — see README
npm run db:migrate && npm run db:seed
npm run dev                        # web app  → http://localhost:3000
npm run worker                     # worker   → separate terminal
npm run verify                     # typecheck + lint + tests + build
npm run e2e                        # Playwright browser tests (needs the dev server running)
```
