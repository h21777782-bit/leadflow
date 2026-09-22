import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { BookingForm } from "@/components/appointments/booking-form";
import { AppointmentRowActions } from "@/components/appointments/row-actions";
import { StatusBadge } from "@/components/ui/badges";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Table, Td, Th } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import { listAppointments, listContactOptions, listRepsForBooking } from "@/server/queries";

export const metadata: Metadata = { title: "Appointments" };

export default async function AppointmentsPage() {
  await connection();
  const [{ upcoming, past }, reps, contacts] = await Promise.all([listAppointments(), listRepsForBooking(), listContactOptions()]);

  const renderRows = (list: typeof upcoming, withActions: boolean) => (
    <Table>
      <thead>
        <tr>
          <Th>Lead</Th>
          <Th>Lead’s local time</Th>
          <Th>Sales rep’s local time</Th>
          <Th>Rep</Th>
          <Th>Status</Th>
          {withActions && <Th>Actions</Th>}
        </tr>
      </thead>
      <tbody>
        {list.map((a) => (
          <tr key={a.id}>
            <Td>
              <Link href={`/contacts/${a.contactId}`} className="font-medium text-accent hover:underline">{a.contactName}</Link>
              <div className="text-[13px] text-muted">{a.title}</div>
            </Td>
            <Td className="tabular whitespace-nowrap">
              {formatDateTime(a.startsAt, a.timezone)}
              <div className="text-[13px] text-muted">{a.timezone}</div>
            </Td>
            <Td className="tabular whitespace-nowrap">
              {a.ownerTimezone ? formatDateTime(a.startsAt, a.ownerTimezone) : "—"}
              <div className="text-[13px] text-muted">{a.ownerTimezone}</div>
            </Td>
            <Td>{a.ownerName ?? "Unassigned"}</Td>
            <Td><StatusBadge status={a.status} /></Td>
            {withActions && <Td><AppointmentRowActions appointmentId={a.id} contactId={a.contactId} status={a.status} startsAt={a.startsAt.toISOString()} endsAt={a.endsAt.toISOString()} /></Td>}
          </tr>
        ))}
      </tbody>
    </Table>
  );

  return (
    <>
      <PageHeader title="Appointments" description="Times are stored in UTC and shown in each person’s own timezone. Double-booking is impossible — the database itself refuses an overlapping slot for the same rep." />
      <div className="space-y-6 px-8 py-6">
        <Panel title="Book an appointment" description="Slots come from the rep's working hours (set in Settings), DST-safe, minus anything already on their calendar.">
          <BookingForm reps={reps} contacts={contacts} />
        </Panel>
        <Panel title={`Upcoming (${upcoming.length})`} flush>
          {upcoming.length ? renderRows(upcoming, true) : <EmptyState title="No upcoming appointments" />}
        </Panel>
        <Panel title={`Past (${past.length})`} flush>
          {past.length ? renderRows(past, false) : <EmptyState title="No past appointments" />}
        </Panel>
      </div>
    </>
  );
}
