# LeadFlow — Prompts for the remaining work

Use these one at a time, in order. Send the next prompt only after the previous
phase's completion report looks right. Works best in **Claude Code** (it can run
the app, database and tests on your machine or in a Codespace).

---

## Prompt 0 — Start a new session (use first, every new chat)

```
I am continuing my LeadFlow project (Next.js 16 + TypeScript + Tailwind + Drizzle + PostgreSQL), an interview demo for an Automation Developer role.
Read HANDOFF.md, then IMPLEMENTATION_LOG.md, README.md and package.json. Do not rebuild anything that already works.
Start Postgres (docker compose up -d), run npm install, npm run db:migrate, npm run db:seed and npm run verify, and tell me the actual results before changing code.
Rules for the whole project: never claim something works unless you ran it; label all demo data and simulated failures clearly; never invent client projects or production incidents; never deploy or buy anything without asking me.
Reply with a short status and wait for my next instruction.
```

---

## Prompt 1 — Finish Phase 4

```
Finish Phase 4 of LeadFlow. The core is already built and verified (see HANDOFF.md): queue, worker, nurture workflow, intake, mock messaging provider with failure switch, 18 unit tests. Do not rewrite it — extend and test it.

1. Integration tests (real Postgres, TEST_DATABASE_URL): workflow created with first follow-up at the configured delay; same lead event twice and 5 concurrently → 1 contact, 1 opportunity, 1 run, 1 job; concurrent claiming by several workers → no job claimed twice; follow-up chain 1→2→3 with 1-day and 3-day delays then run completed; every stop condition (reply, appointment booked, won, lost, opt-out, manual cancel) records the correct reason; transient failure → retry inside the backoff window; 5 attempts → failed with 5 attempt rows; permanent error → failed after 1 attempt; Retry Now → completes; exactly one message per step; expired lease → recovered; stale worker cannot overwrite the result; worker shuts down gracefully.
2. Automations page: worker online/offline from heartbeats, job counts per status, jobs table with attempt history, last error and next retry time, working Retry Now and Cancel buttons, workflow runs with Cancel, editable follow-up step delays, DEMO failure switch (off / transient / permanent, only in MOCK_MODE), outgoing mock messages labelled SIMULATED.
3. Lead page: follow-up timeline (jobs + attempts), opt-out toggle, cancel workflow button.
4. Failed Automations page: Retry Now button on eligible jobs; explain why a job is not retryable (e.g. no handler yet for HighLevel jobs).
5. Repeatable demo scripts touching only leads tagged demo-automation:
   npm run demo:a — success: new lead → score + owner → follow-up scheduled → worker → completed + simulated message + activity.
   npm run demo:b — failure: switch transient → job fails, error + retry time shown → switch off → Retry Now → success → prove only 1 message exists.
   npm run demo:c — cancellation: lead with pending follow-up → log reply → worker → follow-up skipped with reason "Lead replied".
6. Real local integration test: run the production web server AND a separate `npm run worker` process together, create a lead through the app, wait, and confirm the job completed and the dashboard shows it.
7. Update IMPLEMENTATION_LOG.md, LEARNING_GUIDE.md (Hinglish), INTERVIEW_GUIDE.md, DEMO_COMMANDS.md, .env.example, and add deployment notes (Vercel = web, Supabase = DB with pooler settings, Railway = worker). Explain why the worker cannot run inside a Vercel serverless function. Do not deploy.
8. Run typecheck, lint, all tests, migrations, build. Fix failures. Commit.

Stop after Phase 4. Report: what works, exact web + worker commands, real test/build results, blockers, and a 5-minute interview demo script.
```

---

## Prompt 2 — Phase 5: HighLevel integration

```
LeadFlow Phase 5: HighLevel integration layer. Continue the existing project; do not rebuild.

1. Before writing any endpoint, check the current official HighLevel API v2 documentation (base URL, Version header, Private Integration Token auth, locationId, contacts upsert, duplicate search, opportunities create/update, pipelines, calendar free slots, create appointment, rate limits). Record each doc URL and the date checked in IMPLEMENTATION_LOG.md. Do not invent endpoints.
2. Create a CrmProvider interface with two implementations:
   - MockCrmProvider: isolated, with DEMO fault injection (429 with Retry-After, 503, timeout, 401) controlled from app_settings.
   - HighLevelProvider: real HTTP calls using env credentials only.
   Switch with MOCK_MODE. No mock responses anywhere outside the integration layer.
3. HTTP client: timeouts, 429 handling that respects Retry-After and rate-limit headers, transient vs permanent classification, and logging every call to integration_calls without ever logging tokens.
4. Sync through the existing job queue (outbox pattern): crm.sync_contact, crm.sync_opportunity, crm.update_stage, enqueued from the existing services after commit. Idempotent: store ghl_* ids and never create a record twice.
5. Configurable pipeline stage mapping (our stages ↔ HighLevel stage ids).
6. Integrations page: Test connection button, recent calls with status codes, fault injection switch (mock mode only).
7. The seeded HighLevel failure jobs must become retryable with a real handler.
8. Tests with mocked fetch: success, 429 then backoff, 503 then recovery, 401 permanent, timeout, idempotent re-sync. Real mode is tested only if I give credentials; otherwise mark it UNVERIFIED.
9. Demo script: simulated HighLevel outage → retries → recovery → audit trail. Label it DEMO.
10. Update all docs and .env.example. Run typecheck, lint, tests, build. Commit. Stop after Phase 5 with an honest completion report.
```

---

## Prompt 3 — Phase 6: webhooks + n8n

