# LeadFlow — Learning Guide

यह guide हर phase के बाद update होगी। Explanation सरल हिंदी में है (technical terms English में)।
**Interview answers English में हैं**, क्योंकि interview में आप इन्हें इसी भाषा में बोलेंगे।

> ईमानदारी का नियम: यह एक **demo project** है। Interview में इसे "मैंने बनाया और test किया" बोलें —
> "यह client production में चला" नहीं। जो failures इसमें हैं वो demo/test scenarios हैं।

---

# Phase 1 — Foundation: database, demo data, read-only UI

## 1. हमने क्या बनाया

- एक Next.js app जिसमें 10 pages हैं (Dashboard, Contacts, Lead details, Pipeline, Appointments, Automations, Failed automations, Activity log, Integrations, Settings)।
- पूरा **database schema** — 16 tables — जो आगे के सभी phases में use होगा।
- **24 demo leads** जो pipeline के हर stage में हैं, साथ में appointments, messages, workflow runs और कुछ failed automations (साफ़ `[demo seed]` label के साथ)।
- `/api/health` endpoint जो बताता है कि database चल रहा है या नहीं।
- Environment variables की validation, ताकि गलत config पर app साफ़ error दे।

अभी सब **read-only** है। Data बदलने वाले features Phase 2 से आएंगे।

## 2. यह क्यों बनाया (इस क्रम में)

- **Schema पहले:** हर automation का आधार data है। अगर tables बाद में बार-बार बदलें तो migrations गड़बड़ होती हैं। इसलिए पूरा schema अभी design किया।
- **Demo data पहले:** बिना data के dashboard, pipeline या failed-automations screen का कोई मतलब नहीं। Interview में भी खाली screen दिखाना कमज़ोर लगता है।
- **Health check पहले:** Production सोच — "system ठीक है या नहीं" बताने का तरीका सबसे पहले होना चाहिए।

## 3. Data कैसे move करता है (Phase 1)

```
Browser → /dashboard (Next.js server component)
        → src/server/queries/index.ts (getDashboardSummary)
        → Drizzle ORM → PostgreSQL
        ← rows → HTML render → Browser
```

Page खुद SQL नहीं लिखता। सारी SQL `src/server/queries` में है। इसे **data access layer** कहते हैं।

## 4. Important files

| File | काम |
|---|---|
| `src/db/schema.ts` | सभी 16 tables, enums और indexes की definition। सबसे important file। |
| `drizzle/0000_init.sql` | Schema से generate हुई असली SQL migration। |
| `src/lib/env.ts` | Environment variables को Zod से validate करता है। `MOCK_MODE` default `true`। |
| `src/lib/normalize.ts` | Email को lowercase, phone को E.164 (`+919822011234`) में बदलता है — duplicate detection की नींव। |
| `src/lib/timezone.ts` | "11:00 IST" को UTC में बदलना, DST सहित। |
| `src/lib/pipeline.ts` | 9 stages की single source of truth। |
| `src/db/seed-data.ts` | Demo leads (सिर्फ data, इसलिए test हो सकता है)। |
| `src/db/seed.ts` | Demo data को **एक transaction** में insert करता है। |
| `src/server/queries/index.ts` | UI के लिए सारी read queries। |
| `src/app/api/health/route.ts` | Health check। DB down पर 503। |
| `src/app/(app)/error.tsx` | Page का data load fail होने पर दिखने वाली screen। |
| `tests/*.test.ts` | 31 tests। |

## 5. पांच concepts जो आपको पक्के समझने हैं

### a) Normalization + unique index = duplicate protection
`Priya@SharmaDental.Example ` और `priya@sharmadental.example` एक ही इंसान हैं।
`+91 98220 11234` और `098220 11234` भी एक ही number हैं।
हम हर contact के साथ normalized version भी store करते हैं (`email_normalized`, `phone_e164`) और उन पर **UNIQUE index** लगाया है।

**क्यों index, सिर्फ code check क्यों नहीं?** मान लीजिए form और n8n एक ही lead एक ही समय भेजते हैं। दोनों code check करते हैं "क्या यह email पहले से है?" → दोनों को "नहीं" मिलता है → दोनों insert करते हैं → duplicate। इसे **race condition** कहते हैं। Unique index पर database दूसरे insert को reject कर देता है — race असंभव।

### b) Idempotency (एक ही काम दो बार न हो)
तीन जगह unique keys लगाई हैं जो आगे के phases में काम आएंगी:
- `webhook_events (source, external_event_id)` — एक ही webhook दो बार आए तो दूसरा reject।
- `messages.idempotency_key` जैसे `wf:{runId}:followup_1` — एक follow-up दो बार send नहीं हो सकता।
- `workflow_runs` पर partial unique index — एक contact एक workflow में एक समय पर सिर्फ एक बार।

### c) UTC में store, local में दिखाओ
Database में हर time UTC में है। साथ में lead का timezone (`Asia/Kolkata`) अलग column में है। Screen पर दिखाते वक्त convert करते हैं। Appointments page पर एक ही meeting lead के time और sales rep के time दोनों में दिखती है।

### d) Transaction
Seed में सैकड़ों rows जाती हैं। अगर बीच में error आए तो आधा data रह जाता। **Transaction** का मतलब: या तो सब कुछ save होगा, या कुछ भी नहीं।

### e) Config validation (fail fast)
अगर `DATABASE_URL` missing है या `MOCK_MODE=false` है पर HighLevel token नहीं है, तो app साफ़ बताता है *कौन सा* variable गलत है। Secret की value कभी UI में नहीं दिखती — सिर्फ "Set / Not set"।

## 6. क्या fail हो सकता है

| Failure | कैसे पता चलता है | Recovery |
|---|---|---|
| Postgres बंद / गलत `DATABASE_URL` | `/api/health` → **503**; page पर "could not load its data" | DB चालू करो → अगली request अपने आप 200 (connection pool reconnect होता है, app restart नहीं चाहिए) |
| गलत env config | App start/request पर `Invalid environment configuration` + variable का नाम | `.env.local` ठीक करो |
| Invalid phone number | `normalizePhone` → `null` (garbage store नहीं होता) | Phase 2 में validation error दिखेगा |
| Seed बीच में fail | Transaction rollback — आधा data नहीं बचता | Error ठीक करके दोबारा `npm run db:seed` |
| गलत URL `/contacts/abc` | UUID check → 404 page (DB error नहीं) | — |

**असली bug जो Phase 1 में पकड़ा (development के दौरान, production नहीं):** Dashboard production server पर 500 दे रहा था क्योंकि raw SQL में JavaScript `Date` pass हो रहा था। Typecheck और build दोनों pass थे — सिर्फ असली query चलाने पर पकड़ा गया। Fix किया और एक regression test जोड़ा जो हर UI query असली DB पर चलाता है। **सीख:** "build pass" का मतलब "app काम करता है" नहीं है।

## 7. Interview में क्या दिखाएं (Phase 1)

1. Dashboard → pipeline flow bar और KPIs।
2. Contacts → किसी lead पर click → Lead details में timeline, stage history, messages।
3. Appointments → एक ही meeting दो timezones में।
4. Failed automations → `[demo seed]` failures (बताएं ये demo data है; retry Phase 8 में)।
5. `schema.ts` खोलकर unique indexes दिखाएं और "why DB-level" समझाएं।
6. `npm test` चलाएं → duplicate-rejection integration tests।
7. (Optional) Postgres बंद करके `/api/health` का 503 दिखाएं, फिर चालू करके recovery।

Exact commands: `DEMO_COMMANDS.md`।

## 8. Interview questions — Phase 1

