import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { submitWebsiteLeadAction } from "@/app/actions/website-lead";
import { SERVICES, SERVICE_LABEL } from "@/lib/pipeline";

export const metadata: Metadata = { title: "Northwind Digital — Get a free quote" };

export default async function GetStartedPage({ searchParams }: PageProps<"/get-started">) {
  await connection();
  const sp = await searchParams;
  const submitted = sp.submitted === "1";
  const duplicate = sp.duplicate === "1";
  const error = typeof sp.error === "string" ? sp.error : null;
  const contactId = typeof sp.contactId === "string" && sp.contactId ? sp.contactId : null;

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <span className="text-[15px] font-semibold tracking-tight">Northwind Digital</span>
          <span className="text-xs text-faint">Web · SEO · Paid ads · Automation</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        {!submitted && !duplicate && (
          <div className="mb-8 max-w-xl">
            <h1 className="text-2xl font-semibold tracking-tight">Tell us about your project</h1>
            <p className="mt-2 text-muted">
              Fill this in and a strategist gets back to you within one business day — no obligation, no sales call
              you didn&apos;t ask for.
            </p>
          </div>
        )}

        {error && (
          <p role="alert" className="mb-6 rounded-md border border-bad/40 bg-bad-soft px-3 py-2 text-[13px] text-bad">
            Could not submit: {error}
          </p>
        )}

        {submitted ? (
          <div className="rounded-lg border border-ok/30 bg-ok-soft p-6">
            <h1 className="text-xl font-semibold text-ok">Thanks — we&apos;ve got it.</h1>
            <p className="mt-2 text-[15px]">A strategist will reach out within one business day.</p>
            {contactId && (
              <div className="mt-5 rounded-md border border-line bg-surface p-4 text-[13px]">
                <p className="font-medium text-muted">Behind the scenes (this is a demo — a real visitor never sees this):</p>
                <p className="mt-1 text-muted">
                  Your submission was received over a signed webhook, deduplicated, scored, and routed to a rep —
                  live, in the CRM.
                </p>
                <div className="mt-3 flex flex-wrap gap-3">
                  <Link href={`/contacts/${contactId}`} className="font-medium text-accent hover:underline">View this lead →</Link>
                  <Link href="/pipeline" className="font-medium text-accent hover:underline">See it on the pipeline →</Link>
                  <Link href="/webhooks" className="font-medium text-accent hover:underline">See the webhook event →</Link>
                </div>
              </div>
            )}
            <Link href="/get-started" className="mt-5 inline-block text-[13px] font-medium text-muted hover:text-ink">
              Submit another
            </Link>
          </div>
        ) : duplicate ? (
          <div className="rounded-lg border border-pending/30 bg-pending-soft p-6">
            <h1 className="text-xl font-semibold text-pending">We already have your details on file.</h1>
            <p className="mt-2 text-[15px]">No new request was created — someone will still reach out soon.</p>
            {contactId && (
              <Link href={`/contacts/${contactId}`} className="mt-4 inline-block font-medium text-accent hover:underline">
                View the existing lead →
              </Link>
            )}
          </div>
        ) : (
          <form action={submitWebsiteLeadAction} className="space-y-5 rounded-lg border border-line bg-surface p-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-[13px]">
                <span className="mb-1 block font-medium">First name</span>
                <input name="firstName" required className="w-full rounded-md border border-line-strong bg-surface px-3 py-2" />
              </label>
              <label className="block text-[13px]">
                <span className="mb-1 block font-medium">Last name</span>
                <input name="lastName" className="w-full rounded-md border border-line-strong bg-surface px-3 py-2" />
              </label>
              <label className="block text-[13px]">
                <span className="mb-1 block font-medium">Work email</span>
                <input type="email" name="email" required className="w-full rounded-md border border-line-strong bg-surface px-3 py-2" />
              </label>
              <label className="block text-[13px]">
                <span className="mb-1 block font-medium">Phone (optional)</span>
                <input type="tel" name="phone" className="w-full rounded-md border border-line-strong bg-surface px-3 py-2" />
              </label>
              <label className="block text-[13px]">
                <span className="mb-1 block font-medium">Company</span>
                <input name="company" className="w-full rounded-md border border-line-strong bg-surface px-3 py-2" />
              </label>
              <label className="block text-[13px]">
                <span className="mb-1 block font-medium">What do you need help with?</span>
                <select name="serviceInterest" className="w-full rounded-md border border-line-strong bg-surface px-3 py-2">
                  <option value="">Not sure yet</option>
                  {SERVICES.map((s) => <option key={s} value={s}>{SERVICE_LABEL[s]}</option>)}
                </select>
              </label>
              <label className="block text-[13px] sm:col-span-2">
                <span className="mb-1 block font-medium">Monthly budget (USD, optional)</span>
                <input name="budgetAmount" inputMode="numeric" placeholder="e.g. 3000" className="w-full rounded-md border border-line-strong bg-surface px-3 py-2" />
              </label>
              <label className="block text-[13px] sm:col-span-2">
                <span className="mb-1 block font-medium">A bit about your project</span>
                <textarea name="notes" rows={3} className="w-full rounded-md border border-line-strong bg-surface px-3 py-2" />
              </label>
            </div>
            <button type="submit" className="w-full rounded-md bg-accent px-4 py-2.5 font-medium text-white hover:bg-accent/90 sm:w-auto">
              Request a free consultation
            </button>
          </form>
        )}
      </main>

      <footer className="mx-auto max-w-3xl px-6 pb-10 text-xs text-faint">
        Northwind Digital is a fictional company — this form exists to demonstrate LeadFlow&apos;s inbound intake path
        (signed webhook → duplicate check → score → route), not a real business.
      </footer>
    </div>
  );
}
