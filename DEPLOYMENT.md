# Deployment Guide — Vercel + Supabase + Railway

> **Nothing has been deployed.** This is a step-by-step guide for *if and when* deployment is
> wanted — I will ask before actually creating any account, provisioning any resource, or
> spending any money. Read this fully before starting; it explains *why* the split across three
> providers is necessary, not just the click-by-click steps.

## Why three separate providers, not one

This app is genuinely two processes that must run continuously and independently, coordinating
only through the database:

1. **The web app** (Next.js) — request/response. It can scale to zero between requests and back
   up under load, which is exactly what a serverless platform like Vercel is built for.
2. **The worker** (`npm run worker`) — an infinite polling loop (`WORKER_POLL_MS`, default 2s)
   that claims due jobs from Postgres and runs their handlers (follow-ups, HighLevel sync,
   webhook processing, appointment reminders). **This cannot run on Vercel.** Every Vercel
   deployment is a serverless function invoked per request — it starts, handles that one
   request, and can be frozen or killed immediately after responding. There is no guarantee of a
   process staying alive between requests, so an infinite `while` loop placed there would either
   never run continuously or would be killed mid-loop with no warning. The worker needs an
   **always-on** process host instead.
3. **Postgres** — the one thing both processes share. It has to be reachable from both the
   serverless web app and the always-on worker, which is why it's a separate managed service
   rather than something bundled into either compute platform.

This is also why the job queue is Postgres-backed rather than in-memory or Redis-backed in the
first place — see `README.md`'s Architecture section and `IMPLEMENTATION_LOG.md`, Phase 4.

## The three services

| Service | Runs | Why this one |
|---|---|---|
| **Vercel** | The Next.js web app (`npm run build` / `next start`, or Vercel's own Next.js build) | First-class Next.js support (App Router, Server Actions, image optimization) and a generous free tier for a low-traffic demo |
| **Supabase** | Managed PostgreSQL | Already the DB this project targets locally (`npx supabase start` mirrors it exactly); free tier includes both a direct connection and a connection pooler |
| **Railway** (or Render/Fly — any host with an always-on process/worker service) | `npm run worker` as a background service | Simple deploy-from-git for a long-running Node process; free/hobby tier is enough for this project's traffic |

## Step by step

### 1. Supabase (database) — do this first

1. Create a Supabase project (supabase.com → New Project). Note the region — pick one close to
   wherever the web app and worker will run, to minimize latency on every query.
2. **Project Settings → Database** has two connection strings:
   - **Session pooler / direct connection (port 5432)** — supports prepared statements. Use this
     for the **worker**, which holds a small, long-lived pool and benefits from prepared
     statements for its frequently-repeated claim/complete queries.
   - **Transaction pooler (port 6543)** — does **not** support prepared statements (each
     transaction can be routed to a different backend connection). Use this for the **web app**,
     since serverless functions open many short-lived connections and the transaction pooler is
     built for exactly that pattern.
3. Whichever connection the transaction pooler is used for, set `DATABASE_PREPARE=false` in that
   environment's variables (already a supported flag — see `.env.example`). The worker's own
   environment can keep the default `DATABASE_PREPARE=true` if it uses the session pooler/direct
   connection instead.
4. Run migrations against the new database **once**, from a machine with the `DATABASE_URL`
   pointed at Supabase: `npm run db:migrate`. Do **not** run `npm run db:seed` against a
   real/shared database casually — it wipes app tables, and refuses to run at all when
   `NODE_ENV=production` unless `ALLOW_DEMO_SEED=true` is explicitly set, specifically to prevent
   an accidental production wipe.
5. Enable Supabase's connection pooler if it isn't already (it is, by default, on current
   Supabase projects) and note both connection strings for step 3/4 below.

### 2. Railway (worker) — do this second, so the queue has a consumer before the web app can enqueue into it

1. Connect the GitHub repo, create a new service, set the **start command** to `npm run worker`
   (not `npm run dev` or `npm start` — those start the web app).
2. Environment variables: `DATABASE_URL` (Supabase session pooler or direct connection, port
   5432, `DATABASE_PREPARE=true`), plus every other var from `.env.example` the worker's job
   handlers need (`MOCK_MODE`, `HIGHLEVEL_*` if going live, `WEBHOOK_SIGNING_SECRET` isn't needed
   here — that's only for the web app's inbound webhook routes).
3. `scripts/worker.ts` already handles `SIGTERM` gracefully (finishes the current batch, then
   exits) — Railway sends this on every redeploy/restart, so no special configuration is needed
   for graceful shutdowns.
4. Confirm the worker actually started by checking its logs for the heartbeat write (visible on
   `/automations` in the web app once step 3 is deployed) — a worker that fails to start silently
   means every follow-up, reminder, and sync job queues up and never runs.

### 3. Vercel (web app) — do this last

1. Import the repo into Vercel; it auto-detects Next.js.
2. Environment variables: `DATABASE_URL` (Supabase **transaction pooler**, port 6543,
   `DATABASE_PREPARE=false`), `ADMIN_PASSWORD` (set this — an internet-reachable deployment
   should not run open; see `README.md`'s Security notes), `WEBHOOK_SIGNING_SECRET` (generate
   with `openssl rand -hex 32` — needed for `/api/webhooks/*` to accept real signed requests),
   and every other var from `.env.example` relevant to the features being exercised
   (`HIGHLEVEL_*` if `MOCK_MODE=false`).
3. Deploy. `next build` needs neither a database connection nor secrets to *compile* (verified
   locally — `npm run build` passes with an empty `.env`), but the app will fail at request time
   without `DATABASE_URL`, and `getEnv()` will throw a clear, listed validation error rather than
   a cryptic one if anything required is missing.
4. Point HighLevel's webhook delivery URLs and/or the n8n workflow's HTTP Request node at the
   new `https://<vercel-domain>/api/webhooks/*` endpoints instead of `localhost`.

### 4. Verify the two-process split actually works

The exact test already run locally (see `IMPLEMENTATION_LOG.md`, Phase 4): create a lead through
the deployed web app, and confirm the deployed worker (not the web app) is the one that picks up
and completes its follow-up job — check the worker's own logs, or `/automations`' worker
heartbeat and job status, from the web app.

## Costs to check before starting (all free/hobby-tier as of the versions this was built against — verify current pricing before assuming any of this stays free)

- **Vercel**: free "Hobby" tier covers a low-traffic personal project; check current limits on
  function execution time and bandwidth before assuming headroom for a live demo.
- **Supabase**: free tier includes a small Postgres instance; check current storage/connection
  limits and whether the project pauses after inactivity (free-tier Supabase projects have
  historically auto-paused after a week with no traffic — confirm current behavior before relying
  on it being always reachable).
- **Railway**: has a limited free trial credit, not an indefinite free tier, on current pricing —
  confirm the actual current plan before assuming the worker can run continuously at no cost.

**I will check current pricing pages directly and confirm with you before provisioning anything**
— the above is what to look for, not a claim that any of it is currently free.

## What I will not do without asking first

- Create accounts on any of these three services.
- Provision any database, deployment, or compute resource.
- Set `MOCK_MODE=false` against real HighLevel credentials in a deployed environment.
- Point a real HighLevel account's webhook delivery URLs at a deployed instance.