**Q1. Walk me through your data model.**
> Contacts hold the person; opportunities hold the deal, so one contact can have several deals over time. Every stage change is appended to a stage_history table rather than overwritten, which gives an audit trail and lets me compute time-in-stage. Automation state lives in workflow_runs, jobs and messages, and every inbound webhook and outbound API call is stored, so I can always reconstruct what happened to a lead.

**Q2. How do you prevent duplicate contacts?**
> Two layers. First, normalization: emails are trimmed and lower-cased, phones are converted to E.164 using the lead's country, so different formats of the same number match. Second, unique indexes on those normalized columns. The application checks for an existing contact first so it can update instead of create, but the unique index is what makes it race-safe — if two webhooks arrive at the same moment, the database rejects the second insert.

**Q3. Why Postgres and not just HighLevel as the database?**
> HighLevel is the CRM of record for the sales team, but I don't want my automation state to depend on an external API being available. Keeping my own Postgres lets me dedupe, queue jobs, retry, and keep an audit log even when HighLevel is down or rate-limiting. Sync to HighLevel happens through jobs, so a HighLevel outage delays the sync instead of losing the lead.

**Q4. How do you handle timezones?**
> Store every instant in UTC as timestamptz, and store the person's IANA timezone next to it. Convert only at the edges — when a lead picks a slot, and when we display it. IANA names matter because fixed offsets break at daylight-saving changes; I have tests that check 11 a.m. New York before and after the March DST switch.

**Q5. Why Drizzle instead of the Supabase client?**
> I wanted typed SQL and migrations that live in git. Drizzle generates plain SQL migration files, and because it talks to standard Postgres, the same code runs on local Supabase, Supabase cloud, or plain Docker Postgres.

**Q6. What happens if the database goes down?**
> The health endpoint returns 503 with status "degraded", so monitoring can alert. Pages show an error screen explaining the likely cause. When the database comes back, the connection pool reconnects on the next request — no restart. In production I'd hide raw driver errors, which the health endpoint already does, because they can leak hostnames.

**Q7. How did you test this?**
> Unit tests for the pure logic — normalization, timezone conversion, config validation, and the seed data itself, for example that every demo phone number normalizes. Integration tests run against a separate real Postgres database and prove that the database rejects duplicates. I also run the production build and hit every route. That's how I caught a bug the type checker missed: a Date object passed into a raw SQL template.

**Common follow-ups**
- *"Why is lead score a separate table?"* → History: I can see how a score changed over time and why (breakdown JSON), instead of one overwritten number.
- *"Why integer money?"* → Floats can't represent many decimals exactly; integers avoid rounding errors.
- *"Is there authentication?"* → Not in this local demo, and I say so. For production: Supabase Auth or similar, role checks for admin screens, and webhook routes protected by signatures instead of user sessions.

---

# Phase 2 — Contacts, duplicates, opportunities, stage changes, audit

## 1. हमने क्या बनाया

- **नया contact बनाना** (`/contacts/new`) — save से पहले duplicate check।
- **Duplicate मिलने पर** साफ़ बताना कि कौन सा contact match हुआ और किस चीज़ पर (email/phone), और "इसी contact को update करो" का option।
- **Contact edit** — हर बदले हुए field का record activity log में।
- **Opportunity बनाना** — contact के साथ अपने आप, या lead page से "Add another opportunity"।
- **Stage बदलना** — Pipeline पर drag-drop या "Move to" menu, और lead page से भी।
- हर बदलाव पर **stage_history** और **audit_logs** में entry।

ये सब **असली database में** save होता है। Test से यह साबित हुआ है।

## 2. यह क्यों बनाया (और इस तरीके से क्यों)

**Services layer (`src/server/services`):** सारे business rules यहीं हैं। Form, Kanban और आगे आने वाले webhooks व automations सब इन्हीं functions को call करेंगे। इसका फायदा यह है कि कोई भी रास्ता rules को bypass नहीं कर सकता। उदाहरण: stage बदलने का **सिर्फ एक** function है, `changeStage()`। इसलिए history और audit कभी छूट नहीं सकते।

**Result objects, exceptions नहीं:** "Duplicate मिला" कोई error नहीं है, यह एक normal नतीजा है। इसलिए service `{status: "duplicate", matches}` return करती है, और UI ठीक वही दिखाता है।

## 3. Data flow

### नया contact
```
Form submit → createContactAction (server action)
  → createContact() service
      1. validateContact()     — सारे errors एक बार में
      2. normalize             — email lowercase, phone → +91…
      3. findDuplicates()      — email या phone match?
         ├─ match → {duplicate} → form पर warning + "Update this contact instead"
         └─ no match → TRANSACTION:
               insert contact
               audit: contact.created
               insert opportunity (new_lead)
               insert stage_history (null → new_lead)
               audit: opportunity.created
      4. अगर दो requests एक साथ आईं और DB ने unique index से दूसरी को रोका
         → error पकड़ो → दोबारा findDuplicates → {duplicate, raceDetected}
  → redirect /contacts/{id}?created=1
```

### Stage change (Kanban drag)
```
Card drop → useOptimistic: card तुरंत नए column में दिखता है
  → moveStageAction({opportunityId, toStage, expectedFromStage, reason})
  → changeStage() — TRANSACTION:
       SELECT … FOR UPDATE           (row lock)
       current stage ≠ expected?  → conflict ("किसी और ने पहले ही move कर दिया")
       decideStageChange() rules   → lost बिना reason? reject
       UPDATE opportunity (stage, status, won_at/lost_at, lost_reason)
       INSERT stage_history
       INSERT audit: stage.changed (+ opportunity.won/lost, + manual.override)
  ← ok → page refresh होता है | error → optimistic move अपने आप वापस, error दिखता है
```

## 4. Important files (Phase 2)

| File | काम |
|---|---|
| `src/lib/validation/contact.ts` | Input rules (Zod), tags/custom-fields parsing |
| `src/lib/stage-rules.ts` | Stage change के नियम (pure function) |
| `src/server/services/contacts.ts` | create, duplicate check, merge, update |
| `src/server/services/opportunities.ts` | opportunity बनाना, `changeStage()` |
| `src/server/services/audit.ts` | Audit entry लिखना (हमेशा उसी transaction में) |
| `src/db/errors.ts` | Postgres unique-violation (23505) पहचानना |
| `src/app/actions/*.ts` | Server actions — पतले wrappers |
| `src/components/contacts/contact-form.tsx` | Create/edit form + duplicate panel |
| `src/components/pipeline/kanban-board.tsx` | Drag-drop board, reason dialog |
| `tests/services.integration.test.ts` | 13 real-DB tests (race conditions सहित) |

## 5. पांच नए concepts

**a) Race condition और उसका इलाज।** एक ही lead 5 बार एक साथ submit हुई। पांचों ने duplicate check किया और पांचों को "नहीं मिला" जवाब मिला। Unique index ने 4 inserts रोक दिए, और हमने उस DB error को "duplicate" जवाब में बदल दिया। Test में नतीजा: **ठीक 1 contact** बना।

**b) Row lock (`FOR UPDATE`)।** दो लोग एक ही card एक साथ drag करें, तो database दूसरे को पहले के खत्म होने तक रोककर रखता है।

**c) Optimistic concurrency (`expectedFromStage`)।** Browser बताता है "मैंने card को New lead में देखा था"। अगर तब तक card कहीं और जा चुका है, तो हम overwrite नहीं करते, conflict बताते हैं।

**d) Merge rules।** Duplicate को update करते समय खाली value पुराना data **कभी नहीं मिटाती**। Tags जुड़ते हैं, notes append होते हैं, और owner सिर्फ तब भरा जाता है जब पहले खाली हो (routing के फैसले को override नहीं करते)।

