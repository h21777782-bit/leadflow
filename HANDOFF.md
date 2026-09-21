# HANDOFF — read this first

Exact state of LeadFlow at handoff. Any AI assistant or developer continuing this
project should read this file, then `IMPLEMENTATION_LOG.md`.

**Updated 2026-09-22:** Phases 4 and 5 are now complete (Phase 4 was "core built,
UI/tests/demos/docs not done"; Phase 5 was not started — see `IMPLEMENTATION_LOG.md` for both).

## Phase status

| Phase | Status |
|---|---|
| 1 Foundation, DB, seed, read-only UI | ✅ complete, committed |
| 2 Contacts, duplicates, opportunities, stage changes, audit | ✅ complete, committed |
| 3 Lead scoring + smart routing | ✅ complete, committed |
| 4 Automation engine, follow-ups, retries | ✅ **complete** — engine, UI, 26 integration tests, 3 demo scripts, docs |
| **5 HighLevel integration** | ✅ **complete** — CrmProvider (mock + real), outbox sync, 11 integration tests, demo script, docs |
| 6 Webhooks + n8n | ⏳ not started |
| 7 Appointment booking | ⏳ not started |
| 8 Ops screens, reporting, demo page, auth | ⏳ not started |
| 9 Final docs, FAILURE_STORY, deployment guide | ⏳ not started |

## Verified at handoff (actually run)

- `npm run verify` → typecheck ✓, lint 0 warnings ✓, **169 tests passed (13 files)**, production build ✓
  (158 carried over from Phase 4 + 11 new CRM integration tests).
- Migration `0002_automation_engine.sql` applied on a **copy of real data**: old job statuses were
  renamed in place (`dead`→`failed`, `retrying`→`retry_scheduled`, `running`→`processing`,
  `succeeded`→`completed`), no rows lost. Drizzle reports no schema drift. **No new migration was
  needed for Phase 5** — `ghl_contact_id`, `ghl_opportunity_id`, `ghl_stage_id` and `integration_calls`
  were already in the Phase 1 schema, anticipating this phase.
- `npm run demo:a`, `npm run demo:b`, `npm run demo:c`, `npm run demo:crm` all run to completion
  against the dev DB.
- Real two-process test (Phase 4): production web server + a separate `npm run worker` process, a lead
  created through a genuine HTTP POST to the web server, completed by the *other* process, visible on
  the dashboard the web process serves. Full write-up in `IMPLEMENTATION_LOG.md`, Phase 4.
- HighLevel API v2 docs checked directly against `marketplace.gohighlevel.com` before writing Phase 5
  code (not third-party blogs, some of which repeat stale claims) — every endpoint URL and date checked
  is in `IMPLEMENTATION_LOG.md`, Phase 5. No real HighLevel account was used — `MOCK_MODE=true` by
  default, and the live path is UNVERIFIED against a real account (see that section's honest caveats).

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

## Known limitations carried over

- No authentication (actions attributed to demo admin).
- No-JavaScript form fallback hangs for forms that stay on the page after saving (JS path works).
- Nothing was tested in a real browser (sandbox had none).
- `next.config.ts` allows server actions from `*.app.github.dev` (Codespaces) — **not tested in Codespaces yet**.
- The real `HighLevelProvider` (Phase 5) has never made a request against a live HighLevel account —
  only against a mocked `fetch` in tests. If real credentials are supplied, run `npm run demo:crm`-style
  verification against them once (with `MOCK_MODE=false`) before relying on it live.

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
