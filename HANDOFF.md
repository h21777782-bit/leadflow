# HANDOFF — read this first

Exact state of LeadFlow at handoff. Any AI assistant or developer continuing this
project should read this file, then `IMPLEMENTATION_LOG.md`.

**Updated 2026-09-23:** Phase 7 is now complete (appointment booking). Phase 6 (webhooks + n8n) was
also completed 2026-09-23; Phases 4 and 5 were completed 2026-09-22 — see `IMPLEMENTATION_LOG.md`.

## Phase status

| Phase | Status |
|---|---|
| 1 Foundation, DB, seed, read-only UI | ✅ complete, committed |
| 2 Contacts, duplicates, opportunities, stage changes, audit | ✅ complete, committed |
| 3 Lead scoring + smart routing | ✅ complete, committed |
| 4 Automation engine, follow-ups, retries | ✅ **complete** — engine, UI, 26 integration tests, 3 demo scripts, docs |
| 5 HighLevel integration | ✅ **complete** — CrmProvider (mock + real), outbox sync, 11 integration tests, demo script, docs |
| 6 Webhooks + n8n | ✅ **complete** — 6 signed endpoints, Webhook Events UI, n8n workflow actually run in Docker, 26 tests, docs |
| **7 Appointment booking** | ✅ **complete** — DST-safe slots, DB-enforced no-overlap, one booking flow (stage/workflow/confirm/reminders/notify/rescore/sync), reschedule/cancel/no-show/completed, 21 tests, docs |
| 8 Ops screens, reporting, demo page, auth | ⏳ not started |
| 9 Final docs, FAILURE_STORY, deployment guide | ⏳ not started |

## Verified at handoff (actually run)

- `npm run verify` → typecheck ✓, lint 0 warnings ✓, **216 tests passed (17 files)**, production build ✓
  (195 carried over from Phase 6 + 11 scheduling + 10 appointments-integration tests).
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

## Known limitations carried over

- No authentication (actions attributed to demo admin).
- No-JavaScript form fallback hangs for forms that stay on the page after saving (JS path works).
- Nothing was tested in a real browser (sandbox had none).
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
- No admin auth yet (Phase 8) means the booking form, working-hours editor, and appointment actions are
  all open to anyone who can reach the app, same as every other write path in this demo.

## How to run

```bash
npm install
cp .env.example .env.local        # set DATABASE_URL (+ TEST_DATABASE_URL for DB tests)
docker compose up -d               # or Supabase — see README
npm run db:migrate && npm run db:seed
npm run dev                        # web app  → http://localhost:3000
npm run worker                     # worker   → separate terminal
npm run verify                     # typecheck + lint + tests + build
```