**e) Optimistic UI।** Card तुरंत move होता है ताकि UI तेज़ लगे। Server मना करे तो React खुद पुरानी state पर लौट जाता है।

## 6. क्या fail हो सकता है

| Failure | Detection | Recovery |
|---|---|---|
| Duplicate lead | `findDuplicates` या unique index (23505) | Warning + merge option; data corrupt नहीं होता |
| Email एक person से, phone दूसरे से match | दोनों matches report होते हैं | Merge नहीं होता — इंसान तय करे |
| दो लोग एक card move करें | Row lock + `expectedFromStage` | एक सफल, दूसरे को "refresh and try again" |
| Lost बिना reason | `decideStageChange` | Reject; board पर reason dialog पहले ही पूछता है |
| Transaction के बीच DB error | Transaction rollback | कुछ भी आधा save नहीं होता — audit भी नहीं |
| Invalid input | Zod | सारे field errors एक बार में |

## 7. Interview में क्या दिखाएं (Phase 2)

1. Priya Sharma का email **बड़े अक्षरों** में डालकर नया contact बनाएं → duplicate warning।
2. वही phone दूसरे format में डालें → phone पर match।
3. नया lead बनाएं → lead page पर timeline में contact.created, opportunity.created।
4. Pipeline पर card drag करें → activity log में entry।
5. Card को Lost में drag करें → reason dialog।
6. `npx vitest run tests/services.integration.test.ts` → "5 concurrent → exactly one contact"।

Exact steps: `DEMO_COMMANDS.md` (Phase 2 section)।

## 8. Interview questions — Phase 2

**Q1. Walk me through what happens when a new lead is created.**
> The input is validated and normalized first — lower-cased email, E.164 phone using the lead's country. Then I look for an existing contact by either key. If there's a match I return a duplicate result with who matched and on what, and the user can merge instead. If not, one transaction inserts the contact, a New-lead opportunity, the first stage-history row and the audit entries. Either all of it is saved or none of it is.

**Q2. Your duplicate check and the insert are two steps. Isn't that a race?**
> Yes, the check alone would race. That's why the normalized email and phone columns have unique indexes. If two requests pass the check at the same moment, Postgres rejects the second insert with a unique violation, and I translate that into the same duplicate result the user would normally see. I have a test that fires five identical submissions concurrently and asserts exactly one contact exists.

**Q3. What if the email matches one contact and the phone matches another?**
> I report both and don't merge anything automatically. Merging two different people is much worse than asking a human, so the system surfaces the conflict.

**Q4. How do you stop two sales reps overwriting each other's pipeline changes?**
> Two mechanisms. A row lock — SELECT FOR UPDATE — serializes concurrent changes to the same opportunity. And optimistic concurrency: the client sends the stage it saw, and if the deal has moved since, I return a conflict instead of silently overwriting. I tested two simultaneous moves of the same card: one succeeds, one gets a conflict.

**Q5. Why is stage history a separate table instead of just the current stage?**
> The current stage tells you where a deal is; history tells you how it got there — who moved it, when, and why. That's what you need for time-in-stage, conversion by stage, and for answering "who marked this lost?". It's append-only and written in the same transaction as the stage update, so they can't disagree.

**Q6. Where do business rules live, and why?**
> In a services layer, not in the UI or the route handlers. The Kanban board, the lead page, and later webhooks and automations all call the same changeStage function, so no entry point can skip validation, history or audit logging.

**Q7. Why return result objects instead of throwing exceptions?**
> A duplicate or a stale move is an expected business outcome, not a crash. Returning typed results like created, duplicate, invalid or conflict forces every caller to handle each case, and exceptions stay reserved for real failures like the database being down.

**Common follow-ups**
- *"Who is the actor in your audit log?"* → Honest answer: there's no login yet; actions are attributed to a configured demo admin. With real auth the actor comes from the session.
- *"Does it sync to HighLevel?"* → Not yet. Right now it only writes to Postgres. The HighLevel sync is a later phase, done through jobs so an API outage doesn't block saving a lead.
- *"Can the audit log be wrong?"* → It's written in the same transaction as the change, so if the change rolls back, the log entry does too.

---

# Phase 3 — Lead Scoring & Smart Routing (Hinglish)

## 1. Humne kya banaya — ek line mein

Har lead ko **0–100 ka score** milta hai (Hot / Warm / Cold) *aur har point ka reason* likha hota hai. Phir ek **routing engine** decide karta hai ki kaunsa sales rep us lead ko handle karega — rules, expertise, availability aur workload dekh kar. Sab kuch database mein save hota hai, audit log ke saath.

## 2. Scoring kaise kaam karta hai

File: `src/lib/scoring.ts` (pure function — database ka koi kaam nahi, isliye easily test hota hai).

| Factor | Max | Kaise milta hai |
|---|---|---|
| Budget fit | 30 | $10k+ = 30, $5k+ = 24, $2.5k+ = 16, $1k+ = 8, us se kam = 2. **Budget nahi bataya = 12** |
| Service fit | 20 | CRM automation 20 … social media 10. **Service nahi bataya = 8** |
| Engagement | 20 | Profile complete (company, email+phone, location, notes) max 8 + replies (1 = 6, 2 = 9, 3+ = 12) |
| Response | 15 | Reply kiya = 15. **Abhi contact hi nahi kiya = 7**. 2+ baar contact kiya, reply nahi = 3 |
| Appointment | 15 | Call ho gayi = 15, booked = 13, **abhi booked nahi = 5**, cancelled = 3, no-show = 2 |

**Sabse important rule:** jo info *pata nahi hai*, uske liye zero nahi — **neutral points** milte hain. Naye lead ne abhi reply nahi kiya kyunki humne contact hi nahi kiya — ye uski galti nahi hai. Score sirf *saboot* (evidence) pe girta hai: bahut chhota budget, 2+ follow-up ka jawab nahi, no-show.

Ghalat input (negative budget, NaN) ko bhi "unknown" maana jaata hai, zero nahi.

## 3. Routing kaise kaam karta hai

File: `src/lib/routing.ts` (ye bhi pure).

```
Lead aaya
  → rules ko priority order mein check karo (10, 20, 30 … 100)
  → rule match hua? (service, country, source, min budget)
      → rule ke reps mein se ELIGIBLE kaun hai?
          ✗ inactive   ✗ unavailable (leave pe)   ✗ capacity full
          ✗ (agar rule bole) ye service nahi bechta
      → koi eligible nahi? → agla rule try karo
      → eligible mein se jo ye service bechta hai, use prefer karo
      → strategy se ek chuno:
          assign_user  = list mein pehla available
          round_robin  = jise sabse pehle last lead mila tha
          least_loaded = jiska workload % sabse kam
  → koi bhi rule kaam nahi aaya → UNASSIGNED + reason (kabhi galat rep ko silently nahi dete)
```

## 4. Reassignment ke rules (kab owner badalta hai)

File: `decideRoutingNeed()` in `src/lib/routing.ts`

1. Lead ka koi open deal nahi → routing nahi.
2. Owner kisi insaan ne manually chuna → automatic routing **kabhi** override nahi karegi (sirf "Route now" button).
3. Owner nahi hai → route karo.
4. Owner leave pe/inactive **aur** lead se abhi baat shuru nahi hui (New lead / Attempting contact) → naya owner.
5. Owner leave pe, lekin baat chal rahi hai (Contacted ya aage) → **mat badlo**, insaan decide kare.
6. Baaki sab → owner same rahega ("sticky ownership"), chahe lead ki details badal jaayein.

