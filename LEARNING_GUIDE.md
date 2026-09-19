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
