"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logoutAction } from "@/app/actions/admin-auth";
import {
  Activity,
  AlertTriangle,
  CalendarClock,
  Columns3,
  LayoutDashboard,
  PlugZap,
  Settings,
  Users,
  Webhook,
  Workflow,
  type LucideIcon,
} from "lucide-react";

type NavItem = { href: string; label: string; icon: LucideIcon };

const NAV: { heading: string; items: NavItem[] }[] = [
  {
    heading: "Sales",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/contacts", label: "Contacts", icon: Users },
      { href: "/pipeline", label: "Pipeline", icon: Columns3 },
      { href: "/appointments", label: "Appointments", icon: CalendarClock },
    ],
  },
  {
    heading: "Automation",
    items: [
      { href: "/automations", label: "Automations", icon: Workflow },
      { href: "/failed-automations", label: "Failed automations", icon: AlertTriangle },
      { href: "/activity", label: "Activity log", icon: Activity },
    ],
  },
  {
    heading: "System",
    items: [
      { href: "/integrations", label: "Integrations", icon: PlugZap },
      { href: "/webhooks", label: "Webhook events", icon: Webhook },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

export function Sidebar({ mode, failedCount, loginEnabled }: { mode: "mock" | "live"; failedCount: number; loginEnabled: boolean }) {
  const pathname = usePathname();

  return (
    <aside className="flex w-60 shrink-0 flex-col bg-nav text-nav-text">
      <div className="flex h-14 items-center gap-2 px-5">
        <span aria-hidden className="grid size-7 place-items-center rounded-md bg-accent text-[13px] font-semibold text-white">
          LF
        </span>
        <span className="text-[15px] font-semibold text-white">LeadFlow</span>
      </div>

      <nav className="flex-1 space-y-6 px-3 py-4" aria-label="Main">
        {NAV.map((group) => (
          <div key={group.heading}>
            <p className="px-2 pb-1.5 text-xs font-medium text-faint">{group.heading}</p>
            <ul className="space-y-0.5">
              {group.items.map(({ href, label, icon: Icon }) => {
                const active = pathname === href || pathname.startsWith(`${href}/`);
                return (
                  <li key={href}>
                    <Link
                      href={href}
                      aria-current={active ? "page" : undefined}
                      className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors ${
                        active ? "bg-white/10 text-white" : "hover:bg-white/5 hover:text-white"
                      }`}
                    >
                      <Icon className="size-4" aria-hidden />
                      <span className="flex-1">{label}</span>
                      {href === "/failed-automations" && failedCount > 0 && (
                        <span className="tabular rounded bg-bad px-1.5 text-xs font-medium text-white">
                          {failedCount}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-white/10 px-5 py-4 text-xs">
        {mode === "mock" ? (
          <p>
            <span className="font-medium text-white">Mock mode.</span> HighLevel calls go to the local mock provider.
          </p>
        ) : (
          <p>
            <span className="font-medium text-white">Live mode.</span> Connected to HighLevel.
          </p>
        )}
        {loginEnabled && (
          <form action={logoutAction} className="mt-3">
            <button type="submit" className="text-faint hover:text-white hover:underline">Log out</button>
          </form>
        )}
      </div>
    </aside>
  );
}