Kyun? Jis lead se kisi ki baat chal rahi hai, use beech mein kisi aur ko dena customer ke liye bura experience hai.

## 5. Database kaise update hota hai (step by step)

File: `src/server/services/lead-intelligence.ts` → `processLeadChange()`

**Step A — Score (ek transaction):**
1. `contacts` row ko lock karo (`FOR UPDATE`)
2. DB se facts padho: budget, service, messages (inbound/outbound), appointments, stages
3. `scoreLead()` chalao
4. `contacts.lead_score / lead_band / scored_at` update
5. Score badla? → `lead_scores` mein history row + `audit_logs` mein `lead.scored`
   (score same hai to nayi row nahi — **idempotent**)

**Step B — Routing (alag transaction):**
1. Contact row lock
2. **Saare reps ki rows lock** (id order mein — isse deadlock nahi hota)
3. Policy check (`decideRoutingNeed`) — route karna hai ya nahi?
4. Lock ke andar workload count karo (active leads = owned + open deal)
5. `decideAssignment()` chalao
6. Save: `contacts.owner_id`, open `opportunities.owner_id`, rep ka `last_assigned_at`,
   `routing_decisions` row (reason + rule-by-rule trace), audit (`owner.assigned` / `owner.reassigned` / `lead.unassigned`)

**Kab chalta hai?** Contact create/update/merge, opportunity create, stage change, reply log, rep availability/capacity change, routing rule save, "Route now" button.

**Important:** ye original change (jaise contact create) ke **commit hone ke baad** chalta hai. Agar scoring/routing fail ho jaaye, contact phir bhi save rehta hai aur failure audit log mein `lead_intelligence.failed` ke roop mein dikhta hai.

## 6. Concurrency — do requests ek saath aayein to?

**Same lead, 4 routing requests ek saath:** pehli request contact lock leti hai aur assign karti hai. Baaki teen wait karti hain; lock milne par dekhti hain "owner already hai" → skip. Test: exactly 1 assignment.

**5 alag leads, rep ke paas sirf 1 slot:** reps ki rows lock hain, isliye sab ek-ek karke chalte hain. Har ek lock ke andar fresh workload count karta hai → sirf pehle ko slot milta hai, baaki 4 "at capacity" reason ke saath Unassigned. Test: capacity kabhi exceed nahi hui.

## 7. Important files (Phase 3)

| File | Kaam |
|---|---|
| `src/lib/scoring.ts` | Scoring engine + config |
| `src/lib/routing.ts` | Routing engine + reassignment policy |
| `src/server/services/lead-intelligence.ts` | DB se jodna: locks, save, audit, triggers |
| `src/server/services/routing-rules.ts` | Rules save karna (Zod validation) |
| `src/app/actions/lead-intelligence.ts` | Reply log, Route now, rep update, rule save |
| `src/components/lead/score-panel.tsx` | Score breakdown UI |
| `src/components/settings/*` | Rep aur rule editors |
| `drizzle/0001_scoring_routing.sql` | Naye columns + `routing_decisions` table |
| `scripts/demo-routing.ts` | Demo scenario |
| `tests/scoring.test.ts`, `tests/routing.test.ts`, `tests/lead-intelligence.integration.test.ts` | 56 naye tests |

## 8. Is phase mein jo bugs pakde (development ke dauraan, production mein nahi)

- **jsonb key order:** Postgres `jsonb` keys ka order badal deta hai, isliye `JSON.stringify` compare hamesha "badla hai" bolta tha → har baar duplicate history. Fix: sorted-key comparison.
- **ownerId missing = unassign:** Partial update mein ownerId na bhejne pe lead ka owner hat jaata tha. Fix: na bhejo = same rakho.
- **Capacity 0 ho jaana:** Field missing hone pe `Number(null)` = 0. Fix: validation.

Interview mein ye bata sakte hain: *"Tests ne ye bugs pakde, isliye main integration tests real database pe chalata hoon."*

## 9. Kya fail ho sakta hai

| Failure | Kaise pata chalta hai | Recovery |
|---|---|---|
| Koi eligible rep nahi | Lead page / dashboard pe Unassigned + reason | Rep available karo ya rule badlo → waiting leads apne aap retry |
| Rep leave pe gaya | Settings save | Uske not-contacted leads automatically move; baaki same |
| Scoring/routing crash | `lead_intelligence.failed` audit | Contact safe; "Route now" se dobara |
| Do routers ek saath | Row locks | Ek jeetta hai, doosra skip / next rep |
| Galat rule | Zod validation | Save hi nahi hota, saare errors ek saath |

---

# Phase 4 — Automation Engine (Hinglish)

## 1. Humne kya banaya — ek line mein

Ek **job queue** (Postgres table) aur ek **separate worker process** jo har naye lead ko 3 follow-up emails bhejta hai (30s, phir 1 din, phir 3 din baad) — jab tak lead reply na kare, appointment book na ho, deal won/lost na ho, ya lead opt-out na kare. Har message **[SIMULATED]** hai — kahin bhi asli email nahi jaata.

## 2. Queue kaise kaam karta hai — "kaun sa job pehle?"

File: `src/server/queue/queue.ts`

```
enqueueJob(idempotencyKey, runAt, ...)
  → UNIQUE index pe ON CONFLICT DO NOTHING → same key dobara bhejo to naya row nahi banega

claimDueJobs(workerId, limit, now)
  → ek hi UPDATE statement: "SELECT ... FOR UPDATE SKIP LOCKED" ke andar
  → do workers same job kabhi claim nahi kar sakte (locked row = skip, agla job uthao)
  → status pending/retry_scheduled → processing, lease 60s ke liye

completeJob() / failJob()
  → sirf tabhi update karta hai jab (lockedBy = mera workerId AND status = processing)
  → agar lease kisi aur ne le li (crash recovery ke baad), to update 0 rows return karta hai
    → purana worker apna result overwrite NAHI kar sakta ("stale worker" protection)

recoverAbandonedJobs()
  → jo job "processing" mein atka hai aur lease_expires_at nikal gaya (worker crash/hang)
  → use wapas retry_scheduled (ya attempts khatam ho gaye to failed) mein daal deta hai
```

## 3. Retry kaise kaam karta hai — transient vs permanent

File: `src/lib/job-errors.ts`, `src/lib/backoff.ts`

- **Transient** (503, timeout, network) → retry hoga, exponential backoff + jitter ke saath
  (`base × 2^(attempt−1)`, jitter isliye taaki 100 jobs ek saath fail ho to sab ek hi second pe retry na karein).
- **Permanent** (400 invalid email, koi handler nahi) → retry ka koi fayda nahi, seedha `failed`.
- Attempts khatam ho jaayein (default 5) → chahe transient ho, phir bhi `failed` — "Gave up after 5 of 5 attempts".

## 4. Workflow (follow-up sequence) kaise chalta hai

File: `src/server/workflows/nurture.ts`

```
Lead create hota hai
  → startNurtureWorkflow() → 1 workflow_run + 1 job (followup_1, delay = FOLLOWUP_1_DELAY_SECONDS)
  → worker job claim karta hai
  → SEND SE PEHLE: latest state DB se padho (reply aaya? appointment book hua? deal band hua? opt-out?)
      → koi bhi stop condition true → job "skipped" + run "stopped" (reason ke saath), aage kuch nahi hota
      → sab clear → message bhejo (idempotency key se — dobara bhejo to purana message dikh jaata hai, naya nahi jaata)
      → agla step schedule karo (followup_2 → +1 din, followup_3 → +3 din)
      → last step ke baad → run "completed"
```

