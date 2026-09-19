"use server";

/**
 * Server actions for contact forms. Thin wrappers: read FormData → call the
 * domain service → revalidate pages → return a serializable result for the UI.
 * All business rules live in src/server/services, not here.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getActingUser } from "@/server/services/actor";
import { createContact, mergeIntoContact, updateContact, type DuplicateMatch } from "@/server/services/contacts";
import type { FieldErrors } from "@/lib/validation/contact";

export type ContactFormState = {
  errors?: FieldErrors;
  duplicates?: DuplicateMatch[];
  message?: string;
  /** Echo of what the user typed, so the form keeps its values after an error. */
  values?: Record<string, string>;
};

const FIELDS = [
  "firstName", "lastName", "email", "phone", "company", "leadSource", "serviceInterest",
  "budgetAmount", "country", "timezone", "ownerId", "tags", "customFields", "notes",
] as const;

function readForm(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of FIELDS) out[f] = String(fd.get(f) ?? "");
  return out;
}

function revalidateCrm(contactId?: string) {
  for (const p of ["/contacts", "/pipeline", "/dashboard", "/activity"]) revalidatePath(p);
  if (contactId) revalidatePath(`/contacts/${contactId}`);
}

export async function createContactAction(_prev: ContactFormState, fd: FormData): Promise<ContactFormState> {
  const values = readForm(fd);
  const db = getDb();
  const actor = await getActingUser(db);
  const createOpportunity = fd.get("createOpportunity") === "on";
  const r = await createContact(db, actor, values, { createOpportunity });

  if (r.status === "invalid") return { errors: r.errors, values };
  if (r.status === "duplicate") {
    return {
      duplicates: r.matches,
      values,
      message: r.raceDetected
        ? "This person was just created by another request. Update the existing contact instead."
        : "A contact with this email or phone already exists.",
    };
  }
  revalidateCrm(r.contactId);
  redirect(`/contacts/${r.contactId}?created=1`);
}

export async function updateContactAction(contactId: string, _prev: ContactFormState, fd: FormData): Promise<ContactFormState> {
  const values = readForm(fd);
  const db = getDb();
  const r = await updateContact(db, await getActingUser(db), contactId, values);
  if (r.status === "invalid") return { errors: r.errors, values };
  if (r.status === "duplicate") return { duplicates: r.matches, values, message: "Another contact already uses this email or phone." };
  if (r.status === "not_found") return { message: "This contact no longer exists.", values };
  revalidateCrm(contactId);
  redirect(`/contacts/${contactId}?${r.status === "unchanged" ? "unchanged=1" : "updated=1"}`);
}

/** "Update the existing contact instead" — merge the submitted details into the duplicate. */
export async function mergeContactAction(existingId: string, values: Record<string, string>): Promise<ContactFormState> {
  const db = getDb();
  const r = await mergeIntoContact(db, await getActingUser(db), existingId, values);
  if (r.status === "invalid") return { errors: r.errors, values };
  if (r.status === "duplicate") return { duplicates: r.matches, values, message: "These details also match a different contact. Resolve that first." };
  if (r.status === "not_found") return { message: "That contact no longer exists.", values };
  revalidateCrm(existingId);
  redirect(`/contacts/${existingId}?${r.status === "unchanged" ? "unchanged=1" : "merged=1"}`);
}
