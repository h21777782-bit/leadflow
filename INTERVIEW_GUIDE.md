# Interview Guide — LeadFlow

> This is a **personal demo project** built to learn and demonstrate CRM automation patterns.
> Describe it that way. Do not present it as a client system or claim production incidents.
> All data is fictional. Failure scenarios are demo/test scenarios run locally.

The full project walkthrough (2-minute and 5-minute versions) will be added in Phase 9.
This file currently covers **Phase 3: scoring and routing** and **Phase 4: the automation engine**.

---

## Routing engine — 2-minute explanation (say this)

"When a lead comes in, two things happen after it's saved. First, it gets a score out of 100 across five factors — budget fit, service fit, engagement, whether they've replied, and appointment status — and a band: Hot, Warm or Cold. Every factor stores a plain-English reason, so a sales manager can see *why* a lead is Hot. One principle I was careful about: missing information gets neutral credit, not zero. A lead we haven't contacted yet isn't penalised for not replying.

Second, the routing engine picks an owner. Rules are checked in priority order — for example, 'CRM leads from North America go to Daniel'. For each rule, I filter out reps who are inactive, on leave, or at capacity, prefer reps who actually sell that service, and then pick fairly: round robin, lowest workload, or a fixed order. If a matched rule has nobody eligible, it falls through to the next rule. If nothing works, the lead stays visibly Unassigned with the exact reason — I never silently give it to someone unsuitable.

Ownership is sticky: once a rep is talking to a lead, a change in the lead's details doesn't move it. The exception is when the owner goes on leave and the lead hasn't been contacted yet — then it's reassigned automatically. Manual assignments are never overridden.

All of this runs in database transactions with row locks, so two simultaneous requests can't assign the same lead twice or push a rep over capacity. I tested both with concurrent requests against a real Postgres database."

---

## Five technical questions with accurate answers

**1. How do you guarantee a rep never exceeds their capacity when leads arrive at the same time?**
> Inside the routing transaction I lock the rep rows with SELECT … FOR UPDATE, always in id order, and only then count their active leads. A second transaction trying to route another lead waits for that lock, and when it gets it, it recounts and sees the updated workload. I tested this: five leads created concurrently for a rep with one free slot — exactly one was assigned, the other four were left Unassigned with "at capacity" as the reason. The trade-off is that routing is serialized, which is fine at this volume; at larger scale I'd move to per-rep advisory locks or a queue.

**2. What stops the same lead from being assigned twice?**
> The contact row is locked first, and the policy check runs after the lock. The first request assigns; the others then see an owner and skip, because ownership is sticky. In the test, four parallel routing calls produced exactly one "assigned" decision and three "skipped". Repeating a failed routing with the same outcome is also a no-op, so the decision history doesn't fill with duplicates.

**3. Why keep the scoring and routing logic as pure functions?**
> Business rules change often and they're where the bugs are. Pure functions take plain data and return a decision plus an explanation, so I can unit-test every boundary — 69 versus 70, a rep at exactly capacity, all reps unavailable — in milliseconds without a database. The service layer only loads data under locks, calls the function, and persists the result.

**4. How do you handle missing or bad data in scoring?**
> Missing data gets neutral partial credit — an unknown budget scores 12 out of 30, not zero — because absence of information isn't evidence the lead is bad. Invalid values like a negative budget or NaN are treated as unknown rather than zero. Only explicit evidence lowers a factor: a budget below our minimum, two or more unanswered contact attempts, or a no-show.

**5. When do you reassign a lead that already has an owner?**
> Only in one case: the owner becomes unavailable or inactive *and* the lead hasn't been contacted yet. If the conversation has started, I keep the owner and surface it for a manager, because switching reps mid-conversation hurts the customer experience. A lead whose owner was chosen manually is never reassigned automatically; there's an explicit "Route now" action for a human override.

**Likely follow-ups**
- *"Where is the assignment decision stored?"* → `routing_decisions`: outcome, previous and new rep, rule, trigger, reason, and a JSON trace of every rule and candidate considered.
- *"Is this synchronous?"* → Yes, for now it runs right after the triggering change commits. If it fails, the lead is still saved and the failure is audited. Moving it to a background job with retries is the next phase — I haven't built the worker yet.
- *"Can the business change the rules?"* → Routing rules are editable in Settings and validated with Zod; saving a rule retries every waiting unassigned lead. The scoring weights are a versioned config in code, not yet editable in the UI.
- *"What bugs did testing find?"* → Real ones: Postgres jsonb reorders keys, so comparing breakdowns with JSON.stringify always reported a change and wrote duplicate history rows; a partial update without an owner field was unassigning leads; and a missing capacity field was coerced to zero. All found by tests, all fixed with regression tests.