**Idempotency ka matlab yahan:** agar worker crash ho jaaye message bhejne ke *baad* lekin job complete mark karne se *pehle*, to retry pe wahi handler dobara chalega — lekin `messages` table check karega "idempotency_key already sent hai?" → agar haan, dobara nahi bhejega. Isse ek hi step ka message kabhi 2 baar nahi jaata, chahe kitni baar retry ho.

## 5. Concurrency — do cheezein jo test hui

- **Ek hi lead event 5 baar concurrently aaye** (webhook retry jaisa) → `webhook_events` table ka UNIQUE(source, event_id) sirf ek ko "claim" karne deta hai, baaki 4 ko "duplicate_event" mil jaata hai turant, bina kuch dobara process kiye.
- **4 workers ek saath poll karein** → `SKIP LOCKED` ki wajah se har job sirf **ek** worker ko milta hai. Test: 6 jobs, 4 workers, koi bhi job 2 baar claim nahi hua.

## 6. Important files (Phase 4)

| File | Kaam |
|---|---|
| `src/server/queue/queue.ts` | Enqueue, claim (SKIP LOCKED), complete/fail, backoff, crash recovery, Retry Now, Cancel |
| `src/server/worker/runner.ts` | Handler registry, ek job process karna, poll loop (graceful shutdown `AbortSignal` se) |
| `src/server/workflows/nurture.ts` | Follow-up sequence, stop rules, opt-out, cancel |
| `src/lib/backoff.ts`, `job-errors.ts`, `followup-rules.ts` | Pure logic (18 unit tests, DB ki zaroorat nahi) |
| `src/server/integrations/messaging/mock-provider.ts` | SIMULATED sender, demo failure switch (off/transient/permanent) |
| `src/app/(app)/automations/page.tsx`, `failed-automations/page.tsx` | UI: worker status, job table, Retry/Cancel buttons |
| `scripts/worker.ts` | `npm run worker` (hamesha chalta rehta hai) aur `npm run worker:once` (ek baar chalke exit) |
| `scripts/demo-a.ts`, `demo-b.ts`, `demo-c.ts` | Teen repeatable demo scenarios |
| `tests/automation.integration.test.ts` | 26 real-Postgres tests |

## 7. Kya fail ho sakta hai

| Failure | Kaise pata chalta hai | Recovery |
|---|---|---|
| Messaging provider down (simulated) | Job `retry_scheduled`, error + next retry time `/failed-automations` pe | Automatic retry, ya person "Retry Now" dabaye |
| Worker crash beech mein | Lease expire ho jaata hai (60s) | Agla `recoverAbandonedJobs()` call use wapas queue mein daal deta hai |
| 5 attempts khatam | Job `failed` | Sirf tabhi retry hoga jab koi manually "Retry Now" dabaye |
| Do workers ek job try karein | `SKIP LOCKED` | Ek claim karta hai, doosra agla job uthata hai |
| Worker purana result bhejne ki koshish kare (stale lease) | `lockedBy`/`status` check `completeJob` mein | Update 0 rows — result discard, kuch overwrite nahi hota |

## 8. Interview mein kya bolein

*"Job queue Postgres mein hai, memory mein nahi — kyunki web app aur worker do alag processes hain (Vercel pe web app serverless hai, jo hamesha chalta process nahi rakh sakta). Dono ek hi database dekhte hain. Main real do-process test kar chuka hoon: production web server ek terminal mein, worker bilkul alag terminal mein — lead web se banaya, alag worker process ne use pick karke complete kiya, aur dashboard (jo web process serve karta hai) ne wo result dikhaya. Isse pata chalta hai ki architecture sach mein distributed hai, sirf code mein nahi."*

---

# Phase 5 — HighLevel Integration Layer (Hinglish)

## 1. Humne kya banaya — ek line mein

Har contact/opportunity change ke baad ek **outbox job** queue mein jaata hai (wahi Phase 4 wala queue), jo HighLevel CRM mein us record ko sync karta hai. Do implementations hain ek **CrmProvider interface** ke peeche: **MockCrmProvider** (default, kuch bhi asli nahi jaata, demo fault-injection switch hai) aur **HighLevelProvider** (asli HTTP calls, sirf `MOCK_MODE=false` par).

## 2. Docs pehle, code baad mein

Koi bhi endpoint likhne se pehle `marketplace.gohighlevel.com` ke asli docs padhe — kai third-party blogs galat cheezein bol rahe the (jaise "upsert endpoint hai hi nahi", jo sach nahi hai). Har URL aur check karne ki date `IMPLEMENTATION_LOG.md` mein likhi hai. **Koi endpoint guess nahi kiya.**

## 3. Outbox pattern — kaam kaise karta hai

```
Contact create/update ho gaya (transaction commit ke BAAD)
  → enqueueContactSync() → job "crm.sync_contact" (idempotency key: contactId + second-resolution timestamp)
  → worker job claim karta hai
  → provider.upsertContact() → HighLevel se contact id milta hai
  → contacts.ghl_contact_id column mein SAVE karo (ek baar)
  → agli baar sync ho to ye SAME id use karo (PUT/update), naya record kabhi nahi banega
```

**Idempotency ka asli matlab yahan:** `ghl_contact_id` / `ghl_opportunity_id` ek baar store hota hai aur har agli sync usi ko update karti hai — chahe job kitni baar retry ho, HighLevel mein sirf EK record banta hai.

## 4. Opportunity sync — ordering ka problem, simple solution

HighLevel mein opportunity banane ke liye pehle contact ka id chahiye. Lekin humara queue jobs ko ek dusre ka wait karna nahi sikhaata (no dependency graph). Isliye: agar `crm.sync_opportunity` job chale aur contact abhi tak sync nahi hua (`ghl_contact_id` null hai), to ye simply ek **TransientJobError** throw kar deta hai — matlab "retry karo baad mein". Backoff apne aap thodi der baad phir try karega, tab tak contact wala job complete ho chuka hoga. Koi complex scheduling nahi — sirf retry se ordering solve ho jaati hai.

## 5. Real HTTP client — 429, timeout, error classification

File: `src/server/integrations/crm/http-client.ts`

- Har call mein `Authorization: Bearer <token>` aur `Version` header jaata hai.
- **Timeout**: `AbortController` se, `HIGHLEVEL_HTTP_TIMEOUT_MS` (default 10s) ke baad request cancel — transient error maana jaata hai.
- **429 (rate limit)**: agar response mein `Retry-After` header hai to wo delay use hota hai; nahi to normal exponential backoff.
- **Error classification**: wahi `kindForHttpStatus()` jo Phase 4 mein bana tha — 401/400 = permanent (retry se fayda nahi), 429/5xx/timeout = transient (retry karo).
- Har call `integration_calls` table mein log hota hai — **headers kabhi log nahi hote**, isliye token kabhi database mein nahi jaata.

## 6. Mock provider bhi logging karta hai — kyun?

Default state `MOCK_MODE=true` hai, isliye demo/interview mein asli HighLevel kabhi nahi lagta. Lekin agar mock provider kuch bhi log na kare, to Integrations page khaali dikhega. Isliye `MockCrmProvider` bhi wahi `integration_calls` table mein har simulated call likhta hai — demo mein activity dikhti hai, bina asli API ke.

## 7. Ek asli bug jo sirf demo chalane se mila (tests se nahi)

