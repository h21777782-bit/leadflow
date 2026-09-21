# Implementation Log

Honest record of what was built, what broke, and how it was fixed.
Newest phase at the top.

---

## Phase 4 — Automation engine 🟡 IN PROGRESS (handed off)

**Status:** core engine built and verified; UI, integration tests, demo scripts and Phase 4 docs are
**not done**. See `HANDOFF.md` for the exact state and `NEXT_PROMPTS.md` (Prompt 1) to finish it.

**Actually run at handoff:** `npm run verify` → typecheck ✓, lint ✓, 132 tests ✓ (18 new unit tests
for backoff, error classification, follow-up stop rules), build ✓. Migration 0002 tested on a copy of
real data. Worker smoke test: success, simulated transient failure → retry_scheduled → Retry Now →
completed, exactly one message per step.

**Decision worth knowing:** drizzle-kit generated a drop-and-recreate of the `job_status` enum, which
would have failed on existing rows. The migration was hand-edited to `ALTER TYPE … RENAME VALUE`.

**Also changed:** `next.config.ts` allows server actions from `*.app.github.dev` so the app works in
GitHub Codespaces (untested there).

---

## Phase 3 — Lead scoring & smart routing ✅

**Date:** 2026-09-20
**Pre-check:** Phase 2 verified before starting — clean git tree, 58/58 tests passing,
all Phase 2 services present. No missing dependencies.

**Verification (all actually run, all passing):**
- `npm run typecheck` ✓ · `npm run lint` ✓ (0 warnings) · `npm run build` ✓
- `npm test` → **114 tests in 10 files** (56 new: 19 scoring unit, 24 routing unit, 13 real-Postgres
  integration). All 58 Phase 1–2 tests still pass (no regression).
- Production-server checks: every page 200; form-created lead scored + routed; Settings
  "unavailable" moved a not-yet-contacted lead and kept an in-conversation lead; reassignment audited.
- All 5 new server actions called with **React's own `encodeReply`** (the exact browser encoding)
  against the production server: log reply (score 81 → 84), rep update, missing-capacity
  rejection, invalid rule (all errors at once), valid rule saved, Route now.
- `npm run demo:routing` executed end to end against the dev database.

### Completed

**Scoring engine** (`src/lib/scoring.ts`, pure):
budget 30 · service 20 · engagement 20 · response 15 · appointment 15 = 100.
Hot ≥70, Warm 40–69, Cold ≤39. Config object with a self-check (`validateScoringConfig`).
Unknown data gets **neutral credit** (budget 12/30, service 8/20, "not contacted yet" 7/15,
"no appointment yet" 5/15); invalid numbers (negative, NaN, Infinity) are treated as unknown.
Only explicit evidence lowers a factor (tiny budget, 2+ unanswered attempts, no-show).
Every factor carries a human-readable reason.

**Routing engine** (`src/lib/routing.ts`, pure):
rules in priority order → conditions (service, country, source, min budget) → eligibility
(active, available, under capacity, optional "must sell the service") → specialist preference →
fair choice (`assign_user` ordered list / `round_robin` least-recently-assigned /
`least_loaded` lowest workload ratio; deterministic tie-break). A matched rule with nobody
eligible falls through to the next rule. No eligible rep → **Unassigned with a reason**, never a
silent bad assignment. Full rule-by-rule trace kept for every decision.

**Reassignment policy** (`decideRoutingNeed`, explicit and tested):
no open deal → never · manual owner → never automatically (only "Route now") · no owner → route ·
owner unavailable/inactive AND lead not contacted yet → reassign · owner unavailable but lead in
conversation → keep, needs a person · otherwise sticky ownership.

**Persistence & concurrency** (`src/server/services/lead-intelligence.ts`):
- Score: contact row locked, score/band/timestamp stored on `contacts`, history row in
  `lead_scores` only when something changed, `lead.scored` audit on change.
- Routing transaction: lock contact → lock all rep rows in id order (no deadlocks) → count workload
  under lock → decide → update contact + open opportunities + rep `last_assigned_at` →
  `routing_decisions` row → audit. Repeating an identical unassigned result is a no-op.
- Triggers wired into existing services: contact created/updated/merged, opportunity created,
  stage changed, reply logged, rep availability/capacity changed, routing rule saved, "Route now".