---

## Step-by-step live demo (≈4 minutes)

Before the interview: `npm run db:seed` then `npm run dev`.

1. **Dashboard** → point at Lead temperature, Unassigned leads (should be empty), rep workload bars, routing decisions made by the engine during seeding.
2. **Contacts → Add contact**: First `Leila`, Last `Farouk`, email `leila@farouk-design.example`, phone `+971 50 765 4321`,
   company `Farouk Design`, country `AE`, source Website form, service Web design, budget `3000`,
   notes `Wants a bilingual site`. Save. (Leave Owner empty so routing decides.)
   → Lead page: score **54 Warm**, breakdown with reasons, "Assigned to Aarav Mehta" and the rule trace.
3. **Edit contact** → budget `15000` → Save. Score rises 54 → **68**, owner stays Aarav ("ownership is sticky").
4. **Log a reply** on the lead page ("Yes, let's talk Thursday") → 68 → **82 Hot**; response factor now 15/15.
5. **Settings** → untick Available for **Daniel Brooks** → Save. Message says how many leads were re-evaluated.
   → Dashboard: Daniel's not-yet-contacted leads moved; his in-conversation leads stayed.
6. Also untick **Neha Kulkarni** → Save. Add a contact: US, CRM automation, no budget.
   → It stays **Unassigned** with the exact reason listing every rep.
7. Tick Daniel **Available** again → Save → the waiting lead is assigned to Daniel automatically.
8. Terminal: `npx vitest run tests/lead-intelligence.integration.test.ts` → point at the concurrency and capacity tests.

Alternative: `npm run db:seed && npm run demo:routing` runs the same story in the terminal through the real services.

---

## Phase 4: automation engine — 2-minute explanation (say this)

"Once a lead is scored and routed, it enters a follow-up workflow: three emails, spaced out — a short delay, then a day later, then three days later — unless the lead replies, books an appointment, the deal closes, or they opt out, in which case it stops and records exactly why. That's built on a persistent job queue in Postgres, not an in-memory scheduler, because the web app and the worker that actually sends messages are two separate processes — Vercel serverless functions don't stay alive to run a polling loop, so a background worker has to be its own always-on service.

The queue guarantees three things I specifically tested against a real database, not mocks. First, no two workers ever claim the same job — claiming is one atomic UPDATE using `SELECT … FOR UPDATE SKIP LOCKED`, so concurrent workers just skip each other's locked rows. Second, every send is idempotent — each message has a unique key, so if a job is retried after a crash, the handler checks whether that message already went out before sending again. Third, a worker that hangs can't corrupt state: its lease expires, another process recovers the job, and if the original worker eventually wakes up and tries to finish it, the completion is refused because it no longer holds the lease.

Failures are classified transient or permanent. Transient errors — a simulated 503 — get exponential backoff with jitter and retry up to 5 attempts before failing for good. Permanent errors — like no address to send to — fail immediately, because retrying can't help. Everything is visible on an Automations page: worker heartbeats, job counts, a Retry Now button, and a demo switch that forces the mock provider to fail on command, so I can show a failure and its recovery live instead of just describing it."

---

## Automation engine — technical questions with accurate answers