`crm-sync.ts` ke handlers shuru mein `HIGHLEVEL_LOCATION_ID` hamesha maangte the — chahe mock mode ho ya nahi. Tests pass ho rahe the kyunki test file ne khud hi ye env variable set kar diya tha (fake value). Lekin jab maine `npm run demo:crm` chalaya (jahan `.env.local` mein ye khaali hai, jaisa mock mode mein hona chahiye), turant fail ho gaya: *"HIGHLEVEL_LOCATION_ID is not configured"*. Fix: `requireLocationId()` helper — mock mode mein placeholder value use karo, sirf live mode (`MOCK_MODE=false`) mein asli value maango.

**Interview mein kaam ki baat:** *"Tests hara (green) hona iska matlab nahi ki maine actually chala kar dekha. Is bug ne mujhe wahi sikhaya — isliye har phase mein main asli demo script bhi chalata hoon, sirf test suite pe bharosa nahi karta."*

## 8. Important files (Phase 5)

| File | Kaam |
|---|---|
| `src/server/integrations/crm/types.ts` | `CrmProvider` interface |
| `src/server/integrations/crm/mock-provider.ts` | Simulated + fault injection + logging |
| `src/server/integrations/crm/http-client.ts` | Asli HTTP client: auth, timeout, 429, logging |
| `src/server/integrations/crm/highlevel-provider.ts` | Asli endpoints (docs se, guess nahi) |
| `src/server/workflows/crm-sync.ts` | Outbox handlers: sync_contact, sync_opportunity, update_opportunity |
| `src/app/(app)/integrations/page.tsx` | Test connection, sync status, failure switch, stage mapping |
| `scripts/demo-crm.ts` | Outage → retry → recovery demo |
| `tests/crm-integration.test.ts` | 11 tests: mocked fetch (success/429/503/401/timeout) + real-DB idempotency |

## 9. Kya fail ho sakta hai

| Failure | Kaise pata chalta hai | Recovery |
|---|---|---|
| HighLevel down (simulated 503) | Job `retry_scheduled`, `/integrations` pe recent calls mein dikhta hai | Automatic retry, backoff ke saath |
| Bad token (401) | Job `failed` turant (permanent) | Token fix karo, phir manually Retry Now |
| Contact abhi tak sync nahi hua | Opportunity sync job transient error deta hai | Automatic retry — jab tak contact sync ho jaaye |
| Rate limited (429) | `Retry-After` respect hota hai | Automatic retry us delay ke baad |
| Stage mapping missing | Opportunity phir bhi sync hoti hai, bas stage id `null` jaata hai | Admin `/integrations` pe mapping bhar sakta hai |

---

# Phase 6 — Webhooks + n8n (Hinglish)

## 1. Humne kya banaya — ek line mein

6 endpoints (`/api/webhooks/leads`, `/contacts`, `/opportunities`, `/appointments`, `/payments`,
`/messages`) jo **bahar se** (website, n8n, HighLevel) events lete hain — koi bhi request pehle
**authenticate** hoti hai, tabhi kuch bhi database mein save hota hai. Ek n8n workflow bhi banaya aur
**Docker mein sach mein chalaya** — sirf likha nahi.

## 2. Do signature schemes — kyun alag alag?

File: `src/lib/webhook-signature.ts` (pure — DB ka koi kaam nahi)

- **Website / n8n (hamara apna scheme):** HMAC-SHA256, `timestamp.rawBody` pe. Header:
  `X-LeadFlow-Timestamp` + `X-LeadFlow-Signature`. Timestamp 5 minute se purana ho to reject — ye
  **replay attack** se bachata hai (koi purani request record karke dobara na bhej sake).
- **HighLevel:** Ed25519, sirf raw body pe (timestamp nahi). Header: `X-GHL-Signature`, base64 mein.
  Public key HighLevel ke docs mein **fixed** hai — kahin se fetch nahi karna padta, code mein hi
  default hai. Har cheez apply karne se pehle asli docs check kiye (2026-09-22) — kai blogs galat
  bata rahe the ki "upsert endpoint hai hi nahi" jab ki hai.

**Dono mein common:** signature check **DATABASE CHHUNE SE PEHLE** hota hai. Agar signature galat hai,
to `webhook_events` table mein ek row bhi nahi banti — koi bhi unauthenticated request ka trace tak
nahi bachta.

## 3. Fast acknowledge + job queue (outbox jaisa, par inbound)

```
Request aata hai
  → signature verify (galat ho to yahin 401, kuch save nahi hota)
  → JSON parse + basic shape check (400/422)
  → eventId nikalo (body ka eventId, ya HighLevel ka webhookId, ya header)
  → "leads" hai? → seedha ingestLeadEvent() call karo (wo already fast + idempotent hai)
  → baaki 5 types? → webhook_events mein ek row (UNIQUE source+eventId) + "webhook.process" job → 202 turant
  → worker job uthata hai → asli kaam (contact update, stage change, payment, etc.) karta hai
```

**Kyun "leads" alag hai:** `ingestLeadEvent` (Phase 4) khud hi apna `webhook_events` row banata hai. Agar
generic receiver BHI pehle ek row bana de, to `ingestLeadEvent` ka apna insert hamesha "already exists"
dekhega — pehli hi asli request "duplicate" dikhegi! Isliye leads seedha `ingestLeadEvent` ko call karta
hai, baaki 5 types generic queue wale raaste se jaate hain.

## 4. Payment → Won — real business logic

File: `src/server/services/payments.ts`

```
Payment webhook aaya
  → externalPaymentId se idempotent check (UNIQUE index) — dobara aaye to kuch nahi hota
  → deal ko "won" karo (wahi changeStage() jo Kanban board use karta hai)
  → onboarding checklist banao (4 tasks) — sirf agar pehle se nahi hai
  → audit log
```

Idempotency yahan **do jagah** hai: (1) `webhook_events` table — same webhook event dobara na chale,
(2) `payments.external_payment_id` — chahe kisi aur route se (retry, ya alag event) yehi payment
dobara aaye, deal dobara won nahi hoga aur checklist dobara nahi banegi.

## 5. Ek bug jo sirf test se pakda (hand-testing se nahi)

