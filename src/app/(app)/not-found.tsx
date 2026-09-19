import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl px-8 py-16">
      <h1 className="text-lg font-semibold">That record does not exist</h1>
      <p className="mt-2 text-muted">It may have been deleted, or the link is wrong.</p>
      <Link href="/contacts" className="mt-4 inline-block font-medium text-accent hover:underline">Go to contacts</Link>
    </div>
  );
}