- Scoring/routing runs **after** the triggering change commits; a failure is audited as
  `lead_intelligence.failed` and never undoes the contact/deal change.

**UI:** dashboard (Hot/Warm/Cold counts for open leads, Unassigned list with reasons, rep workload
bars, latest routing decisions) · lead page (score + per-factor breakdown + score history, owner +
provenance, Unassigned box with **Route now**, routing decisions with rule-by-rule trace,
**Log a reply** form) · pipeline cards and contacts list show score/band and Unassigned reasons ·
Settings: per-rep availability/active/capacity form, editable + new routing rules, scoring rules explained.

**Demo:** `npm run demo:routing` (8 steps, real services, fictional leads tagged `demo-scenario`).

### Database changes (migration `drizzle/0001_scoring_routing.sql`)

- New table **`routing_decisions`** (outcome assigned/reassigned/unassigned, assigned & previous rep,
  rule, trigger, reason, jsonb trace).
- `contacts`: `lead_score`, `lead_band`, `scored_at`, `assignment_source` (routing/manual/seed),
  `assigned_at`, `unassigned_reason`; index on `lead_band`.
- `users`: `is_active`. `messages`: `direction` (outbound/inbound). `lead_scores`: `trigger`, `config_version`.
- Enum `routing_strategy` + `least_loaded`; new enums `message_direction`, `routing_outcome`.
- Seed: brand-new leads now have no owner and are routed by the real engine during seeding;
  contacted leads have `[demo seed]` inbound replies; fallback rule requires service expertise.

### Architectural decisions

| Decision | Why |
|---|---|
| Pure engines + thin DB service | Every business rule unit-tested without a DB; the service only loads, locks, persists. |
| Lock all rep rows (small table) during routing | Simple, provably correct capacity protection. Trade-off: routing is serialized — fine at agency scale; per-rep advisory locks are the scale-up path. |
| Lock order contact → reps (by id) | Consistent order means two routers cannot deadlock. |
| Score denormalized on `contacts` + history table | Fast dashboards/lists, and an audit trail of why the score moved. |
| Sticky ownership | Reassigning a lead someone is already talking to damages the relationship. |
| Manual assignments are never auto-changed | A human decision beats a rule. "Route now" is the explicit override. |
| Synchronous post-commit processing | No worker exists yet (Phase 4). Documented; will move to jobs. |

### Errors encountered and fixes

1. **Partial updates silently unassigned leads.** Validation turned `""` into `undefined`, so
   "ownerId not sent" and "ownerId cleared" looked the same; an update without `ownerId` removed the
   owner. Fixed: absent `ownerId` = keep owner. Caught by an integration test.
2. **Manual owner change didn't update the open opportunities' owner** (they drifted apart). Fixed in
   the same transaction; a test now asserts no open deal's owner differs from its contact's.
3. **Duplicate score-history rows on every recalculation.** Postgres `jsonb` reorders object keys, so
   `JSON.stringify` comparison always saw a change. Added `stableStringify` (sorted keys); the same
   latent bug in the contact field diff (custom fields) was fixed too.
4. **Capacity silently set to 0.** `Number(null) === 0` when the capacity field was missing. Now rejected
   with an error. Found during end-to-end testing.
5. Two test expectations were wrong, not the engine (a lead released by an earlier test was correctly
   picked up later). Tests now assert the real behaviour with a comment explaining it.
6. A misleading test (`exact69` asserted 68) was rewritten so names match what is checked.
7. The demo script's final message claimed "Ben stays with Neha" after Ben had moved; the script now
   prints what the engine actually did at every step.

### Known limitations (honest)

- **No-JavaScript form fallback hangs** for forms that stay on the page after saving (log reply, rep
  settings, routing rules): the data IS saved, but the production server (Next 16.3.5) never sends the
  response. Forms that redirect (create/edit contact) are fine. Normal browsers use the JavaScript path,
  which was verified. Root cause not investigated yet.
- Not verified in a real browser (none installable in the sandbox): drag-drop, the rule editor's open/close
  UI, optimistic updates. Server behaviour of every action was verified.
