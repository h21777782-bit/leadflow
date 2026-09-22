# Interview Guide — LeadFlow

> This is a **personal demo project** built to learn and demonstrate CRM automation patterns.
> Describe it that way. Do not present it as a client system or claim production incidents.
> All data is fictional. Failure scenarios are demo/test scenarios run locally.

The full project walkthrough (2-minute and 5-minute versions) will be added in Phase 9.
This file currently covers **Phase 3: scoring and routing**, **Phase 4: the automation engine**,
**Phase 5: the HighLevel integration layer**, and **Phase 6: webhooks and n8n**.

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

---

## Phase 5: HighLevel integration — 2-minute explanation (say this)

"Every time a contact or opportunity changes, LeadFlow enqueues a sync job onto the same job queue the follow-up engine uses — an outbox pattern. That job is handled by a `CrmProvider` interface with two implementations: a mock, which is the default and never contacts anything real, and a real HighLevel provider, used only when `MOCK_MODE=false` and credentials are set. Neither the services that create contacts nor the worker that runs the job know which one they're talking to.

Before writing any of the real provider, I read HighLevel's actual current documentation — not blog posts, several of which confidently state things that turned out to be wrong, like claiming the API has no upsert endpoint when it does. Every endpoint, method and field name in the real provider traces back to a specific doc URL I recorded with the date I checked it.

Idempotency here means something specific: HighLevel's contact and opportunity ids are stored once, in `ghl_contact_id` and `ghl_opportunity_id`, and every later sync updates that same record instead of creating a new one — however many times the job retries. The HTTP client itself handles the operational reality of a third-party API: a request timeout via AbortController, 429 responses with their Retry-After delay respected, and every non-2xx response classified as either worth retrying or not, reusing the same transient/permanent classification the follow-up engine already had. Every call — success or failure — is logged, but never the Authorization header, so a token can never end up in a log table."

---

## HighLevel integration — technical questions with accurate answers

**1. How do you avoid creating a duplicate opportunity in HighLevel if the sync job is retried?**
> The opportunity's HighLevel id (`ghl_opportunity_id`) is stored on our own row the first time it's created. Every later sync — from a stage change, a value update, or a genuine job retry — checks for that stored id first: if present, it calls HighLevel's update endpoint (`PUT /opportunities/:id`) instead of create. I have a test that walks through exactly this: create once (asserts a `POST` happened and the id got stored), then trigger a stage change (asserts a `PUT` happened, and the stored id is unchanged, not a new one).

**2. HighLevel opportunities need a contact id. What happens if the opportunity sync job runs before the contact sync job?**
> I considered building a real job-dependency graph and decided it wasn't worth the complexity at this scale. Instead, if the opportunity sync handler loads its contact and finds no `ghl_contact_id` yet, it throws a transient error — "hasn't been synced yet, retrying" — and the existing backoff-and-retry machinery from Phase 4 just handles it: the job retries a few seconds later, by which point the contact's own sync job has almost always already completed. It's not perfectly ordered, but it's self-correcting, and I can see it happen live in `npm run demo:crm`'s output.

**3. Walk me through what happens on a real 429 from HighLevel.**
> The HTTP client reads the response status, and if it's 429, checks for a `Retry-After` header. If present, I convert it to milliseconds and attach it to the thrown error — the queue's existing retry logic uses that as the next run time instead of its own default backoff, so a job actually waits as long as the provider asked rather than guessing. If the header is absent, it falls back to the same exponential-backoff-with-jitter the follow-up engine uses. Every attempt, successful or not, is logged to an `integration_calls` table with the status code and duration, so the Integrations page shows exactly what happened without anyone reading server logs.

**4. Why does the mock provider also write to the integration_calls log?**
> Because `MOCK_MODE=true` is the default, and if the mock provider stayed silent, the Integrations page — status codes, recent calls, the whole audit trail — would look empty in the normal demo state. So the mock logs every simulated call exactly the way the real provider does, including simulated failures from its fault-injection switch. That switch lets me show a live outage and recovery on demand without touching any real account.

**5. What's a bug you actually found while building this, not just something you're claiming you'd catch?**
> The sync handlers required `HIGHLEVEL_LOCATION_ID` and `HIGHLEVEL_PIPELINE_ID` unconditionally — even when running in mock mode, where the mock provider never uses them at all. My test suite never caught it, because the tests explicitly set those variables to exercise the real HTTP client. It was `npm run demo:crm`, run against the actual dev environment where those are correctly left blank in mock mode, that failed immediately. That's exactly why I run the demo scripts myself instead of trusting a green test suite — tests prove the code I thought to test; running the thing proves the code as it's actually configured.