```
LeadFlow Phase 6: webhooks and n8n. Continue the existing project; do not rebuild.

1. Endpoints: POST /api/webhooks/leads, /contacts, /opportunities, /appointments, /payments, /messages (inbound reply).
2. Security:
   - Website/n8n: HMAC-SHA256 over timestamp + raw body, 5-minute replay window, timing-safe comparison.
   - HighLevel: verify X-GHL-Signature (Ed25519) per the current official docs.
   - Body size limit. Never log secrets.
3. Idempotency through webhook_events UNIQUE(source, event_id). A duplicate returns the original result.
4. Acknowledge fast (202) and do heavy work through jobs. Clear errors: 400 with field errors, 401 bad or expired signature, 413 too large, 422 unprocessable.
5. Reuse existing services: lead → ingestLeadEvent; inbound reply → stops follow-ups; payment received → deal Won + onboarding tasks + audit.
6. Sales notification when an assigned lead replies (mock notification channel stored in the DB, clearly labelled).
7. Webhook Events screen: payload, signature result, status, result, errors, and a Reprocess button for failed events.
8. n8n: importable workflow JSON (Webhook → validate → sign HMAC → HTTP Request to /api/webhooks/leads → IF success/fail → notification). Import it into a local n8n (Docker) and run it. If that cannot be run, say so and mark it UNVERIFIED.
9. npm run webhook:send script that signs and sends test events, plus curl examples.
10. Tests: valid, invalid, and expired signatures; duplicate delivery; invalid payload; concurrent duplicates; payment → won.
11. Update docs. Run typecheck, lint, tests, build. Commit. Stop after Phase 6 with an honest report.
```

---

## Prompt 4 — Phase 7: appointments

```
LeadFlow Phase 7: appointment booking. Continue the existing project; do not rebuild.

1. Rep working hours in the rep's own timezone. Available slots shown in the lead's timezone. DST-safe. Store everything in UTC.
2. Booking must prevent double-booking under concurrency (row lock or exclusion constraint). Prove it with a concurrent test.
3. On booking, in one flow:
   - stage → Appointment booked via the existing changeStage()
   - stop the nurture follow-ups with a reason
   - mock confirmation message
   - reminder jobs at 24h and 1h before
   - notify the assigned rep
   - rescore the lead
   - audit everything
4. Reschedule, cancel, no-show, and completed. Reminders are cancelled or moved accordingly, and never sent for a cancelled slot.
5. HighLevel calendar sync through the Phase 5 provider and the job queue. The appointment webhook reuses the same service.
6. Appointments page: booking form, list, both timezones shown.
7. Tests: timezone and DST cases, double-booking race, reminder skipped after cancel, idempotent booking webhook.
8. Update docs. Run typecheck, lint, tests, build. Commit. Stop after Phase 7 with an honest report.
```

---

## Prompt 5 — Phase 8: operations, reporting, demo mode

```
LeadFlow Phase 8: operations, reporting, demo mode. Continue the existing project; do not rebuild.

1. Failed Automations screen: workflow, lead, timestamp, error, retry count, status, Retry button, attempt-history drawer, filters, and a guarded bulk retry. All real DB data.
2. Dashboard reporting from real queries:
   - conversion funnel
   - lead source performance
   - time-in-stage
   - workflow success/failure rates
   - date-range filter
3. /demo "Demo Scenario" page: one button creates a fictional lead and shows a live timeline (duplicate check → contact → opportunity → scored → assigned → follow-up scheduled → pipeline) from real DB events. Include a "Reset demo data" button that deletes only demo-tagged records.
4. Simple admin login for deployment safety (password from env, signed httpOnly cookie). Protect all pages and internal APIs. Webhooks stay signature-protected.
5. Investigate and fix the known issue where the no-JavaScript form fallback hangs after revalidatePath, or document the root cause.
6. Add Playwright browser tests (drag-drop, forms, Retry Now, demo page) and run them.
7. Update docs. Run typecheck, lint, tests, build. Commit. Stop after Phase 8 with an honest report.
```

---

## Prompt 6 — Phase 9: final docs + interview prep

```
LeadFlow Phase 9: final documentation and interview preparation. Do not add new features.

1. Audit every claim in README, IMPLEMENTATION_LOG, LEARNING_GUIDE, INTERVIEW_GUIDE, and DEMO_COMMANDS. Each claim must be backed by a test or a verification you actually ran. Otherwise mark it UNVERIFIED or remove it.
2. README.md: architecture with a Mermaid diagram, database schema, setup, env vars, HighLevel, n8n, webhooks, routing, scoring, retries, idempotency, failure handling, security.
3. INTERVIEW_GUIDE.md:
   - 2-minute explanation
   - 5-minute technical walkthrough
   - why each technology was chosen
   - 20 likely questions with accurate answers
   - follow-up questions
   - honest answers to "what would you improve?"
4. FAILURE_STORY.md: a reproducible, simulated HighLevel-outage DEMONSTRATION (error → recorded → retries → recovery → success → audit trail). Clearly labelled as a demo, never as a real client incident.
5. DEPLOYMENT.md: step-by-step Vercel + Supabase + Railway guide, costs to check, and Supabase pooler settings. Ask me before deploying anything.
6. Final full run: migrations on a fresh database, seed, typecheck, lint, all tests, build, web + worker integration test. Report the exact results.
7. Commit, and give me a one-page cheat sheet I can read on my phone before the interview.
```

---

## Prompt 7 — Mock interview (bonus)

```
Take a mock interview of me for an Automation Developer role (GoHighLevel, n8n, Make, APIs, webhooks), based on my LeadFlow project.
Ask one question at a time. Wait for my answer, then give short feedback: what was correct, what was missing, and a better answer.
Mix project questions, HighLevel/n8n concepts, debugging scenarios, and one live system-design question. 12 questions total, then give me a final score with weak areas.
```