- Scoring config is a code constant (versioned), not editable in the UI. Routing rules ARE editable.
- Engagement uses replies + profile completeness only; email opens/clicks/site visits are not tracked.
- Replies are logged manually until inbound webhooks exist (Phase 6).
- Routing runs synchronously in the request; no retry if it fails (audited only) — Phase 4/5.
- `npm run demo:routing` also re-routes seed leads, so run `npm run db:seed` first for identical output.
- No authentication (actions attributed to the demo admin).

### Remaining phases

4 job queue + worker + follow-up workflows · 5 HighLevel integration layer + retries/backoff/429 ·
6 webhooks + signatures + n8n · 7 appointment booking + reminders · 8 failed-automation retry,
Demo Scenario, dashboard polish · 9 FAILURE_STORY.md and final docs.

---

## Phase 2 — Contacts, duplicates, opportunities, stage changes, audit ✅

**Date:** 2026-09-19
**Verification (all passing):** `npm run verify` → typecheck ✓ · lint 0 warnings ✓ ·
**58 tests** (7 files; 26 new: 13 validation/rule unit tests + 13 real-Postgres service tests) ·
production build ✓ · **19/19 end-to-end HTTP checks** against the production server
(real server actions, real database — see "How Phase 2 was verified").

### Completed (database-backed, not UI-only)

- **Contact creation** (`/contacts/new`): Zod validation (all errors in one round),
  email/phone normalization, duplicate check, contact + optional New-lead
  opportunity + initial stage-history row + audit entries in **one transaction**.
- **Duplicate detection**: by normalized email and E.164 phone. Reports *which*
  contact matched and on what (email / phone / both). If email matches one person
  and phone matches another, both are reported and nothing is merged.
  Race-safe: 5 concurrent identical submissions → exactly 1 contact (tested).
- **"Update this contact instead"** (merge): non-empty values overwrite, empty values
  never erase, tags unioned, custom fields merged, notes appended, owner only filled
  if empty. Refuses if the details also match a third contact.
- **Contact editing** (`/contacts/[id]/edit`): row-locked update, duplicate check
  excluding itself, per-field change list in the audit log, "unchanged" when nothing
  changed (no empty audit rows). Owner change → extra `owner.changed` audit entry
  flagged as a manual override.
- **Opportunity creation**: automatically with a new contact, or "Add another
  opportunity" on the lead page (a contact can have several deals).
- **Stage changes** — single code path `changeStage()` used by the Kanban board
  (drag-and-drop + "Move to" menu for touch/keyboard) and the lead page:
  - `SELECT … FOR UPDATE` row lock;
  - optimistic-concurrency check (`expectedFromStage`) → a stale move returns a
    conflict instead of overwriting someone else's move;
  - rules: lost needs a reason; reopening a won/lost deal needs a reason and is
    logged as `manual.override`; status/won_at/lost_at/lost_reason kept consistent;
  - writes `stage_history` + `stage.changed` audit (+ `opportunity.won/lost`) in the same transaction.
- **Audit writes** for: contact.created, contact.updated, contact.merged, owner.changed,
  opportunity.created, stage.changed, opportunity.won, opportunity.lost, manual.override.
- Demo labelling: every seeded contact now carries the visible tag **`demo-data`**
  (shown as a badge in the contacts list); seeded failures still say `[demo seed]`.

### Architectural decisions

| Decision | Why |
|---|---|
| Business rules in `src/server/services`, server actions are thin wrappers | Same rules will be reused by webhooks (Phase 6) and automations (Phase 4). |
| Pure rule modules (`lib/validation/contact.ts`, `lib/stage-rules.ts`) | Unit-testable without a database. |
| Services return result objects (`created` / `duplicate` / `invalid` / `conflict`) instead of throwing | Expected outcomes are not errors; the UI can show exactly what happened. |
| Unique-violation (SQLSTATE 23505) translated back into "duplicate" | The check-then-insert race becomes a normal answer, not a 500. |
| Row lock + `expectedFromStage` for stage changes | Two people dragging the same card: one succeeds, the other is told to refresh (tested concurrently). |
| Audit written inside the same transaction | The log can never describe a change that was rolled back. |
| `useOptimistic` on the Kanban board | Card moves instantly; if the server refuses, React drops the optimistic state automatically. |
| Acting user = `DEMO_ACTOR_EMAIL` (default seeded "Ops Admin") | **No login exists yet.** Documented limitation. |