`processContacts` handler sirf email/phone se contact dhoondhta tha — agar payload mein seedha
`contactId` diya ho (jo real-world mein sabse common case hai, e.g. "is contact ka company field
update karo"), to wo IGNORE ho jaata tha aur naya contact banane ki koshish hoti, jisme `firstName`
missing hone se fail ho jaata. **"Replayed event returns the same result" test ne ye pakda** — maine
pehle manually test kiya tha jisme main hamesha email/phone bhej raha tha, isliye ye case chhoot gaya
tha. Fix: `contactId` seedha check karo pehle, phir existing contact ke values se missing fields bharo.

## 6. n8n — asli Docker mein chalaya, sirf JSON nahi likha

`docker pull n8nio/n8n` → import → activate → **real webhook URL pe curl** → asli LeadFlow server tak
pahuncha. Is process mein **4 real bugs** mile aur fix kiye:

1. `Module 'crypto' is disallowed` — n8n apne Code node mein Node ke built-in modules block karta hai
   by default. Fix: `NODE_FUNCTION_ALLOW_BUILTIN=crypto` env var.
2. `access to env vars denied` — `$env.WEBHOOK_SIGNING_SECRET` access karne ke liye
   `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` chahiye.
3. **Sabse important bug:** HTTP Request node mein maine `specifyBody: "raw"` likha tha — galat! Sahi
   parameter `contentType: "raw"` hai. Isse n8n **khaali body** bhej raha tha, lekin signature header
   (jo Code node ne sahi body se banaya tha) sahi hi bheja — matlab LeadFlow ko ek signature milta jo
   ek ALAG (empty) body se match nahi karta tha. Error sirf "signature does not match" bola, "body
   khaali hai" nahi bataya — n8n ka execution log (REST API se, authentication karke) dekh kar hi pata
   chala.
4. Set nodes ("Notify success/failure") default mein sirf apna naya field rakhte hain, baaki sab
   fields drop kar dete hain — `includeOtherFields: true` set karna pada.

**Interview mein kaam ki baat:** *"Maine sirf workflow JSON likh kar chhoda nahi — actually Docker mein
n8n chala kar, real webhook trigger karke, real bugs fix kiye. Isse pata chalta hai ki main sirf
'documentation ke hisaab se sahi lagta hai' pe nahi rukta, cheezein chala kar dekhta hoon."*

## 7. Important files (Phase 6)

| File | Kaam |
|---|---|
| `src/lib/webhook-signature.ts` | HMAC + Ed25519 verification (pure, 13 tests) |
| `src/server/http/webhook-route.ts` | Sabhi 6 routes ka shared logic |
| `src/server/services/webhooks.ts` | Idempotent claim + job enqueue |
| `src/server/workflows/webhook-process.ts` | Job handler — resource type ke hisaab se dispatch |
| `src/server/services/payments.ts`, `appointments.ts`, `notifications.ts` | Payment→Won, appointment upsert, SIMULATED notification |
| `src/app/(app)/webhooks/page.tsx` | Webhook Events screen + Reprocess button |
| `scripts/webhook-send.ts` | Signed test sender |
| `n8n/leadflow-lead-intake.json` | Importable n8n workflow |
| `tests/webhook-signature.test.ts`, `webhooks-integration.test.ts` | 26 tests |

## 8. Kya fail ho sakta hai

| Failure | Kaise pata chalta hai | Recovery |
|---|---|---|
| Galat/purani signature | 401, `/webhooks` pe kabhi row hi nahi banti | Sender apna secret/clock theek kare |
| Same event dobara aaye | `webhook_events` UNIQUE constraint | Original result hi wapas milta hai, kuch dobara nahi hota |
| Payload mein zaroori field missing | Job "failed", clear error message | Person `/webhooks` pe dekh kar payload fix kare, phir Reprocess |
| Contact resolve nahi hua (email/phone match nahi) | "No contact found matching..." | Sahi identifier bhejo, ya pehle contact banao |
| Worker down | Jobs "pending" rehte hain, kabhi lose nahi hote | Worker start karo, sab process ho jaayega |

---

# Phase 7 — Appointment Booking (Hinglish)

## 1. Humne kya banaya — ek line mein

Ek function, `bookAppointment()` — chahe koi UI se book kare ya webhook se (external calendar) — dono EK HI function call karte hain, isliye stage change, follow-up rukna, confirmation message, reminders, rep ko notification, aur HighLevel sync — sab **ek saath** hota hai, kabhi aadha-adhura nahi.

## 2. DST-safe scheduling — sabse tricky wala part

File: `src/lib/scheduling.ts` (pure — koi DB nahi, isliye fast test hota hai)

Rep ke working hours unke **apne** timezone mein hain (e.g. "09:00–17:00" America/New_York mein). Lead ko slots **unke** timezone mein dikhte hain. Problem: saal mein 2 din aise hote hain jab clock aage/peeche hoti hai (DST) — us din 9am se 5pm tak ka "8 ghanta" waqt actually UTC mein 7 ya 9 ghante ka ho sakta hai!

**Solution:** Har din ka start/end time ALAG SE calculate karo us specific date ke liye — `zonedTimeToUtc()` (Phase 1 se already bana hua) har baar us din ka sahi UTC offset nikalta hai. Isliye chahe DST switch ho jaaye, 9am local hamesha 9am local hi rehta hai, sirf UTC time badalta hai.

**Test se proof:** 2026-03-08 (spring forward) aur 2026-11-01 (fall back) — dono transitions pe test likha ki ek working day mein poori 8 slots milti hain, aur pehli slot ka local time (09:00) UTC mein alag hota hai transition ke pehle vs baad — matlab hamara code ye handle karta hai, sirf claim nahi karta.

## 3. Double-booking — do layers of protection

1. **Application layer:** `bookAppointment()` insert karne ki koshish karta hai.
2. **Database layer (asli guarantee):** Postgres ka `EXCLUDE USING gist` constraint — agar same rep ke do appointments ka time overlap ho (aur dono cancelled na hon), to Postgres **khud** insert reject kar deta hai. Ye drizzle-kit ke schema tool se nahi ban sakta, isliye migration file mein **haath se** likha.

**Kyun dono layers?** Application check race condition mein fail ho sakta hai (do requests EK HI second mein aayein) — lekin database constraint kabhi fail nahi hota, chahe kitni bhi requests ek saath aayein. Test: 2 concurrent booking requests same rep, same time ke liye → hamesha exactly 1 "booked" aur 1 "conflict", kabhi 2 "booked" nahi.

## 4. "One flow" — booking ke baad kya kya hota hai

```
bookAppointment() call hua
  → appointment row insert (EXCLUDE constraint safe)
  → opportunity stage → "appointment_booked" (existing changeStage())
  → nurture workflow turant ROKO (agla poll wait nahi karna — naya function stopWorkflowForContact())
  → SIMULATED confirmation email
  → reminder jobs: 24h pehle + 1h pehle (agar wo time already nikal chuka hai to SKIP — late reminder kabhi nahi)
  → rep ko SIMULATED notification
  → lead ka score recalculate (appointment factor badal gaya)
  → HighLevel calendar sync job queue mein
```

Sab EK function ke andar — UI form aur webhook dono yehi function call karte hain, isliye kabhi "UI se booking full hui, webhook se adhoori reh gayi" jaisa bug nahi ho sakta.

## 5. Reminders — cancelled slot ke liye kabhi nahi jaate

Do jagah protection:
1. Cancel karte waqt: sab pending reminder jobs turant "cancelled" ho jaate hain (`cancelPendingJobsForAppointment`).
2. **Defense in depth:** agar koi reminder job EXACTLY usi second claim ho jaaye jab cancel ho raha hai (race condition), to handler khud appointment ka CURRENT status check karta hai bhejne se pehle — cancelled dikha to seedha skip, message kabhi nahi bhejta.

Test ne dono prove kiya: (a) cancel karne se job "cancelled" ho jaata hai, (b) agar handler ko force se chalaya jaaye ek cancelled appointment ke liye, to bhi wo skip karta hai.

## 6. Ek bug jo sirf `npm run build` ne pakda (tests ne nahi)

Teen server actions (`markNoShowAction` waghera) pehle aise likhe the: `export const x = (...) => ...`. TypeScript khush tha, saare 216 tests pass ho rahe the — lekin `next build` fail ho gaya: "export nahi mila"! Next.js ke Server Actions compiler ko har action **seedha `async function`** chahiye, arrow function wrapper nahi, apne internal action-manifest ke liye.

**Interview mein kaam ki baat:** *"Isliye main hamesha `npm run verify` mein build bhi chalata hoon, sirf typecheck aur tests nahi — kuch bugs SIRF build time pe pakde jaate hain, jaise ye wala."*

## 7. Important files (Phase 7)

| File | Kaam |
|---|---|
| `src/lib/scheduling.ts` | DST-safe slot generation (pure, 11 tests) |
| `drizzle/0004_appointments_booking.sql` | Working hours columns + hand-written EXCLUDE constraint |
| `src/server/services/appointments.ts` | `bookAppointment`, reschedule, cancel, no-show, completed |
| `src/server/workflows/appointment-reminders.ts` | 24h/1h reminder handlers |
| `src/app/(app)/appointments/page.tsx` | Booking form + row actions |
| `src/components/settings/working-hours-editor.tsx` | Rep working hours editor |
| `tests/scheduling.test.ts`, `appointments-integration.test.ts` | 21 tests |

## 8. Kya fail ho sakta hai

| Failure | Kaise pata chalta hai | Recovery |
|---|---|---|
| Double-booking koshish | Database EXCLUDE constraint reject karta hai | Clean "conflict" message, koi raw error nahi |
| Contact/rep nahi mila | "not_found" status | Person sahi id check kare |
| Reminder time already nikal gaya | Job enqueue hi nahi hota | Koi late reminder nahi jaata |
| Appointment cancel ho gaya reminder se pehle | Job cancelled, ya handler khud skip karta hai | Kabhi galat reminder nahi jaata |
| Contact HighLevel pe sync nahi hua abhi | `crm.sync_appointment` retry karta hai | Automatic — jab contact sync ho jaaye |

# Phase 8 — Polish, Demo Page, Login, Real Browser Tests (Hinglish)

## 1. Humne kya banaya — ek line mein

Koi naya integration nahi is phase mein — ye pura "product ko interview-ready banane" wala phase tha: purane failed jobs ko dhundna/retry karna aasan banaya, dashboard mein asli reporting queries daali, ek `/demo` page banaya jo ek asli fake lead ko poore pipeline se guzarta hai, ek simple password-gate lagaya, aur sabse important — ek REAL bug dhoondh ke fix kiya jo pehle sirf "documented, not investigated" tha.

## 2. No-JS form hang bug — sabse bada catch is phase ka

Project ke apne notes mein likha tha: *"No-JavaScript form fallback hang ho jaata hai... root cause investigate nahi kiya gaya abhi tak."* Humne isko **actually investigate kiya**, sirf likha nahi.

**Kaise dhoonda:** Wahi raw HTTP technique jo Phase 6 se use ho rahi hai — server-rendered HTML se real `$ACTION_ID_*` hidden field nikalo, usko multipart POST karo BINA `Next-Action` header ke (yahi ek plain HTML form karta hai jab JavaScript band ho). Result: form hang ho gaya, jaisa notes mein tha.

**Root cause elimination se nikala, guess se nahi:**
1. `revalidatePath` hata diya — phir bhi hang
2. Database call hata diya — phir bhi hang
3. Action ko ekdum khaali kar diya (kuch bhi na kare, bas ek fixed object return kare) — **phir bhi hang!**

Isse pata chala: is Next.js build mein, **`useActionState` se juda koi bhi form action jo `redirect()` call nahi karta, wo no-JS submission ke liye hamesha hang ho jaata hai** — chahe usme koi application code ho ya na ho. Ye ek framework-level cheez hai, apna code ka bug nahi tha.

**Fix:** `createContactAction` mein pehle se hi ye pattern tha — success pe `redirect()`, sirf error pe hi state return karo. Teeno affected actions (`logReplyAction`, `updateRepAction`, `saveRuleAction`) ko wahi pattern diya. Verify kiya same raw-HTTP technique se: pehle jo hang hota tha, ab 0.5 second mein 303 redirect deta hai, aur database mein change bhi ho chuka hota hai.

**Honest caveat:** "error pe state return karo" wala half abhi bhi untested hai no-JS ke against — humne sirf success path test kiya. Isliye is phase ke 2 naye forms (`/login`, `/demo`) ne is uncertainty ko avoid hi kiya — dono **hamesha redirect karte hain, error pe bhi**, taaki wo purani, half-unproven cheez pe depend hi na karna pade.

## 3. `/demo` page — scripted animation nahi, asli service call

Bahut projects mein "demo mode" ka matlab hota hai fake data ka ek pre-recorded animation. Yahan aisa nahi kiya — `/demo` page ka "Create a demo lead" button **wahi `createContact()` service call karta hai jo real intake form karta hai** (duplicate check, scoring, routing, workflow — sab). Phir jo timeline dikhta hai, wo `audit_logs` table se seedha aata hai (`getContactDetail()` ka already-existing `.timeline` field, jo contact ki detail page bhi use karta hai) — matlab jo dikh raha hai wo asli database rows hain, koi scripted UI nahi.

"Reset demo data" bhi sirf `demo-live` tag wale contacts delete karta hai — kabhi seed data ya real form se bane contacts ko touch nahi karta.

## 4. Simple admin login — `middleware.ts` nahi, `proxy.ts`

Is Next.js version mein `middleware.ts` deprecate ho chuka hai, naam badal ke `proxy.ts` ho gaya hai (Next 16.0.0 se) — behavior same hai, sirf file/function ka naam badla. `AGENTS.md` (khud `next dev` generate karta hai) pehle se warn karta hai ki "ye wo Next.js nahi jo tumhe pata hai, docs check karo" — to `node_modules/next/dist/docs/` mein check kiya aur sahi naam use kiya.

Login simple hai: ek shared password (`ADMIN_PASSWORD` env var), ek signed httpOnly cookie (HMAC se sign kiya, password khud cookie mein kabhi nahi jaata). `/api/webhooks/*` is gate se **bahar** hai jaan-boojh kar — HighLevel/n8n browser session nahi rakh sakte, unke paas already apna signature check hai (Phase 6). `ADMIN_PASSWORD` set na ho to app pura khula rehta hai (local dev ke liye convenient), bas ek console warning aata hai.

## 5. Real browser tests — Playwright, mocking nahi

Ye pehli baar hai project mein real browser test (pehle sirf HTTP status/HTML text check hota tha). 5 tests: Kanban drag-drop, contact form, "Retry now", aur demo page (create + reset).

**Sabse interesting cheez:** Kanban board **native HTML5 drag-and-drop** use karta hai (`draggable` + `dataTransfer`, koi JS library nahi). Playwright ka seedha `dragTo()` function isko trigger hi nahi karta tha — hume manual `mouse.down()` → do intermediate `mouse.move()` → `mouse.up()` sequence likhni padi, jaisa Playwright ke apne docs recommend karte hain native HTML5 DnD ke liye.

**Dusri cheez jo sikhaayi:** Pehli baar test run hua to pass hua, doosri baar fail. Kyun? Har test run ek naya contact bana raha tha same naam se ("Playwright E2E") — doosri run mein purane run ka leftover card interfere kar gaya. Fix: har test ka apna **unique naam** (timestamp ke saath), aur test khatam hone pe apna banaya hua contact `finally` block mein delete karna. Ye exact wahi lesson hai jo Phase 7 ke `farFutureSlot()` bug mein mila tha — **test data collision real bugs jaisa hi dikhta hai, isliye tests ko khud isolated rakhna padta hai.**

## 6. Important files (Phase 8)

| File | Kaam |
|---|---|
| `src/proxy.ts`, `src/lib/admin-session.ts` | Admin login gate + signed cookie |
| `src/app/(app)/demo/page.tsx`, `src/app/actions/demo.ts` | Demo scenario page |
| `src/components/automations/bulk-retry.tsx` | Failed jobs table + bulk retry |
| `playwright.config.ts`, `e2e/*.spec.ts` | Real browser tests |

## 7. Kya fail ho sakta hai

| Failure | Kaise pata chalta hai | Recovery |
|---|---|---|
| Galat admin password | Redirect `/login?error=1` | User dobara try kare |
| `ADMIN_PASSWORD` set nahi hai | Console warning, app khula rehta hai | Env var set karo prod ke liye |
| Demo lead create fail ho (duplicate email clash) | `?error=...` query param | Bahut rare — timestamped email hai |
| Retry button click ke baad "Queued" message turant gayab | `revalidatePath` poori list refresh kar deta hai | Row list se gayab hona hi asli confirmation hai |
