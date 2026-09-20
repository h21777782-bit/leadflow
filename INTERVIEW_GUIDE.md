# Interview Guide — LeadFlow

> This is a **personal demo project** built to learn and demonstrate CRM automation patterns.
> Describe it that way. Do not present it as a client system or claim production incidents.
> All data is fictional. Failure scenarios are demo/test scenarios run locally.

The full project walkthrough (2-minute and 5-minute versions) will be added in Phase 9.
This file currently covers **Phase 3: scoring and routing**.

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
