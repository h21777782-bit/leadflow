import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { updateContactAction } from "@/app/actions/contacts";
import { ContactForm } from "@/components/contacts/contact-form";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { isUuid } from "@/lib/ids";
import { fullName } from "@/lib/normalize";
import { getContactForEdit, listAssignableUsers } from "@/server/queries";

export const metadata: Metadata = { title: "Edit contact" };

export default async function EditContactPage({ params }: PageProps<"/contacts/[id]/edit">) {
  await connection();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const [c, owners] = await Promise.all([getContactForEdit(id), listAssignableUsers()]);
  if (!c) notFound();

  const initial: Record<string, string> = {
    firstName: c.firstName,
    lastName: c.lastName ?? "",
    email: c.email ?? "",
    phone: c.phone ?? "",
    company: c.company ?? "",
    leadSource: c.leadSource,
    serviceInterest: c.serviceInterest ?? "",
    budgetAmount: c.budgetAmount?.toString() ?? "",
    country: c.country ?? "",
    timezone: c.timezone ?? "",
    ownerId: c.ownerId ?? "",
    tags: c.tags.join(", "),
    customFields: Object.entries(c.customFields).map(([k, v]) => `${k}: ${String(v)}`).join("\n"),
    notes: c.notes ?? "",
  };

  return (
    <>
      <PageHeader title={`Edit ${fullName(c.firstName, c.lastName)}`} description="Every changed field is recorded in the activity log." />
      <div className="max-w-3xl px-8 py-6">
        <Panel>
          <ContactForm mode="edit" action={updateContactAction.bind(null, id)} initial={initial} owners={owners} cancelHref={`/contacts/${id}`} />
        </Panel>
      </div>
    </>
  );
}