### Errors encountered and fixes

1. **Validation reported errors in two rounds.** Zod skips `superRefine` when base
   fields fail, so "email or phone required" only appeared after fixing other errors.
   Caught by an integration test; `validateContact` now re-checks the cross-field rule.
2. **Contacts list would duplicate rows** once a contact has 2+ opportunities (plain JOIN).
   Replaced with a sub-query for the latest deal's stage plus a deal count.
3. **No headless browser available in the sandbox** (Playwright download blocked).
   Verified instead by submitting the real forms over HTTP exactly as a no-JavaScript
   browser would (React's hidden action fields) and calling the Kanban server action
   with its `Next-Action` id — then checking the database rows.

### How Phase 2 was verified end-to-end (sandbox, production build)

Create contact via form → 303 redirect, row with `+919890123456`, opportunity
`new_lead:4200`, audit rows · duplicate (different case + phone format) → warning with the
existing name, still 1 row · invalid form → both field errors shown · edit with owner
change → `contact.updated` + `owner.changed` · Kanban action: move accepted, stale move
→ conflict, lost without reason → rejected, lost with reason → accepted · stage history
`new_lead,contacted,lost` · lead page, pipeline and activity log show the new data.

### Known limitations after Phase 2

- No authentication; all UI actions are attributed to the demo admin.
- Drag-and-drop, the reason dialog, and optimistic rollback were **not exercised in a real
  browser** (no browser in the sandbox). The server side of every move was tested.
- The "Update this contact instead" button's server action is covered by service tests,
  not by the HTTP end-to-end run.
- Opportunity value/title editing and contact deletion are not built.
- `last_contacted_at` / `next_follow_up_at` are not editable in the form; they will be set by
  the follow-up automation (Phase 4).
- New contacts are **not** auto-assigned or scored yet (Phases 3). No messages are sent,
  no jobs run, and there is no HighLevel call — those systems do not exist yet.

---

## Phase 1 — Foundation, database, demo data, read-only UI ✅

**Date:** 2026-09-19
**Verification (all passing):** `npm run typecheck` · `npm run lint` (0 warnings) ·
`npm test` (31 tests, incl. 6 real-Postgres integration tests) · `npm run build` ·
every page returned HTTP 200 from the production server · DB-outage test
(see below).

### Completed

- Next.js 16.3.5 (App Router, Turbopack), React 19.2, TypeScript strict, Tailwind v4.
- Drizzle ORM 0.45 + postgres.js; initial migration `drizzle/0000_init.sql`
  containing the **complete 16-table schema for all phases**.
- Zod-validated environment config (`src/lib/env.ts`); `MOCK_MODE` defaults to `true`;
  HighLevel credentials required only when `MOCK_MODE=false`.
- Normalization for duplicate detection: lower-cased email, E.164 phone
  (`libphonenumber-js`, uses the lead's country for local-format numbers).
- Timezone helpers on the built-in `Intl` API (DST-aware wall-clock → UTC).
- Transactional demo seed: 6 users, 5 routing rules, 24 leads across all 9
  stages, 99 stage-history rows, 10 appointments, 24 workflow runs, 45 messages,
  10 jobs (incl. 2 dead + 1 retrying **labelled `[demo seed]`**), 12 integration-call
  rows, 2 payments, 8 onboarding tasks, 249 audit-log entries.
- Read-only UI for all 10 pages + lead details, `/api/health`, error boundary,
  404 page.
- `docker-compose.yml` for local Postgres; README with 3 DB setup options.

### Architectural decisions

| Decision | Why |
|---|---|
| Full schema in Phase 1 | Later phases add behaviour, not tables → fewer migrations, stable seed. |
| Duplicate protection via **UNIQUE indexes** (contacts, webhooks, jobs, messages, one running workflow per contact) | App-level "check then insert" can race; the DB cannot. Proven by integration tests. |
| Drizzle over Supabase JS client | Typed SQL, migrations in git, works with any Postgres (Supabase local/cloud or Docker). |
| All reads in `src/server/queries` | Pages never build SQL; queries testable in one place. |
| `await connection()` in each page | Marks pages as request-time rendered (Next 16 API) so the build never touches the DB. |
| Separate `TEST_DATABASE_URL` | The integration suite wipes and reseeds; must never hit the dev DB. |
| Demo emails use `.example` TLD | Reserved domain (RFC 2606) — can never reach a real inbox. |
| Money as integer whole units + currency | Avoids float rounding; demo doesn't need cents. |
| Lead scores **not** seeded yet | The scoring engine is Phase 3; scores will be computed by the engine, not hand-typed. |

### Errors encountered and fixes

1. **npm ERESOLVE: vitest 5 peer-requires `@types/node` ≥ 22** (scaffold ships ^20).
   Fixed by upgrading `@types/node` to ^22 (we run Node 22). Did **not** use `--force`.
2. **apt could not install Postgres in the sandbox** (a third-party apt repo returned 403).
   Moved that repo aside, installed PostgreSQL 16 from Ubuntu's repo. Sandbox-only issue.
3. **3 UK demo phone numbers rejected as invalid.** `07700 900xxx` is Ofcom's
   drama/fiction range, which libphonenumber marks invalid, so `phone_e164` was NULL
   (duplicate detection would silently not work for those leads). Replaced with valid
   numbers and added a unit test asserting every seed phone normalizes.
4. **Integration tests were wiping the development database.** Introduced
   `TEST_DATABASE_URL`; tests are skipped when it is not set.
5. **Vitest config loaded as CommonJS warning.** Renamed to `vitest.config.mts`
   and replaced `__dirname` with `import.meta.url`.
6. **Next.js 16 breaking changes** (checked in `node_modules/next/dist/docs`):
   error boundaries receive `retry` (not only `reset`); `PageProps<"/contacts/[id]">`
   types only exist after `next typegen` → `typecheck` script now runs it first.
7. **TypeScript narrowing bug** in `stagePath` (`filter` kept `"lost"` in the type). Annotated the array.
8. **ESLint `react-hooks/purity` error:** `Date.now()` during render on the
   Appointments page. Moved the upcoming/past split into the query layer.
9. **Runtime 500 on `/dashboard`** — found only by running the production server:
   a JS `Date` passed into a raw `sql` template; postgres.js can't serialize it there.
   Fixed with `toISOString()::timestamptz` and added a regression integration test
   that executes every UI read query against real data.
10. **Documented demo command didn't work:** an inline `tsx -e` import for config
    validation failed (module interop). Replaced with a proper `npm run env:check`
    script and re-ran both the valid and invalid paths before documenting them.
11. **Sandbox process management:** `pkill -f "next start"` matched and killed the
    shell running it. Tooling mistake only, no code change.

### Verified failure behaviour (demo/test, local sandbox)

- Postgres stopped → `/api/health` returns **503** `{"status":"degraded", "error":"database unreachable"}`
  (raw error hidden in production); pages return 500 and the client shows the
  "could not load its data" error screen.
- Postgres started again → next request returns 200 with no app restart
  (connection pool reconnects).
- `next build` succeeds with **no `.env.local` and Postgres stopped**.

### Not verified in Phase 1 (stated honestly)

- Visual appearance was not checked in a real browser (no browser in the build sandbox).
  HTML output and all routes were checked with HTTP requests.
- The error screen renders client-side after hydration; the server response was
  verified (500 + Next.js error payload), the rendered screen was not.
- `docker-compose.yml` and the Supabase CLI path were not executed in the sandbox
  (no Docker available); the app was tested against native PostgreSQL 16.

### Remaining work (as of Phase 1 — Phase 2 is now done, see above)

- Phase 3: routing + scoring engines (and scoring the seed leads).
- Phase 4: job queue worker, workflow engine, follow-ups.
- Phase 5: integration layer (Mock + HighLevel), retries/backoff/429.
- Phase 6: webhooks + signatures + n8n workflow JSON.
- Phase 7: appointment booking + reminders.
- Phase 8: failed-automation retry, dashboard polish, Demo Scenario.
- Phase 9: INTERVIEW_GUIDE.md, FAILURE_STORY.md, final README.
- Cross-cutting: authentication is out of scope for the local demo (documented).