**Likely follow-ups**
- *"Why not call HighLevel synchronously, right when the contact is created?"* → Same reasoning as the follow-up engine: a third-party API can be slow, rate-limited, or briefly down, and none of that should block or fail the local write the salesperson is waiting on. Queueing it means the contact is saved instantly and the sync happens — and retries — independently.
- *"How would you find a lead's HighLevel record from ours, or vice versa?"* → `contacts.ghl_contact_id` and `opportunities.ghl_opportunity_id` are stored and unique-indexed in our schema (added back in Phase 1, before this integration existed, specifically to anticipate it).
- *"What isn't verified yet?"* → No request has ever reached a real HighLevel account — every endpoint claim comes from reading the current docs, and the mocked-fetch tests prove the client's own logic (timeouts, retries, classification, logging) works, not that a live account behaves identically. That's stated explicitly in `IMPLEMENTATION_LOG.md` rather than implied to work.

---

## Step-by-step live demo — Phase 5 (≈3 minutes)

1. **`/integrations`** → point at mock mode, sync status counts, the pipeline stage mapping form.
2. **Test connection** → click it — works even in mock mode (calls the cheapest read endpoint) — shows pipeline/stage counts.
3. Set the demo failure switch to **503**, create a lead (or `npm run demo:a`) → its sync job fails, shown in **Recent integration calls** with the status code and error.
4. Switch back to **off** → wait (or `npm run worker:once`) → the same job recovers; point out the attempt history in the underlying job.
5. **`/failed-automations`** → the seeded `crm.sync_contact` failure (from Phase 1's seed data) now has a working **Retry Now** button, where it previously said "no handler exists yet".
6. Terminal: `npm run demo:crm` → narrate the outage → retry → recovery → audit trail as it prints.
7. Terminal: `npx vitest run tests/crm-integration.test.ts` → point at the idempotent re-sync tests and the "never logs the bearer token" test.

---

## Phase 6: webhooks and n8n — 2-minute explanation (say this)

"LeadFlow accepts inbound events from three kinds of external systems — the website, n8n workflows, and HighLevel — through six webhook endpoints. Every request is authenticated before anything touches the database: our own website/n8n traffic is signed with HMAC-SHA256 over a timestamp and the raw body, with a 5-minute replay window, and HighLevel's traffic is verified with Ed25519, the scheme they moved to this year. If the signature doesn't check out, nothing is even written — not a 'received' row, nothing — so the audit trail only ever shows real, authenticated deliveries.

Once authenticated, most endpoints acknowledge in under a millisecond with a 202 and hand the real work to the same job queue the follow-up engine already uses — the endpoint just claims the event idempotently and enqueues a job. The two exceptions are the lead-intake endpoint, which reuses an already-idempotent service synchronously because it's fast enough not to need queueing, and everything else, which processes in the background. A payment webhook, for instance, marks the deal Won and creates the onboarding checklist — idempotently, so the same payment delivered twice, which happens in the real world, never double-processes.

The part I'm proudest of: I didn't just write the importable n8n workflow JSON and call it done. I pulled n8n, ran it in Docker, imported the workflow, activated it, and triggered its real webhook URL with curl against my actual running app. That surfaced four real configuration and workflow bugs — including one where I'd used the wrong parameter name on the HTTP Request node, which silently sent an empty body while still attaching a valid-looking signature header computed from the real payload. I only found it by pulling n8n's own node-type schema and diffing it against what I'd written. That's the difference between 'this should work' and 'I watched it work.'"

---

## Webhooks — technical questions with accurate answers

**1. Why verify the signature before writing anything to the database, not after?**
> Because writing first and validating second means an unauthenticated caller can still cause a database write and consume the idempotency key for a real event — even if I later marked that row as invalid, the row would exist, and it costs a write and a place in the audit log for something nobody should have been able to send. Verifying strictly before any query means an attacker or a broken client leaves literally no trace beyond a web server access log.

**2. Why does the website/n8n scheme sign a timestamp and HighLevel's doesn't?**
> That's HighLevel's own scheme, not mine — their Delivery URL signature is just over the raw body, no timestamp, so I implement it exactly as documented rather than inventing a variant. For my own scheme I added a timestamp specifically for replay protection: a signature alone proves the sender knew the secret at some point, not that the request is fresh. Binding the signature to a timestamp and rejecting anything more than 5 minutes old means a captured, replayed request is rejected even though its signature is technically valid.

**3. How do you guarantee the same webhook delivered twice — which happens constantly with real providers' at-least-once delivery — doesn't double-process?**
> Two independent idempotency layers, deliberately. First, `webhook_events` has a UNIQUE constraint on `(source, event_id)` — the insert either claims the event or, on conflict, returns the row that already exists, including its stored result if it already finished, so a duplicate HTTP delivery gets the exact same response as the original. Second, for anything money-related — payments specifically — there's a second, independent UNIQUE constraint on the payment's own external id, so even if two *different* webhook events somehow both refer to the same payment, it's still only ever recorded and processed once.

**4. Walk me through the real n8n bug — what exactly went wrong and how did you find it?**
> The HTTP Request node needs a specific combination of parameters to send a raw string body: `contentType: "raw"`, not `specifyBody: "raw"` — that second field only exists at all when content type is JSON, and only accepts `"keypair"` or `"json"` as values. I'd used the wrong one, which n8n accepted without any import error, but at runtime it meant no body was ever attached to the request — while the signature header, computed correctly from the real payload in an earlier Code node, was still sent. So LeadFlow received an empty body with a signature that was valid for a *different*, non-empty body, and correctly rejected it with "signature does not match" — a true, correct rejection that gave me no hint the actual bug was an empty body. I found it by authenticating to n8n's own REST API, pulling its node-type schema (`/types/nodes.json`), and diffing the real parameter names against what I'd written.

**5. What's still unverified, and why is that an honest thing to say rather than a gap to hide?**
> The Ed25519 signature verification itself is real and matches HighLevel's current published scheme and key — that part would work against a genuine HighLevel delivery with zero configuration. What's not verified is the actual payload shape: real HighLevel webhooks carry their own event envelope (`ContactCreate`, `ContactUpdate`, etc. with a nested `data` object), and I didn't build a mapping layer from that shape into LeadFlow's internal fields, because nothing in the requirements asked for it and building one speculatively would be exactly the kind of invented, unverified endpoint the brief told me not to write. I documented that boundary explicitly instead of implying more coverage than exists.

**Likely follow-ups**
- *"Why does `/api/webhooks/leads` behave differently from the other five?"* → It calls `ingestLeadEvent` (built in Phase 4) directly and synchronously instead of going through the generic queued receiver, because that service already owns its own idempotent `webhook_events` handling. Layering the generic receiver's own claim on top of it would insert into the same table twice for the same key — the second insert, inside `ingestLeadEvent`, would always find the row the generic receiver already claimed and report every genuine first delivery as a duplicate. I found this by reasoning through the design before writing code, not by hitting the bug.
- *"What HTTP status codes does it return and why?"* → 202 on acceptance (work may still be in flight), 401 for a missing or invalid signature, 400 for malformed JSON or missing required fields, 413 for an oversized body, 422 for a well-formed request that's missing what's needed for idempotency (no event id) or is otherwise semantically unprocessable.
- *"Could someone replay a HighLevel webhook since it doesn't have a timestamp?"* → Not usefully — signature validity plus the event-id UNIQUE constraint means a replayed HighLevel event is accepted as *authentic* (it was) but treated as a duplicate and returns the original stored result rather than reprocessing. HighLevel's own docs don't specify timestamp-based replay protection for this scheme, so I implemented exactly what they document rather than adding an unrequested variant.

---

## Step-by-step live demo — Phase 6 (≈3 minutes)

1. **`/webhooks`** → point at the columns: source, signature result, status, result/error, the linked job's attempts, expandable raw payload.
2. Terminal: `npm run webhook:send -- leads` → real HMAC-signed request → point at the printed `curl` equivalent and the 202 response with the new contact/opportunity ids.
3. Terminal: `npm run webhook:send -- leads --bad-signature` and `--expired` → both 401, for different reasons — point at the exact error message for each.
4. `npm run webhook:send -- payments` (after putting a real opportunity id in) → open that lead's page → stage **Won**, onboarding checklist created.
5. If time allows: the n8n Docker demo from `DEMO_COMMANDS.md` §12e — genuinely trigger the real webhook URL and show both the success and failure branch responses.
6. Terminal: `npx vitest run tests/webhooks-integration.test.ts` → point at *concurrent duplicates: 5 simultaneous deliveries … create exactly one row and one job* and *payment → won: … idempotent on externalPaymentId*.
