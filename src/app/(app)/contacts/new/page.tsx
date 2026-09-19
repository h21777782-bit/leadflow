import type { Metadata } from "next";
import { connection } from "next/server";
import { createContactAction } from "@/app/actions/contacts";
import { ContactForm } from "@/components/contacts/contact-form";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { listAssignableUsers } from "@/server/queries";

export const metadata: Metadata = { title: "New contact" };

export default async function NewContactPage() {
  await connection();
  const owners = await listAssignableUsers();
  return (
    <>
      <PageHeader title="New contact" description="Email and phone are checked against existing contacts before anything is saved." />
      <div className="max-w-3xl px-8 py-6">
        <Panel>
          <ContactForm mode="create" action={createContactAction} owners={owners} cancelHref="/contacts" initial={{ leadSource: "website_form" }} />
        </Panel>
      </div>
    </>
  );
}