**1. Why is the job queue a Postgres table instead of an in-memory queue or something like Redis/BullMQ?**
> Two reasons. The practical one: the web app and the worker are separate processes (the worker can't live inside a Vercel function), so the queue has to be somewhere both can see — a database, not memory. The architectural one: I get transactional guarantees for free — enqueueing a job in the same transaction as the row that triggered it means I can never end up with a contact but no follow-up, or a follow-up with no contact. A dedicated queue product would be a reasonable upgrade at real scale, but at this volume Postgres with `SKIP LOCKED` is a well-known, simple pattern and it's one less moving part to operate.

**2. Walk me through exactly how two workers avoid claiming the same job.**
> `claimDueJobs` is a single SQL statement: an `UPDATE jobs SET status = 'processing' … WHERE id IN (SELECT id FROM jobs WHERE … FOR UPDATE SKIP LOCKED)`. Because it's one statement, Postgres handles the locking atomically — the subquery locks the rows it's about to update, and `SKIP LOCKED` means a second worker running the exact same statement concurrently simply doesn't see rows the first worker already locked; it gets the next ones instead. I proved this with a test: 6 due jobs, 4 "workers" claiming concurrently via `Promise.all`, and the claimed IDs across all four batches are a set with no duplicates and full coverage.

**3. What happens if a worker crashes mid-job?**
> Every claim sets a lease (`lease_expires_at`, 60 seconds by default). If the worker dies, nothing updates that job further — it just sits in `processing` until the lease expires. The next worker to run its loop calls `recoverAbandonedJobs()`, which finds jobs stuck in `processing` past their lease and puts them back to `retry_scheduled` (or `failed` if attempts are exhausted), with an `abandoned` row in the attempt history so the audit trail shows *why* it was retried. I tested the more subtle case too: what if the original worker isn't actually dead, just slow, and it finally finishes and tries to complete the job *after* it's been recovered? The completion is a conditional UPDATE — `WHERE locked_by = me AND status = 'processing'` — and since the status has moved on, it matches zero rows and the stale result is discarded rather than overwriting the newer state.

**4. How do you guarantee a message is never sent twice, even with retries?**
> Every outgoing message has a unique idempotency key (`wf:<runId>:<stepKey>`) with a UNIQUE index in the database. The handler always checks for an existing row with that key before sending: if one exists and its status is `sent`, it logs "already sent" and skips sending again, but *still* re-runs the rest of the step (advancing the workflow, scheduling the next one) — because if the job is being retried, something before or after the actual network call must have failed, not the send itself. I tested this by calling the handler function directly twice for the same job — same as what happens if a process crashes right after the provider call succeeds but before the job is marked complete — and asserted exactly one message row and exactly one next-step job exist afterward.

**5. Why classify errors as transient vs. permanent instead of always retrying?**
> Because retrying a permanent error just wastes the retry budget and delays the person finding out. An invalid recipient, or a job type the worker has no handler for, will fail identically on attempt 5 as attempt 1 — so those fail immediately and go straight to Failed Automations with a clear "why", rather than sitting in a fake retry loop for hours. Transient errors (timeouts, 5xx, 429) get exponential backoff with jitter — the jitter matters because if a real outage fails 100 jobs at once, pure exponential backoff would retry all 100 at exactly the same instant again; equal jitter spreads them out while keeping a guaranteed minimum wait.

**Likely follow-ups**
- *"Why Postgres advisory locks / SKIP LOCKED instead of `SELECT ... FOR UPDATE NOWAIT`?"* → `NOWAIT` would make a second worker's whole claim attempt error out if it hits any locked row. `SKIP LOCKED` just moves past locked rows and claims what's actually free, which is exactly the "give me whatever's available" semantics a worker pool needs.
- *"What's `MOCK_MODE` for?"* → Phase 4 has no real messaging provider — sends are simulated and clearly labelled everywhere (`[SIMULATED]`, a `SIMULATED` badge on the Automations page). The demo failure switch (off/transient/permanent) only works when `MOCK_MODE=true`, so it can never accidentally affect a real integration once Phase 5 adds one.
- *"Why can't the worker run on Vercel?"* → Vercel functions are request-scoped: they start to handle one request and can be frozen or killed right after responding. The worker is an infinite loop that polls the database every couple of seconds whether or not a request is in flight — that needs an always-on process (Railway/Render/Fly), which is also exactly what I ran in the two-process test below.
- *"What did you actually verify, versus just write tests for?"* → I ran two separate OS processes locally — a production web server and `npm run worker` — created a lead through a real HTTP request to the web server, and watched the *other* process's log claim and complete the job, then confirmed the dashboard (served by the first process) showed the result. That's the one thing unit and integration tests can't prove by themselves: that the processes are genuinely independent and only coordinate through Postgres.

---

## Step-by-step live demo — Phase 4 (≈3 minutes)

Before the interview: `npm run db:seed`, then in two terminals `npm run dev` and `npm run worker`.

1. **`/automations`** → point at worker status (online, from its heartbeat), job counts, the editable follow-up delays, and the demo failure switch.
2. Flip the failure switch to **transient**, then run `npm run demo:b` in a third terminal (or create a lead in the UI and wait ~30s) → the job fails with a simulated 503, shown with its exact error and next retry time.
3. Flip the switch back to **off**, click **Retry Now** on the job → it completes; point out the attempt history shows both the failed and the successful attempt, and exactly one message exists despite two attempts.
4. **`/failed-automations`** → any row without a worker handler explains why retrying it can't succeed, instead of just failing silently again.
5. Create a lead, then immediately log a reply on its page → run `npm run worker:once` (or wait for the running worker) → the follow-up is skipped with reason "Lead replied", and the workflow shows **Stopped**.
6. Terminal: `npx vitest run tests/automation.integration.test.ts` → point at *concurrent claiming by several workers never claims the same job twice* and *a stale worker cannot overwrite the result once its lease has been recovered*.

Alternative, fully scripted: `npm run demo:a && npm run demo:b && npm run demo:c` runs the success, failure/retry, and cancellation stories back to back through the real services.
