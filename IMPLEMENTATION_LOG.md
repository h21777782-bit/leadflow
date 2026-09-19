# Implementation Log

Honest record of what was built, what broke, and how it was fixed.
Newest phase at the top.

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
